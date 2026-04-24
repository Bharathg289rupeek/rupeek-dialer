import { query } from '../db/connection.js';
import { findRMsForLead } from '../services/routing-engine.js';
import { getRoutingConfig, formatPhone, isBusinessHours } from '../utils/business-hours.js';
import { logCall } from '../services/call-orchestrator.js';
import { scheduleRetry, getRetryPolicy } from '../services/retry-manager.js';
import { triggerWhatsAppNotification } from '../services/whatsapp-notify.js';
import { WA_TAGS } from '../../../shared/constants.js';

// ─── Exotel helpers (module-scope, used by resolver too via re-export) ──────

async function fetchExotelCallDetails(callSid) {
  const sid = process.env.EXOTEL_ACCOUNT_SID;
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  const base = process.env.EXOTEL_API_BASE || 'https://api.exotel.com/v1';
  // details=true adds ConversationDuration, Leg1Status, Leg2Status — useful
  // for distinguishing "RM answered" from "customer hung up during voicebot".
  const url = `${base}/Accounts/${sid}/Calls/${callSid}.json?details=true`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64') },
    });
    if (res.ok) {
      const data = await res.json();
      return data?.Call || data?.call || data;
    }
    console.warn(`[EXOTEL-FETCH] HTTP ${res.status} for ${callSid}`);
    return null;
  } catch (err) {
    console.error('[EXOTEL-FETCH] Error:', err.message);
    return null;
  }
}

/**
 * Extract RM phone + synthetic dial status from an Exotel Call Details response.
 *
 * Exotel's behaviour on this account (confirmed by live inspection):
 *   - For a connect-applet outbound call, Exotel rewrites the master `To`
 *     field to the number that actually answered after the call completes.
 *   - So when Status=completed, `Call.To` is the RM who picked up.
 *   - `Details.Leg2Status` tells us whether the RM leg succeeded.
 *   - `Details.ConversationDuration` is actual talk time (in seconds).
 *
 * Returns { dialWhom, dialStatus, conversationDuration } — callers use these
 * instead of the raw callback fields when the callback body is bare.
 */
export function extractRmFromCallDetails(callDetails) {
  if (!callDetails) return { dialWhom: '', dialStatus: '', conversationDuration: 0 };

  // Primary source: the rewritten `To` field on a completed outbound call.
  // If From == To, we're looking at an edge case (self-dial?); skip it.
  let dialWhom = '';
  const to = callDetails.To || callDetails.to || '';
  const from = callDetails.From || callDetails.from || '';
  const direction = (callDetails.Direction || callDetails.direction || '').toLowerCase();
  const status = (callDetails.Status || callDetails.status || '').toLowerCase();

  if (status === 'completed' && to && to !== from && direction.startsWith('outbound')) {
    dialWhom = to;
  }

  // Fallback to documented fields in case Exotel changes behaviour
  if (!dialWhom) dialWhom = callDetails.DialWhomNumber || callDetails.dialwhomnumber || '';

  // Leg2Status on a connect-applet call reflects the RM-leg outcome.
  // Leg1 is the customer leg. If Leg2 is completed, an RM answered.
  const details = callDetails.Details || callDetails.details || {};
  const leg2Status = details.Leg2Status || details.leg2Status || '';
  const conversationDuration = parseInt(details.ConversationDuration || details.conversationDuration || 0);

  // Synthesize a DialCallStatus from Leg2Status so the classifier can treat
  // this the same as a direct status-callback that did have DialCallStatus.
  let dialStatus = '';
  if (leg2Status) dialStatus = leg2Status.toLowerCase();

  return { dialWhom, dialStatus, conversationDuration };
}

function isExotelCallCenter(normalizedPhone) {
  if (!normalizedPhone) return false;
  const cc = formatPhone(process.env.EXOTEL_FALLBACK_CALL_CENTER || '');
  return cc && normalizedPhone === cc;
}

// Best-effort INVALID_NUMBER detector.
// Today's observed signature on this Exotel account (Test-25):
//   multipart body with no usable fields, Status missing, Duration 0,
//   no DialCallStatus, no DialWhomNumber.
// We also pattern-match any textual "invalid number" message in case Exotel
// ever sends one.
function looksLikeInvalidNumber({ status, dialStatus, dialWhom, duration, rawMessage }) {
  const s = (status || '').toLowerCase();
  const d = (dialStatus || '').toLowerCase();
  // Explicit "failed" from Exotel with zero duration and no dial info
  if (s === 'failed' && !d && !dialWhom && duration === 0) return true;
  // Message substring match
  const msg = (rawMessage || '').toLowerCase();
  if (/invalid.?number|not.?reachable|malformed|not.?a.?valid/i.test(msg)) return true;
  return false;
}

