import { query } from '../db/connection.js';
import { findRMsForLead } from '../services/routing-engine.js';
import { getRoutingConfig, formatPhone, isBusinessHours } from '../utils/business-hours.js';
import { logCall } from '../services/call-orchestrator.js';
import { scheduleRetry } from '../services/retry-manager.js';
import { triggerWhatsAppNotification } from '../services/whatsapp-notify.js';

// Fetch call details from Exotel API to get real status
async function fetchExotelCallDetails(callSid) {
  const sid = process.env.EXOTEL_ACCOUNT_SID;
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  const base = process.env.EXOTEL_API_BASE || 'https://api.exotel.com/v1';

  const url = `${base}/Accounts/${sid}/Calls/${callSid}.json`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64') },
    });
    if (res.ok) {
      const data = await res.json();
      return data?.Call || data?.call || data;
    }
    return null;
  } catch (err) {
    console.error('[EXOTEL-FETCH] Error fetching call details:', err.message);
    return null;
  }
}

export default async function exotelRoutes(fastify) {

  // Passthru — CX picks up, check lead validity
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
        `UPDATE call_logs SET call_sid = $1 WHERE id = (SELECT id FROM call_logs WHERE lead_id = $2 AND call_sid IS NULL ORDER BY created_at DESC LIMIT 1)`,
        [callSid, leadId]
      );
      // Schedule status poll after 45 seconds (call should be done by then)
      setTimeout(() => pollCallStatus(callSid, leadId), 45000);
      // Also poll after 90 seconds as backup
      setTimeout(() => pollCallStatus(callSid, leadId), 90000);
    }

    return reply.status(200).send('OK');
  });

  // Connect — return RM numbers for parallel dialing
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
      console.log('[CONNECT] No agents, fallback to call center');
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
      fetch_after_attempt: false,
    };
  });

  // Status Callback — Exotel calls this after call ends
  // Handles both form-urlencoded and JSON, plus empty body fallback
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

    // Try to get status from callback data first
    let status = data.Status || data.status || '';
    let dialStatus = data.DialCallStatus || data.dialcallstatus || '';
    let dialWhom = data.DialWhomNumber || data.dialwhomnumber || '';
    let duration = parseInt(data.Duration || data.duration || data.DialCallDuration || 0);
    let recordingUrl = data.RecordingUrl || data.recordingurl || '';

    // If callback body is empty, fetch from Exotel API
    if (!status && callSid) {
      console.log('[STATUS-CALLBACK] Empty status, fetching from Exotel API for CallSid:', callSid);
      const callDetails = await fetchExotelCallDetails(callSid);
      if (callDetails) {
        status = callDetails.Status || callDetails.status || '';
        duration = parseInt(callDetails.Duration || callDetails.duration || 0);
        recordingUrl = callDetails.RecordingUrl || callDetails.recording_url || '';
        dialWhom = callDetails.DialWhomNumber || '';
        console.log('[STATUS-CALLBACK] Fetched from API:', { status, duration, dialWhom });
      }
    }

    // If still no status or call still in progress — skip, let poll handle it
    const lowerStatusCheck = status.toLowerCase();
    if (!status || lowerStatusCheck === 'in-progress' || lowerStatusCheck === 'ringing' || lowerStatusCheck === 'queued') {
      console.log(`[STATUS-CALLBACK] Call still ${status || 'unknown'}, skipping — poll will handle`);
      return reply.status(200).send('OK');
    }

    // Determine disposition
    let disposition = 'CALL_FAILED';
    const lowerStatus = status.toLowerCase();
    const lowerDial = dialStatus.toLowerCase();

    if (lowerStatus === 'no-answer') {
      disposition = 'CUSTOMER_NOT_PICKED';
    } else if (lowerStatus === 'busy') {
      disposition = 'CUSTOMER_NOT_PICKED';
    } else if (lowerStatus === 'canceled') {
      disposition = 'CX_DROP_VOICEBOT';
    } else if (lowerStatus === 'completed' && duration > 5) {
      disposition = 'RM_CONNECTED';
    } else if (lowerStatus === 'completed' && duration <= 5) {
      disposition = 'RM_NO_ANSWER';
    } else if (lowerDial === 'completed' && duration > 5) {
      disposition = 'RM_CONNECTED';
    } else if (lowerDial === 'no-answer' || lowerDial === 'busy') {
      disposition = 'RM_NO_ANSWER';
    }

    console.log(`[STATUS-CALLBACK] Lead: ${leadId}, Status: ${status}, Disposition: ${disposition}, Duration: ${duration}`);

    await processDisposition(leadId, callSid, disposition, dialWhom, duration, recordingUrl, status, data);

    return reply.status(200).send('OK');
  });

  /**
   * Poll call status from Exotel API — called 45s and 90s after call starts.
   * This is the backup mechanism when StatusCallback body is empty.
   */
  async function pollCallStatus(callSid, leadId) {
    try {
      // Check if already processed
      const existing = await query(
        `SELECT disposition FROM call_logs WHERE lead_id = $1 AND disposition NOT IN ('INITIATED', 'CALL_FAILED') LIMIT 1`,
        [leadId]
      );
      if (existing.rows.length > 0) {
        console.log(`[POLL] ${leadId} already has disposition: ${existing.rows[0].disposition}, skipping`);
        return;
      }

      console.log(`[POLL] Fetching call details for ${callSid} (lead: ${leadId})`);
      const callDetails = await fetchExotelCallDetails(callSid);
      if (!callDetails) {
        console.log(`[POLL] No details found for ${callSid}`);
        return;
      }

      const status = (callDetails.Status || callDetails.status || '').toLowerCase();
      const duration = parseInt(callDetails.Duration || callDetails.duration || 0);
      const recordingUrl = callDetails.RecordingUrl || callDetails.recording_url || '';

      // Only process if call is finished
      if (status === 'in-progress' || status === 'ringing' || status === 'queued') {
        console.log(`[POLL] Call ${callSid} still ${status}, will check again later`);
        return;
      }

      let disposition = 'CALL_FAILED';
      if (status === 'completed' && duration > 5) {
        disposition = 'RM_CONNECTED';
      } else if (status === 'completed' && duration <= 5) {
        disposition = 'RM_NO_ANSWER';
      } else if (status === 'no-answer') {
        disposition = 'CUSTOMER_NOT_PICKED';
      } else if (status === 'busy') {
        disposition = 'CUSTOMER_NOT_PICKED';
      } else if (status === 'canceled') {
        disposition = 'CX_DROP_VOICEBOT';
      }

      console.log(`[POLL] Lead: ${leadId}, Status: ${status}, Disposition: ${disposition}, Duration: ${duration}`);

      // Find DialWhomNumber from call legs if available
      let dialWhom = '';
      if (callDetails.Legs || callDetails.legs) {
        const legs = callDetails.Legs || callDetails.legs;
        if (Array.isArray(legs) && legs.length > 0) {
          const answeredLeg = legs.find(l => (l.Status || l.status || '').toLowerCase() === 'completed');
          if (answeredLeg) {
            dialWhom = answeredLeg.To || answeredLeg.to || '';
          }
        }
      }

      await processDisposition(leadId, callSid, disposition, dialWhom, duration, recordingUrl, status, { source: 'poll' });

    } catch (err) {
      console.error(`[POLL] Error polling ${callSid}:`, err.message);
    }
  }

  /**
   * Shared disposition processing — used by both StatusCallback and polling.
   */
  async function processDisposition(leadId, callSid, disposition, dialWhom, duration, recordingUrl, exotelStatus, rawData) {
    // Dedup: skip if already processed with a real disposition
    const existing = await query(
      `SELECT disposition FROM call_logs WHERE lead_id = $1 AND disposition NOT IN ('INITIATED', 'CALL_FAILED') LIMIT 1`,
      [leadId]
    );
    if (existing.rows.length > 0) {
      console.log(`[PROCESS] ${leadId} already has ${existing.rows[0].disposition}, skipping duplicate`);
      return;
    }

    // Log call
    await logCall(leadId, {
      call_sid: callSid,
      call_type: 'outbound_cx',
      direction: 'outbound',
      to_number: dialWhom,
      disposition,
      rm_who_answered: disposition === 'RM_CONNECTED' ? dialWhom : null,
      call_duration_sec: duration,
      recording_url: recordingUrl,
      exotel_status: exotelStatus,
      metadata: rawData,
    });

    // Update INITIATED entry
    await query(
      `UPDATE call_logs SET disposition = $1, call_sid = $2, exotel_status = $3, call_duration_sec = $4, rm_who_answered = $5, recording_url = $6
       WHERE id = (SELECT id FROM call_logs WHERE lead_id = $7 AND disposition = 'INITIATED' ORDER BY created_at DESC LIMIT 1)`,
      [disposition, callSid, exotelStatus, duration, disposition === 'RM_CONNECTED' ? dialWhom : null, recordingUrl, leadId]
    );

    // Get lead data
    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    const lead = leadRes.rows[0];

    // Get attempt count
    const attemptsRes = await query(
      `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1 AND call_type = 'outbound_cx' AND disposition NOT IN ('INITIATED')`,
      [leadId]
    );
    const attemptCount = parseInt(attemptsRes.rows[0]?.cnt || 1);

    if (disposition === 'RM_CONNECTED') {
      await query(
        `UPDATE leads SET status = 'connected', assigned_rm_phone = $2, connected_at = NOW(), updated_at = NOW() WHERE lead_id = $1`,
        [leadId, dialWhom]
      );
      if (lead) await triggerWhatsAppNotification(lead, disposition, { call_sid: callSid, rm_who_answered: dialWhom, call_duration_sec: duration, attempt_number: attemptCount });

    } else if (disposition === 'CUSTOMER_NOT_PICKED' || disposition === 'CX_DROP_VOICEBOT') {
      if (attemptCount < 2) {
        await scheduleRetry(leadId, 'cx_no_answer', attemptCount + 1, 2);
      } else if (lead) {
        const { createUtmLead } = await import('../services/utm-creator.js');
        await createUtmLead(lead, 'cx_no_answer');
        await triggerWhatsAppNotification(lead, 'UTM_LEAD_CREATED', { attempt_number: attemptCount });
      }
      if (lead) await triggerWhatsAppNotification(lead, disposition, { attempt_number: attemptCount });

    } else if (disposition === 'RM_NO_ANSWER') {
      if (attemptCount < 3) {
        await scheduleRetry(leadId, 'rm_no_answer', attemptCount + 1, 3);
      } else if (lead) {
        const { createUtmLead } = await import('../services/utm-creator.js');
        await createUtmLead(lead, 'rm_no_answer');
        await triggerWhatsAppNotification(lead, 'UTM_LEAD_CREATED', { attempt_number: attemptCount });
      }
      if (lead) await triggerWhatsAppNotification(lead, disposition, { call_sid: callSid, attempt_number: attemptCount });

    } else if (disposition === 'CALL_FAILED') {
      await query(`UPDATE leads SET status = 'failed', updated_at = NOW() WHERE lead_id = $1`, [leadId]);
      if (lead) await triggerWhatsAppNotification(lead, disposition, { attempt_number: attemptCount });
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

    await logCall(leadId, { call_sid: callSid, call_type: 'inbound', direction: 'inbound', from_number: callerPhone, disposition: 'INBOUND_INITIATED' });
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
      record: true, recording_channels: 'dual', fetch_after_attempt: false,
    };
  });
}
