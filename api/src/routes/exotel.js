import { query } from '../db/connection.js';
import { findRMsForLead } from '../services/routing-engine.js';
import { getRoutingConfig, formatPhone, isBusinessHours } from '../utils/business-hours.js';
import { logCall } from '../services/call-orchestrator.js';
import { scheduleRetry } from '../services/retry-manager.js';

export default async function exotelRoutes(fastify) {

  /**
   * Passthru endpoint — Exotel hits this AFTER customer picks up.
   * CX-first flow: Customer already on the line, we decide proceed or hangup.
   * Returns 200 = proceed to Connect (dial RMs), non-200 = hangup.
   */
  fastify.all('/api/v1/exotel/passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;
    const callSid = params.CallSid || params.callsid;

    if (!leadId) {
      return reply.status(400).send('Missing CustomField');
    }

    const config = await getRoutingConfig();

    if (!isBusinessHours(config)) {
      return reply.status(403).send('Outside business hours');
    }

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) {
      return reply.status(404).send('Lead not found');
    }

    const lead = leadRes.rows[0];
    if (lead.status === 'connected') {
      return reply.status(409).send('Already connected');
    }

    if (callSid) {
      await query(
        `UPDATE call_logs SET call_sid = $1 WHERE lead_id = $2 AND call_sid IS NULL ORDER BY created_at DESC LIMIT 1`,
        [callSid, leadId]
      );
    }

    return reply.status(200).send('OK');
  });

  /**
   * Connect Dynamic URL — Exotel hits this to get RM numbers.
   * CX-first flow: Customer is ALREADY on the line waiting.
   * We return RM numbers for parallel ringing. First RM to pick gets bridged to CX.
   */
  fastify.all('/api/v1/exotel/connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;

    if (!leadId) {
      return reply.status(400).send({ error: 'Missing CustomField' });
    }

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) {
      const config = await getRoutingConfig();
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
      };
    }

    const lead = leadRes.rows[0];
    const routing = await findRMsForLead(lead);
    const config = await getRoutingConfig();

    if (routing.agents.length === 0) {
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
        recording_channels: 'dual',
      };
    }

    const numbers = routing.agents.map(a => formatPhone(a.agent_phone));
    const ringDuration = config?.rm_ring_duration_sec || 20;
    const maxParallel = config?.max_parallel_rms || 3;

    return {
      destination: { numbers },
      parallel_ringing: {
        activate: numbers.length > 1,
        max_parallel_attempts: Math.min(numbers.length, maxParallel),
      },
      max_ringing_duration: ringDuration,
      record: true,
      recording_channels: 'dual',
      fetch_after_attempt: false,
    };
  });

  /**
   * Status Callback — Exotel POSTs final call status here.
   *
   * CX-FIRST disposition logic:
   *   - CX didn't pick (Status=no-answer)       → CUSTOMER_NOT_PICKED → retry CX in 10min (2 attempts)
   *   - CX dropped during voicebot (canceled)    → CX_DROP_VOICEBOT → retry CX in 10min (2 attempts)
   *   - CX picked, RM picked (completed)         → RM_CONNECTED → success!
   *   - CX picked, no RM picked (dial no-answer) → RM_NO_ANSWER → route to call center + retry in 10min (3 attempts)
   *   - Technical failure                        → CALL_FAILED → no retry
   */
  fastify.post('/api/v1/exotel/status-callback', async (request, reply) => {
    const data = request.body || {};
    const callSid = data.CallSid || data.callsid;
    const leadId = data.CustomField || data.customfield;
    const status = data.Status || data.status || '';
    const dialStatus = data.DialCallStatus || data.dialcallstatus || '';
    const dialWhom = data.DialWhomNumber || data.dialwhomnumber;
    const duration = parseInt(data.Duration || data.duration || 0);
    const recordingUrl = data.RecordingUrl || data.recordingurl;

    if (!leadId) {
      return reply.status(200).send('OK');
    }

    // Determine disposition for CX-FIRST flow
    let disposition = 'CALL_FAILED';
    const lowerStatus = status.toLowerCase();
    const lowerDial = dialStatus.toLowerCase();

    if (lowerStatus === 'no-answer') {
      // Customer didn't pick up the outbound call
      disposition = 'CUSTOMER_NOT_PICKED';
    } else if (lowerStatus === 'canceled') {
      // Customer picked but hung up during voicebot greeting
      disposition = 'CX_DROP_VOICEBOT';
    } else if (lowerStatus === 'busy') {
      // Customer line busy
      disposition = 'CUSTOMER_NOT_PICKED';
    } else if (lowerDial === 'completed' && duration > 5) {
      // CX was on line, RM picked, conversation happened
      disposition = 'RM_CONNECTED';
    } else if (lowerDial === 'no-answer' || lowerDial === 'busy') {
      // CX was on line, but no RM answered (all timed out)
      disposition = 'RM_NO_ANSWER';
    } else if (lowerStatus === 'completed' && (lowerDial === '' || lowerDial === 'completed')) {
      // Call completed — check duration to determine if RM was bridged
      disposition = duration > 10 ? 'RM_CONNECTED' : 'RM_NO_ANSWER';
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
      exotel_status: status,
      metadata: data,
    });

    // Get attempt count for this lead
    const attemptsRes = await query(
      `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1 AND call_type = 'outbound_cx' AND disposition NOT IN ('INITIATED')`,
      [leadId]
    );
    const attemptCount = parseInt(attemptsRes.rows[0]?.cnt || 1);

    // Handle outcomes
    if (disposition === 'RM_CONNECTED') {
      // SUCCESS — CX and RM are talking
      await query(
        `UPDATE leads SET status = 'connected', assigned_rm_phone = $2, connected_at = NOW(), updated_at = NOW()
         WHERE lead_id = $1`,
        [leadId, dialWhom]
      );

    } else if (disposition === 'CUSTOMER_NOT_PICKED' || disposition === 'CX_DROP_VOICEBOT') {
      // CX didn't pick or dropped during voicebot → retry CX (max 2 attempts)
      if (attemptCount < 2) {
        await scheduleRetry(leadId, 'cx_no_answer', attemptCount + 1, 2);
      } else {
        // Exhausted CX retries → create UTM lead
        const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
        if (leadRes.rows[0]) {
          const { createUtmLead } = await import('../services/utm-creator.js');
          await createUtmLead(leadRes.rows[0], 'cx_no_answer');
        }
      }

    } else if (disposition === 'RM_NO_ANSWER') {
      // CX was on line, no RM picked → retry (max 3 attempts)
      // Note: CX was already disconnected by Exotel after RM timeout, so next attempt re-dials CX too
      if (attemptCount < 3) {
        await scheduleRetry(leadId, 'rm_no_answer', attemptCount + 1, 3);
      } else {
        const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
        if (leadRes.rows[0]) {
          const { createUtmLead } = await import('../services/utm-creator.js');
          await createUtmLead(leadRes.rows[0], 'rm_no_answer');
        }
      }
    }

    return reply.status(200).send('OK');
  });

  /**
   * Inbound call passthru — when customer calls the ExoPhone.
   * Same flow: CX is already on line, we route to RMs.
   */
  fastify.all('/api/v1/exotel/inbound-passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const callerPhone = formatPhone(params.CallFrom || params.callfrom);
    const callSid = params.CallSid || params.callsid;

    if (!callerPhone) return reply.status(400).send('Missing caller');

    let leadRes = await query(
      `SELECT * FROM leads WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [callerPhone]
    );

    let leadId;
    if (leadRes.rows.length > 0) {
      leadId = leadRes.rows[0].lead_id;
    } else {
      leadId = 'INB-' + Date.now();
      await query(
        `INSERT INTO leads (lead_id, customer_phone, lead_source, status)
         VALUES ($1, $2, 'inbound', 'in_progress')`,
        [leadId, callerPhone]
      );
    }

    await logCall(leadId, {
      call_sid: callSid,
      call_type: 'inbound',
      direction: 'inbound',
      from_number: callerPhone,
      disposition: 'INBOUND_INITIATED',
    });

    return reply.status(200).send('OK');
  });

  /**
   * Inbound connect — return RMs for inbound caller.
   */
  fastify.all('/api/v1/exotel/inbound-connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const callerPhone = formatPhone(params.CallFrom || params.callfrom);
    const config = await getRoutingConfig();

    const leadRes = await query(
      `SELECT * FROM leads WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [callerPhone]
    );

    if (leadRes.rows.length === 0) {
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
      };
    }

    const lead = leadRes.rows[0];
    lead.lead_source = 'inbound';
    const routing = await findRMsForLead(lead);

    if (routing.agents.length === 0) {
      await query(
        `UPDATE leads SET utm_identifier = 'already_spoke_to_cx', updated_at = NOW() WHERE lead_id = $1`,
        [lead.lead_id]
      );
      return {
        destination: { numbers: [config?.fallback_call_center_number || process.env.FALLBACK_CALL_CENTER_NUMBER] },
        parallel_ringing: { activate: false },
        max_ringing_duration: 30,
        record: true,
      };
    }

    const numbers = routing.agents.map(a => formatPhone(a.agent_phone));
    return {
      destination: { numbers },
      parallel_ringing: { activate: numbers.length > 1, max_parallel_attempts: Math.min(numbers.length, 3) },
      max_ringing_duration: config?.rm_ring_duration_sec || 20,
      record: true,
      recording_channels: 'dual',
      fetch_after_attempt: false,
    };
  });
}