/**
 * Classify a terminal call outcome based on Exotel signals.
 * Exported so services/call-resolver.js can reuse identical logic.
 */
export function classifyDisposition({ status, dialStatus, dialWhom, duration, rawMessage }) {
  const s = (status || '').toLowerCase();
  const d = (dialStatus || '').toLowerCase();
  const normalizedDialWhom = dialWhom || '';
  const routedToCallCenter = isExotelCallCenter(normalizedDialWhom);
  const hasRmAnswered = !!normalizedDialWhom && !routedToCallCenter;

  // 1. INVALID_NUMBER — takes priority
  if (looksLikeInvalidNumber({ status, dialStatus, dialWhom, duration, rawMessage })) {
    return 'INVALID_NUMBER';
  }

  // 2. Call-centre routing cases
  if (routedToCallCenter) {
    if (d === 'completed') return 'RM_NO_ANSWER_CALLCENTER';
    return 'CALLCENTER_NO_ANSWER';
  }

  // 3. RM actually connected
  if (d === 'completed' && hasRmAnswered) return 'RM_CONNECTED';

  // 4. Master status completed → either RM (rare) or customer dropped voicebot
  if (s === 'completed') return hasRmAnswered ? 'RM_CONNECTED' : 'CX_DROP_VOICEBOT';

  // 5. RM leg negatives without call-centre being dialled
  if (d === 'no-answer' || d === 'busy' || d === 'canceled') return 'CALLCENTER_NO_ANSWER';

  // 6. Customer-side negatives
  if (s === 'no-answer' || s === 'busy') return 'CUSTOMER_NOT_PICKED';
  if (s === 'canceled') return 'CX_DROP_VOICEBOT';

  // 7. Anything else
  return 'CALL_FAILED';
}

/**
 * Apply lead status + WhatsApp side-effects for a classified disposition.
 * Terminal-only WhatsApp. Exported for reuse by the resolver.
 */
export async function applyLeadAndWhatsApp({ leadId, lead, disposition, callSid, duration, rmPhone, rmName, rmEmail, attemptCount }) {

  // RM_CONNECTED
  if (disposition === 'RM_CONNECTED') {
    await query(
      `UPDATE leads
         SET status = 'connected', assigned_rm_phone = $2, assigned_rm_name = $3,
             connected_at = NOW(), updated_at = NOW()
       WHERE lead_id = $1`,
      [leadId, rmPhone, rmName]
    );
    if (lead) await triggerWhatsAppNotification(lead, 'RM_CONNECTED', {
      call_sid: callSid,
      rm_who_answered: rmPhone,
      call_duration_sec: duration,
      attempt_number: attemptCount,
      assigned_to: rmEmail,
      tag: WA_TAGS.ALREADY_CALLED,
    });
    return;
  }

  // RM_NO_ANSWER_CALLCENTER — call centre picked up, no WhatsApp, DB record only
  if (disposition === 'RM_NO_ANSWER_CALLCENTER') {
    await query(
      `UPDATE leads
         SET status = 'call_center_handled',
             utm_identifier = 'routed_to_callcenter',
             connected_at = NOW(),
             updated_at = NOW()
       WHERE lead_id = $1`,
      [leadId]
    );
    return;
  }

  // INVALID_NUMBER — terminal fail, no retry, no WhatsApp
  if (disposition === 'INVALID_NUMBER') {
    await query(
      `UPDATE leads SET status = 'failed', utm_identifier = 'invalid_number', updated_at = NOW() WHERE lead_id = $1`,
      [leadId]
    );
    return;
  }

  // Retry-eligible dispositions
  const retryTypeMap = {
    CUSTOMER_NOT_PICKED:  'cx_not_picked',
    CX_DROP_VOICEBOT:     'cx_drop_voicebot',
    CALLCENTER_NO_ANSWER: 'callcenter_no_answer',
    CALL_FAILED:          'call_failed',
  };
  const retryType = retryTypeMap[disposition];
  if (!retryType) {
    console.warn(`[PROCESS] Unhandled disposition: ${disposition}`);
    return;
  }

  const policy = await getRetryPolicy(retryType);

  if (attemptCount < policy.max_attempts) {
    // Schedule another retry. No WhatsApp — terminal-only policy.
    await scheduleRetry(leadId, retryType, attemptCount + 1, policy.max_attempts);
    return;
  }

  // Retry exhausted → terminal failure + single WhatsApp
  await query(
    `UPDATE leads SET status = 'failed', utm_identifier = $2, updated_at = NOW() WHERE lead_id = $1`,
    [leadId, retryType]
  );

  if (lead) {
    await triggerWhatsAppNotification(lead, disposition, {
      call_sid: callSid,
      call_duration_sec: duration,
      attempt_number: attemptCount,
      assigned_to: null,
      tag: WA_TAGS.NOT_CALLED,
      disposition_override: 'CUSTOMER_NOT_PICKED',
    });
  }
}

