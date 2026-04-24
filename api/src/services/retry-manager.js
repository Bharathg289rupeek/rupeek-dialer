import { query } from '../db/connection.js';
import { triggerOutboundCall } from './call-orchestrator.js';
import { isBusinessHours, getRoutingConfig, getNextBusinessDay } from '../utils/business-hours.js';
import { RETRY_CONFIG_DEFAULTS } from '../../../shared/constants.js';

/**
 * Map internal retry_type → routing_config columns.
 * Keep this in sync with migrations/002_retry_policies.sql.
 */
const RETRY_TYPE_TO_CONFIG = {
  cx_not_picked:        { maxCol: 'cx_not_picked_max_attempts',        intCol: 'cx_not_picked_interval_min',        def: RETRY_CONFIG_DEFAULTS.cx_not_picked },
  cx_drop_voicebot:     { maxCol: 'cx_drop_voicebot_max_attempts',     intCol: 'cx_drop_voicebot_interval_min',     def: RETRY_CONFIG_DEFAULTS.cx_drop_voicebot },
  callcenter_no_answer: { maxCol: 'callcenter_no_answer_max_attempts', intCol: 'callcenter_no_answer_interval_min', def: RETRY_CONFIG_DEFAULTS.callcenter_no_answer },
  call_failed:          { maxCol: 'call_failed_max_attempts',          intCol: 'call_failed_interval_min',          def: RETRY_CONFIG_DEFAULTS.call_failed },
};

/**
 * Look up max_attempts + interval_min for a retry type. Falls back to defaults.
 */
export async function getRetryPolicy(retryType) {
  const config = await getRoutingConfig();
  const map = RETRY_TYPE_TO_CONFIG[retryType];
  if (!map) {
    console.warn(`[RETRY] Unknown retry_type: ${retryType}, using cx_not_picked defaults`);
    return RETRY_CONFIG_DEFAULTS.cx_not_picked;
  }
  return {
    max_attempts:     config?.[map.maxCol] ?? map.def.max_attempts,
    interval_minutes: config?.[map.intCol] ?? map.def.interval_minutes,
  };
}

/**
 * Schedule a retry. Also flips the lead status to 'cx_notpicked_retrying'
 * so the dashboard shows it distinctly from a fresh lead.
 */
export async function scheduleRetry(leadId, retryType, attemptNumber, maxAttempts) {
  const config = await getRoutingConfig();
  const policy = await getRetryPolicy(retryType);
  const intervalMs = (policy.interval_minutes || 10) * 60 * 1000;

  let scheduledAt = new Date(Date.now() + intervalMs);

  // If scheduled time falls after business hours, push to next business day start
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

  // Reflect retry state on the lead so dashboard badges are accurate
  await query(
    `UPDATE leads SET status = 'cx_notpicked_retrying', updated_at = NOW() WHERE lead_id = $1`,
    [leadId]
  );

  return { scheduled_at: scheduledAt, attempt: attemptNumber, max: maxAttempts };
}

/**
 * Process pending retries. Runs every minute via pg-boss.
 * UTM logic removed — terminal failure = status='failed', no UTM lead created.
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

      // If this was the final attempt AND it failed, mark lead failed.
      // No UTM — UTM path has been removed entirely.
      if (!result.success && retry.attempt_number >= retry.max_attempts) {
        await query(`UPDATE retry_queue SET status = 'exhausted' WHERE id = $1`, [retry.id]);
        await query(
          `UPDATE leads SET status = 'failed', updated_at = NOW() WHERE lead_id = $1`,
          [retry.lead_id]
        );
      } else if (!result.success) {
        // Schedule another retry
        await scheduleRetry(retry.lead_id, retry.retry_type, retry.attempt_number + 1, retry.max_attempts);
        await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [retry.id]);
      } else {
        await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [retry.id]);
      }

      processed++;
    } catch (err) {
      console.error(`[RETRY] processing error for ${retry.lead_id}:`, err.message);
      await query(`UPDATE retry_queue SET status = 'pending' WHERE id = $1`, [retry.id]);
    }
  }

  return { processed };
}

/**
 * Process queued leads (after-hours leads at business-hours start).
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
      console.error(`[QUEUE] processing error for ${lead.lead_id}:`, err.message);
      await query(`UPDATE leads SET status = 'queued' WHERE lead_id = $1`, [lead.lead_id]);
    }
  }
  return { processed };
}
