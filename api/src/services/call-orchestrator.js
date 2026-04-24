import { query } from '../db/connection.js';
import { findRMsForLead } from './routing-engine.js';
import { getRoutingConfig, formatPhone } from '../utils/business-hours.js';

const EXOTEL_BASE = () => process.env.EXOTEL_API_BASE || 'https://api.exotel.com/v1';
const EXOTEL_SID = () => process.env.EXOTEL_ACCOUNT_SID;
const EXOPHONE = () => process.env.EXOPHONE;

function exotelAuth() {
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  return 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64');
}

/**
 * Trigger outbound call for a lead (CX-first flow).
 *
 * Flow:
 *   1. Exotel dials CUSTOMER first
 *   2. Voicebot greets the customer
 *   3. Passthru applet hits our API  -> we validate
 *   4. Connect applet hits our API   -> we return RM numbers
 *   5. RMs dialled in parallel
 *   6. No RM picks up -> Exotel's applet-level fallback (EXOTEL_FALLBACK_CALL_CENTER)
 *
 * Retry policies are now configurable per disposition in routing_config.
 * UTM creation has been removed — exhausted retries → status='failed'.
 *
 * Updated disposition ownership: this file NEVER inserts terminal dispositions
 * beyond its own control. It inserts exactly one INITIATED row at the start,
 * then either (a) hands control to the callback/resolver pipeline on success,
 * or (b) UPDATEs the same INITIATED row to CALL_FAILED / INVALID_NUMBER on
 * failure. No duplicate rows.
 */
export async function triggerOutboundCall(lead, attemptNumber = 1) {
  const routing = await findRMsForLead(lead);

  // No agents mapped — forward to our own call-centre number directly.
  // Mark lead as call_center_handled and log a single terminal row.
  // Skips Exotel entirely.
  if (routing.agents.length === 0) {
    await logCall(lead.lead_id, {
      call_type: 'outbound_cx',
      disposition: 'RM_NO_ANSWER_CALLCENTER',
      attempt_number: attemptNumber,
      rm_phones_dialed: [],
      to_number: formatPhone(lead.customer_phone),
      metadata: { reason: 'no_agents_mapped', matched_level: null },
    });
    await query(
      `UPDATE leads
         SET status = 'call_center_handled',
             utm_identifier = 'no_agents_mapped',
             connected_at = NOW(),
             updated_at = NOW()
       WHERE lead_id = $1`,
      [lead.lead_id]
    );
    return { success: false, reason: 'no_agents_mapped', fallback: 'call_center' };
  }

  const rmPhones = routing.agents.map(a => formatPhone(a.agent_phone));

  await query(
    `UPDATE leads SET status = 'in_progress', updated_at = NOW() WHERE lead_id = $1`,
    [lead.lead_id]
  );

  // INITIATED row — will be UPDATEd (not duplicated) by the callback pipeline
  // or by our own error handler below.
  const insertRes = await query(
    `INSERT INTO call_logs (lead_id, call_type, direction, from_number, to_number, exophone, attempt_number, rm_phones_dialed, disposition, metadata)
     VALUES ($1, 'outbound_cx', 'outbound', $2, $3, $2, $4, $5, 'INITIATED', $6)
     RETURNING id`,
    [
      lead.lead_id,
      EXOPHONE(),
      formatPhone(lead.customer_phone),
      attemptNumber,
      JSON.stringify(rmPhones),
      JSON.stringify({
        matched_level: routing.matched_level,
        agent_names: routing.agents.map(a => a.agent_name),
      }),
    ]
  );
  const initiatedRowId = insertRes.rows[0]?.id;

  // CX-first dial via Exotel
  try {
    const sid = EXOTEL_SID();
    const url = `${EXOTEL_BASE()}/Accounts/${sid}/Calls/connect.json`;
    const apiBase = process.env.API_BASE_URL || 'http://localhost:3000';

    const body = new URLSearchParams({
      From: formatPhone(lead.customer_phone),
      To: EXOPHONE(),
      CallerId: EXOPHONE(),
      Url: process.env.EXOTEL_APP_URL,
      CustomField: lead.lead_id,
      StatusCallback: `${apiBase}/api/v1/exotel/status-callback?CustomField=${lead.lead_id}`,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': exotelAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await response.json();

    if (response.ok) {
      const callSid = data?.Call?.Sid || data?.call?.sid || null;
      if (callSid && initiatedRowId) {
        await query(
          `UPDATE call_logs SET call_sid = $1 WHERE id = $2`,
          [callSid, initiatedRowId]
        );
      }
      return { success: true, call_sid: callSid, agents: routing.agents };
    }

    // Exotel API returned non-2xx. Detect invalid-number patterns before falling
    // back to CALL_FAILED so the caller can skip retries for bad numbers.
    const responseText = JSON.stringify(data || {}).toLowerCase();
    const isInvalidNumber = /invalid.?number|not.?a.?valid|malformed|invalid.?phone|not.?reachable/.test(responseText);
    const terminalDisposition = isInvalidNumber ? 'INVALID_NUMBER' : 'CALL_FAILED';

    // UPDATE the existing INITIATED row — no duplicate insert
    if (initiatedRowId) {
      await query(
        `UPDATE call_logs
           SET disposition = $1,
               exotel_status = $2,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
         WHERE id = $4`,
        [
          terminalDisposition,
          'api_error',
          JSON.stringify({ error: data, http_status: response.status }),
          initiatedRowId,
        ]
      );
    }

    // For INVALID_NUMBER terminal-fail the lead immediately, no retry
    if (isInvalidNumber) {
      await query(
        `UPDATE leads SET status = 'failed', utm_identifier = 'invalid_number', updated_at = NOW() WHERE lead_id = $1`,
        [lead.lead_id]
      );
    }

    return { success: false, reason: terminalDisposition.toLowerCase(), error: data };

  } catch (err) {
    // Network error — update the INITIATED row to CALL_FAILED
    if (initiatedRowId) {
      await query(
        `UPDATE call_logs
           SET disposition = 'CALL_FAILED',
               exotel_status = 'network_error',
               metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify({ error: err.message }),
          initiatedRowId,
        ]
      );
    }
    return { success: false, reason: 'network_error', error: err.message };
  }
}

export async function logCall(leadId, data) {
  await query(
    `INSERT INTO call_logs (lead_id, call_sid, call_type, direction, from_number, to_number, exophone, attempt_number, rm_phones_dialed, disposition, rm_who_answered, call_duration_sec, recording_url, exotel_status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      leadId,
      data.call_sid || null,
      data.call_type || 'outbound_cx',
      data.direction || 'outbound',
      data.from_number || null,
      data.to_number || null,
      data.exophone || process.env.EXOPHONE,
      data.attempt_number || 1,
      data.rm_phones_dialed ? JSON.stringify(data.rm_phones_dialed) : null,
      data.disposition || null,
      data.rm_who_answered || null,
      data.call_duration_sec || null,
      data.recording_url || null,
      data.exotel_status || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );
}