/**
 * Shared disposition-processing pipeline. Used by both the HTTP status-callback
 * handler and the in-process poll. Exported so services/call-resolver.js can
 * reuse the same pipeline (pg-boss cron job).
 */
export async function processDisposition(leadId, callSid, disposition, normalizedDialWhom, duration, recordingUrl, exotelStatus, rawData) {
  // Dedup — skip if already resolved
  const existing = await query(
    `SELECT disposition FROM call_logs WHERE lead_id = $1 AND disposition NOT IN ('INITIATED') LIMIT 1`,
    [leadId]
  );
  if (existing.rows.length > 0) {
    console.log(`[PROCESS] ${leadId} already has ${existing.rows[0].disposition}, skipping`);
    return;
  }

  // RM lookup — now fetches email too (for assigned_to in WhatsApp payload)
  const rmPhoneForStorage = disposition === 'RM_CONNECTED' ? normalizedDialWhom : null;
  let rmName = null, rmEmail = null;
  if (rmPhoneForStorage) {
    const r = await query(
      `SELECT agent_name, agent_email FROM agents WHERE agent_phone = $1 AND is_active = true LIMIT 1`,
      [rmPhoneForStorage]
    );
    rmName = r.rows[0]?.agent_name || null;
    rmEmail = r.rows[0]?.agent_email || null;
  }

  const toNumberForStorage = normalizedDialWhom || null;

  // Single UPDATE on the INITIATED row
  const updateRes = await query(
    `UPDATE call_logs
       SET disposition = $1,
           call_sid = COALESCE(call_sid, $2),
           exotel_status = $3,
           call_duration_sec = $4,
           rm_who_answered = $5,
           recording_url = $6,
           to_number = COALESCE(to_number, $7),
           metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
     WHERE id = (SELECT id FROM call_logs
                 WHERE lead_id = $9 AND disposition = 'INITIATED'
                 ORDER BY created_at DESC LIMIT 1)
     RETURNING id`,
    [
      disposition, callSid, exotelStatus, duration,
      rmPhoneForStorage, recordingUrl, toNumberForStorage,
      JSON.stringify({
        source: rawData?.source || 'callback',
        routed_to_callcenter: disposition === 'RM_NO_ANSWER_CALLCENTER',
        callcenter_no_answer: disposition === 'CALLCENTER_NO_ANSWER',
        invalid_number: disposition === 'INVALID_NUMBER',
        raw: rawData,
      }),
      leadId,
    ]
  );

  // Defensive fallback — insert fresh if no INITIATED row existed
  if (updateRes.rowCount === 0) {
    console.warn(`[PROCESS] No INITIATED row for ${leadId}, inserting fresh`);
    await logCall(leadId, {
      call_sid: callSid,
      call_type: 'outbound_cx',
      direction: 'outbound',
      to_number: toNumberForStorage,
      disposition,
      rm_who_answered: rmPhoneForStorage,
      call_duration_sec: duration,
      recording_url: recordingUrl,
      exotel_status: exotelStatus,
      metadata: { source: rawData?.source || 'callback_no_init', raw: rawData },
    });
  }

  // Fetch lead + attempt count, then apply status + WhatsApp side-effects
  const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
  const lead = leadRes.rows[0];
  const attemptsRes = await query(
    `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1 AND call_type = 'outbound_cx' AND disposition NOT IN ('INITIATED')`,
    [leadId]
  );
  const attemptCount = parseInt(attemptsRes.rows[0]?.cnt || 1);

  await applyLeadAndWhatsApp({
    leadId, lead, disposition, callSid, duration,
    rmPhone: rmPhoneForStorage, rmName, rmEmail, attemptCount,
  });
}

// ─── Route registration ─────────────────────────────────────────────────────

