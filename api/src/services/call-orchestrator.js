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
 * Trigger outbound call for a lead (CX-first flow).
 *
 * Flow:
 *   1. Exotel dials CUSTOMER first (To = customer phone)
 *   2. Customer picks up -> Voicebot greets: "Hi, regarding your gold loan enquiry..."
 *   3. Passthru applet -> our API checks lead validity + business hours
 *   4. Connect applet -> our API returns RM numbers with parallel_ringing
 *   5. All RMs dialed simultaneously -> first to pick gets bridged to customer
 *   6. No RM picks -> fallback to call center
 *
 * Retries:
 *   - Customer doesn't pick -> retry 2 times (10 min apart), then UTM
 *   - Customer picks but no RM answers -> retry 3 times (10 min apart), then UTM
 */
export async function triggerOutboundCall(lead, attemptNumber = 1) {
  const routing = await findRMsForLead(lead);
  const config = await getRoutingConfig();

  if (routing.agents.length === 0) {
    await logCall(lead.lead_id, {
      call_type: 'outbound_cx',
      disposition: 'RM_NO_ANSWER_CALLCENTER',
      attempt_number: attemptNumber,
      rm_phones_dialed: [],
      to_number: formatPhone(lead.customer_phone),
      metadata: { reason: 'no_agents_mapped', matched_level: null },
    });
    return { success: false, reason: 'no_agents_mapped', fallback: 'call_center' };
  }

  const rmPhones = routing.agents.map(a => formatPhone(a.agent_phone));

  await query(
    `UPDATE leads SET status = 'in_progress', updated_at = NOW() WHERE lead_id = $1`,
    [lead.lead_id]
  );

  // Log call initiation - store RM phones so /exotel/connect can serve them
  await query(
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

  // CX-first: Exotel dials customer -> voicebot greeting -> passthru -> connect dials RMs
  try {
    const sid = EXOTEL_SID();
    const url = `${EXOTEL_BASE()}/Accounts/${sid}/Calls/connect`;
    const apiBase = process.env.API_BASE_URL || 'http://localhost:3000';

    const body = new URLSearchParams({
      From: EXOPHONE(),
      To: formatPhone(lead.customer_phone),   // CX-first: customer dialed first
      CallerId: EXOPHONE(),
      Url: process.env.EXOTEL_APP_URL,        // Flow: Voicebot -> Passthru -> Connect (RM dial)
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
        call_type: 'outbound_cx',
        disposition: 'CALL_FAILED',
        attempt_number: attemptNumber,
        rm_phones_dialed: rmPhones,
        to_number: formatPhone(lead.customer_phone),
        metadata: { error: data, http_status: response.status },
      });
      return { success: false, reason: 'exotel_api_error', error: data };
    }
  } catch (err) {
    await logCall(lead.lead_id, {
      call_type: 'outbound_cx',
      disposition: 'CALL_FAILED',
      attempt_number: attemptNumber,
      rm_phones_dialed: rmPhones,
      to_number: formatPhone(lead.customer_phone),
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
