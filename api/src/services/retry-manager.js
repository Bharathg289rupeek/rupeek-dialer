import { query } from '../db/connection.js';
import { triggerOutboundCall } from './call-orchestrator.js';
import { createUtmLead } from './utm-creator.js';
import { isBusinessHours, getRoutingConfig, getNextBusinessDay } from '../utils/business-hours.js';

/**
 * Schedule a retry for a lead.
 */
export async function scheduleRetry(leadId, retryType, attemptNumber, maxAttempts) {
  const config = await getRoutingConfig();
  let scheduledAt = new Date(Date.now() + 10 * 60 * 1000); // +10 min

  // If scheduled time falls outside business hours, push to next business day
  // We check by simulating — if it's after 17:50, next retry at 9am
  const tz = process.env.TIMEZONE || 'Asia/Kolkata';
  const schedIST = new Date(scheduledAt.toLocaleString('en-US', { timeZone: tz }));
  const endParts = (config?.business_hours_end || '18:00').toString().split(':');
  const endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1] || 0);
  const schedMin = schedIST.getHours() * 60 + schedIST.getMinutes();

  if (schedMin >= endMin) {
    scheduledAt = getNextBusinessDay(config);
  }

  await query(
    `INSERT INTO retry_queue (lead_id, retry_type, attempt_number, max_attempts, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [leadId, retryType, attemptNumber, maxAttempts, scheduledAt]
  );

  return { scheduled_at: scheduledAt, attempt: attemptNumber, max: maxAttempts };
}

/**
 * Process pending retries — called by worker every 60s.
 */
export async function processPendingRetries() {
  const config = await getRoutingConfig();
  if (!isBusinessHours(config)) return { processed: 0 };

  const res = await query(
    `UPDATE retry_queue SET status = 'processing'
     WHERE id IN (
       SELECT id FROM retry_queue
       WHERE status = 'pending' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 20
     )
     RETURNING *`
  );

  let processed = 0;
  for (const retry of res.rows) {
    try {
      const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [retry.lead_id]);
      const lead = leadRes.rows[0];
      if (!lead) {
        await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [retry.id]);
        continue;
      }

      const result = await triggerOutboundCall(lead, retry.attempt_number);

      if (!result.success && retry.attempt_number >= retry.max_attempts) {
        // All retries exhausted → create UTM lead
        await createUtmLead(lead, retry.retry_type);
        await query(`UPDATE retry_queue SET status = 'exhausted' WHERE id = $1`, [retry.id]);
        await query(
          `UPDATE leads SET status = 'utm_created', utm_created = true, updated_at = NOW() WHERE lead_id = $1`,
          [retry.lead_id]
        );
      } else if (!result.success) {
        // Schedule next retry
        await scheduleRetry(retry.lead_id, retry.retry_type, retry.attempt_number + 1, retry.max_attempts);
        await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [retry.id]);
      } else {
        await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [retry.id]);
      }

      processed++;
    } catch (err) {
      console.error(`Retry processing error for ${retry.lead_id}:`, err.message);
      await query(`UPDATE retry_queue SET status = 'pending' WHERE id = $1`, [retry.id]);
    }
  }

  return { processed };
}

/**
 * Process queued leads (after-hours leads at 9am).
 */
export async function processQueuedLeads() {
  const config = await getRoutingConfig();
  if (!isBusinessHours(config)) return { processed: 0 };

  const res = await query(
    `UPDATE leads SET status = 'in_progress', updated_at = NOW()
     WHERE status = 'queued' AND queued_for <= NOW()
     RETURNING *`
  );

  let processed = 0;
  for (const lead of res.rows) {
    try {
      await triggerOutboundCall(lead, 1);
      processed++;
    } catch (err) {
      console.error(`Queue processing error for ${lead.lead_id}:`, err.message);
      await query(`UPDATE leads SET status = 'queued' WHERE lead_id = $1`, [lead.lead_id]);
    }
  }
  return { processed };
}
