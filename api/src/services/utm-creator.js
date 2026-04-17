import { query } from '../db/connection.js';
import { logCall } from './call-orchestrator.js';

export async function createUtmLead(lead, retryType) {
  const identifier = retryType === 'cx_no_answer' ? 'cx_unreachable' : 'rm_unreachable';

  // Count attempts
  const attemptsRes = await query(
    `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1`,
    [lead.lead_id]
  );

  const payload = {
    lead_id: lead.lead_id,
    customer_name: lead.customer_name,
    customer_phone: lead.customer_phone,
    city: lead.city,
    loan_type: lead.loan_type,
    loan_amount: lead.loan_amount,
    source: 'exotel_fallback',
    utm_source: 'rupeek_auto_dialer',
    utm_medium: 'call_fallback',
    utm_campaign: retryType === 'cx_no_answer' ? 'cx_unreachable' : 'rm_unreachable',
    identifier,
    attempts_made: parseInt(attemptsRes.rows[0]?.cnt || 0),
    last_attempt_at: new Date().toISOString(),
  };

  // Try to POST to UTM endpoint
  const endpoint = process.env.UTM_LEAD_ENDPOINT;
  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.UTM_API_KEY || ''}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.text();
      console.log(`UTM lead created for ${lead.lead_id}: ${res.status}`);
    } catch (err) {
      console.error(`UTM lead creation failed for ${lead.lead_id}:`, err.message);
    }
  }

  // Update lead in our DB
  await query(
    `UPDATE leads SET status = 'utm_created', utm_created = true, utm_identifier = $2, updated_at = NOW()
     WHERE lead_id = $1`,
    [lead.lead_id, identifier]
  );

  await logCall(lead.lead_id, {
    call_type: 'outbound_rm',
    disposition: 'UTM_LEAD_CREATED',
    metadata: payload,
  });

  return payload;
}
