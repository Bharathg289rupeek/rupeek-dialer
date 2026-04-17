import { query } from '../db/connection.js';
import { findRMsForLead } from './routing-engine.js';
import { getRoutingConfig } from '../utils/business-hours.js';
import { formatPhone } from '../utils/business-hours.js';

const EXOTEL_BASE = () => process.env.EXOTEL_API_BASE || 'https://api.exotel.com/v1';
const EXOTEL_SID = () => process.env.EXOTEL_ACCOUNT_SID;
const EXOPHONE = () => process.env.EXOPHONE;

function exotelAuth() {
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  return 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64');
}

/**
 * Trigger outbound call for a lead (agent-first flow).
 * Exotel dials RMs first via parallel ringing using the flow.
 */
export async function triggerOutboundCall(lead, attemptNumber = 1) {
  const routing = await findRMsForLead(lead);
  const config = await getRoutingConfig();

  if (routing.agents.length === 0) {
    // No agents found → immediate call center fallback
    await logCall(lead.lead_id, {
      call_type: 'outbound_rm',
      disposition: 'RM_NO_ANSWER_CALLCENTER',
      attempt_number: attemptNumber,
      rm_phones_dialed: [],
      metadata: { reason: 'no_agents_mapped', matched_level: null },
    });
    return { success: false, reason: 'no_agents_mapped', fallback: 'call_center' };
  }

  const rmPhones = routing.agents.map(a => formatPhone(a.agent_phone));

  // Store RM numbers for Connect dynamic URL endpoint to serve
  await query(
    `UPDATE leads SET status = 'in_progress', updated_at = NOW() WHERE lead_id = $1`,
    [lead.lead_id]
  );

  // Store pending call data so /exotel/connect can serve RM numbers
  await query(
    `INSERT INTO call_logs (lead_id, call_type, direction, from_number, exophone, attempt_number, rm_phones_dialed, disposition, metadata)
     VALUES ($1, 'outbound_rm', 'outbound', $2, $2, $3, $4, 'INITIATED', $5)
     RETURNING id`,
    [
      lead.lead_id,
      EXOPHONE(),
      attemptNumber,
      JSON.stringify(rmPhones),
      JSON.stringify({
        matched_level: routing.matched_level,
        agent_names: routing.agents.map(a => a.agent_name),
      }),
    ]
  );

  // Call Exotel Click-to-Call API
  // The flow is configured so: RM hears greeting → Passthru checks lead → Connect fetches RM numbers → parallel ring
  try {
    const sid = EXOTEL_SID();
    const url = `${EXOTEL_BASE()}/Accounts/${sid}/Calls/connect`;
    const apiBase = process.env.API_BASE_URL || 'http://localhost:3000';

    const body = new URLSearchParams({
      From: EXOPHONE(),
      To: formatPhone(lead.customer_phone),
      CallerId: EXOPHONE(),
      Url: process.env.EXOTEL_APP_URL,
      CustomField: lead.lead_id,
      StatusCallback: `${apiBase}/api/v1/exotel/status-callback`,
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
      // Update call log with CallSid
      const callSid = data?.Call?.Sid || data?.call?.sid || null;
      if (callSid) {
        await query(
          `UPDATE call_logs SET call_sid = $1 WHERE lead_id = $2 AND disposition = 'INITIATED' ORDER BY created_at DESC LIMIT 1`,
          [callSid, lead.lead_id]
        );
      }
      return { success: true, call_sid: callSid, agents: routing.agents };
    } else {
      await logCall(lead.lead_id, {
        call_type: 'outbound_rm',
        disposition: 'CALL_FAILED',
        attempt_number: attemptNumber,
        rm_phones_dialed: rmPhones,
        metadata: { error: data, http_status: response.status },
      });
      return { success: false, reason: 'exotel_api_error', error: data };
    }
  } catch (err) {
    await logCall(lead.lead_id, {
      call_type: 'outbound_rm',
      disposition: 'CALL_FAILED',
      attempt_number: attemptNumber,
      rm_phones_dialed: rmPhones,
      metadata: { error: err.message },
    });
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
      data.call_type || 'outbound_rm',
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