export default async function exotelRoutes(fastify) {

  // Passthru — customer picked up
  fastify.all('/api/v1/exotel/passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;
    const callSid = params.CallSid || params.callsid;

    console.log('[PASSTHRU] hit:', { leadId, callSid });

    if (!leadId) return reply.status(400).send('Missing CustomField');

    const config = await getRoutingConfig();
    if (!isBusinessHours(config)) return reply.status(403).send('Outside business hours');

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) return reply.status(404).send('Lead not found');
    if (leadRes.rows[0].status === 'connected') return reply.status(409).send('Already connected');

    if (callSid) {
      await query(
        `UPDATE call_logs SET call_sid = $1
           WHERE id = (SELECT id FROM call_logs WHERE lead_id = $2 AND call_sid IS NULL ORDER BY created_at DESC LIMIT 1)`,
        [callSid, leadId]
      );
      // Fast-path polls. Durable backup lives in services/call-resolver.js.
      setTimeout(() => pollCallStatus(callSid, leadId), 45000);
      setTimeout(() => pollCallStatus(callSid, leadId), 90000);
    }

    return reply.status(200).send('OK');
  });

  // Connect — return RM numbers for parallel ringing
  fastify.all('/api/v1/exotel/connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;

    console.log('[CONNECT] hit:', { leadId });

    if (!leadId) return reply.status(400).send({ error: 'Missing CustomField' });

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    const config = await getRoutingConfig();

    if (leadRes.rows.length === 0) {
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
      };
    }

    const lead = leadRes.rows[0];
    const routing = await findRMsForLead(lead);

    if (routing.agents.length === 0) {
      console.log('[CONNECT] No agents matched, returning call-centre fallback');
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
        recording_channels: 'dual',
      };
    }

    const numbers = routing.agents.map(a => formatPhone(a.agent_phone));
    console.log('[CONNECT] Returning RMs:', numbers);

    return {
      destination: { numbers },
      parallel_ringing: {
        activate: numbers.length > 1,
        max_parallel_attempts: Math.min(numbers.length, config?.max_parallel_rms || 3),
      },
      max_ringing_duration: config?.rm_ring_duration_sec || 20,
      record: true,
      recording_channels: 'dual',
      fetch_after_attempt: true,
    };
  });

  // Status Callback — Exotel POSTs here after call ends
  fastify.all('/api/v1/exotel/status-callback', async (request, reply) => {
    const data = { ...request.query, ...request.body };
    console.log('[STATUS-CALLBACK] raw query:', JSON.stringify(request.query));
    console.log('[STATUS-CALLBACK] raw body:', JSON.stringify(request.body));
    console.log('[STATUS-CALLBACK] content-type:', request.headers?.['content-type']);

    const callSid = data.CallSid || data.callsid || data.Sid || '';
    const leadId = data.CustomField || data.customfield || '';

    if (!leadId) {
      console.log('[STATUS-CALLBACK] No CustomField, ignoring');
      return reply.status(200).send('OK');
    }

    let status = data.Status || data.status || '';
    let dialStatus = data.DialCallStatus || data.dialcallstatus || '';
    let dialWhom = data.DialWhomNumber || data.dialwhomnumber || '';
    let duration = parseInt(data.Duration || data.duration || data.DialCallDuration || 0);
    let recordingUrl = data.RecordingUrl || data.recordingurl || '';
    const rawMessage = data.Message || data.message || data.ErrorMessage || '';

    // Fetch from Exotel API if:
    //   (a) status is missing entirely, OR
    //   (b) status=completed but neither DialCallStatus nor DialWhomNumber is
    //       present — Exotel's master callback on this account often sends
    //       only {CallSid, Status, DateUpdated}, hiding the RM attribution.
    const bodyIsBare = status && !dialStatus && !dialWhom;
    if ((!status || bodyIsBare) && callSid) {
      console.log(`[STATUS-CALLBACK] ${!status ? 'Empty status' : 'Bare body'}, fetching from Exotel API for ${callSid}`);
      const callDetails = await fetchExotelCallDetails(callSid);
      if (callDetails) {
        status = callDetails.Status || callDetails.status || status;
        duration = parseInt(callDetails.Duration || callDetails.duration || duration);
        recordingUrl = callDetails.RecordingUrl || callDetails.recording_url || recordingUrl;
        const extracted = extractRmFromCallDetails(callDetails);
        if (!dialWhom)   dialWhom = extracted.dialWhom;
        if (!dialStatus) dialStatus = extracted.dialStatus;
        console.log('[STATUS-CALLBACK] Fetched from API:', { status, duration, dialStatus, dialWhom, convDur: extracted.conversationDuration });
      }
    }

    const lowerStatusCheck = status.toLowerCase();
    if (!status || lowerStatusCheck === 'in-progress' || lowerStatusCheck === 'ringing' || lowerStatusCheck === 'queued') {
      console.log(`[STATUS-CALLBACK] Still ${status || 'unknown'} — letting resolver handle`);
      return reply.status(200).send('OK');
    }

    const normalizedDialWhom = dialWhom ? formatPhone(dialWhom) : '';
    const disposition = classifyDisposition({
      status, dialStatus, dialWhom: normalizedDialWhom, duration, rawMessage,
    });

    console.log(`[STATUS-CALLBACK] Lead=${leadId} Status=${status} DialStatus=${dialStatus} DialWhom=${normalizedDialWhom || '-'} Dur=${duration} → ${disposition}`);

    await processDisposition(leadId, callSid, disposition, normalizedDialWhom, duration, recordingUrl, status, { source: 'status-callback', raw: data });

    return reply.status(200).send('OK');
  });

  // Fast-path in-process poll
  async function pollCallStatus(callSid, leadId) {
    try {
      const existing = await query(
        `SELECT disposition FROM call_logs WHERE lead_id = $1 AND disposition NOT IN ('INITIATED') LIMIT 1`,
        [leadId]
      );
      if (existing.rows.length > 0) {
        console.log(`[POLL] ${leadId} already has ${existing.rows[0].disposition}, skipping`);
        return;
      }

      const callDetails = await fetchExotelCallDetails(callSid);
      if (!callDetails) return;

      const status = (callDetails.Status || callDetails.status || '').toLowerCase();
      const duration = parseInt(callDetails.Duration || callDetails.duration || 0);
      const recordingUrl = callDetails.RecordingUrl || callDetails.recording_url || '';

      if (status === 'in-progress' || status === 'ringing' || status === 'queued') {
        console.log(`[POLL] ${callSid} still ${status}`);
        return;
      }

      const { dialWhom, dialStatus, conversationDuration } = extractRmFromCallDetails(callDetails);
      const normalizedDialWhom = dialWhom ? formatPhone(dialWhom) : '';
      const disposition = classifyDisposition({
        status, dialStatus, dialWhom: normalizedDialWhom, duration, rawMessage: '',
      });

      console.log(`[POLL] Lead=${leadId} Status=${status} DialStatus=${dialStatus || '-'} DialWhom=${normalizedDialWhom || '-'} Dur=${duration}/${conversationDuration}s → ${disposition}`);
      await processDisposition(leadId, callSid, disposition, normalizedDialWhom, duration, recordingUrl, status, { source: 'poll' });

    } catch (err) {
      console.error(`[POLL] Error polling ${callSid}:`, err.message);
    }
  }

  // Inbound passthru
  fastify.all('/api/v1/exotel/inbound-passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const callerPhone = formatPhone(params.CallFrom || params.callfrom);
    const callSid = params.CallSid || params.callsid;

    if (!callerPhone) return reply.status(400).send('Missing caller');

    let leadRes = await query(`SELECT * FROM leads WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`, [callerPhone]);
    let leadId;
    if (leadRes.rows.length > 0) {
      leadId = leadRes.rows[0].lead_id;
    } else {
      leadId = 'INB-' + Date.now();
      await query(`INSERT INTO leads (lead_id, customer_phone, lead_source, status) VALUES ($1, $2, 'inbound', 'in_progress')`, [leadId, callerPhone]);
    }

    await logCall(leadId, {
      call_sid: callSid, call_type: 'inbound', direction: 'inbound',
      from_number: callerPhone, disposition: 'INBOUND_INITIATED',
    });
    return reply.status(200).send('OK');
  });

  // Inbound connect
  fastify.all('/api/v1/exotel/inbound-connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const callerPhone = formatPhone(params.CallFrom || params.callfrom);
    const config = await getRoutingConfig();

    const leadRes = await query(`SELECT * FROM leads WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`, [callerPhone]);

    if (leadRes.rows.length === 0) {
      return { destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] }, parallel_ringing: { activate: false }, max_ringing_duration: 30, record: true };
    }

    const lead = leadRes.rows[0];
    lead.lead_source = 'inbound';
    const routing = await findRMsForLead(lead);

    if (routing.agents.length === 0) {
      await query(`UPDATE leads SET utm_identifier = 'already_spoke_to_cx', updated_at = NOW() WHERE lead_id = $1`, [lead.lead_id]);
      return { destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] }, parallel_ringing: { activate: false }, max_ringing_duration: 30, record: true };
    }

    const numbers = routing.agents.map(a => formatPhone(a.agent_phone));
    return {
      destination: { numbers },
      parallel_ringing: { activate: numbers.length > 1, max_parallel_attempts: Math.min(numbers.length, 3) },
      max_ringing_duration: config?.rm_ring_duration_sec || 20,
      record: true, recording_channels: 'dual', fetch_after_attempt: true,
    };
  });
}
