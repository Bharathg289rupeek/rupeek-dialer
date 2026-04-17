import { query } from '../db/connection.js';
import { findRMsForLead } from '../services/routing-engine.js';
import { getRoutingConfig, formatPhone, isBusinessHours } from '../utils/business-hours.js';
import { logCall } from '../services/call-orchestrator.js';
import { scheduleRetry } from '../services/retry-manager.js';

export default async function exotelRoutes(fastify) {

  /**
   * Passthru endpoint — Exotel hits this to decide: proceed or hangup.
   * Returns 200 = proceed to Connect applet, non-200 = hangup.
   */
  fastify.all('/api/v1/exotel/passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;
    const callSid = params.CallSid || params.callsid;

    if (!leadId) {
      return reply.status(400).send('Missing CustomField');
    }

    const config = await getRoutingConfig();

    // Check business hours
    if (!isBusinessHours(config)) {
      return reply.status(403).send('Outside business hours');
    }

    // Check lead exists
    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) {
      return reply.status(404).send('Lead not found');
    }

    const lead = leadRes.rows[0];
    if (lead.status === 'connected') {
      return reply.status(409).send('Already connected');
    }

    // Update call_sid on the lead's latest call log
    if (callSid) {
      await query(
        `UPDATE call_logs SET call_sid = $1 WHERE lead_id = $2 AND call_sid IS NULL ORDER BY created_at DESC LIMIT 1`,
        [callSid, leadId]
      );
    }

    return reply.status(200).send('OK');
  });

  /**
   * Connect Dynamic URL — Exotel hits this to get RM numbers for dialing.
   * Returns JSON with destination numbers and parallel_ringing config.
   */
  fastify.all('/api/v1/exotel/connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;

    if (!leadId) {
      return reply.status(400).send({ error: 'Missing CustomField' });
    }

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) {
      // No lead → return call center number
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
      // No RMs → fallback to call center
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
   * We log the disposition and trigger retries if needed.
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
      return reply.status(200).send('OK'); // Don't fail Exotel callbacks
    }

    // Determine disposition
    let disposition = 'CALL_FAILED';
    const lowerStatus = status.toLowerCase();
    const lowerDial = dialStatus.toLowerCase();

    if (lowerDial === 'completed' || lowerStatus === 'completed') {
      // Someone answered
      if (dialWhom) {
        // RM answered — check if customer was also connected (duration > threshold)
        disposition = duration > 5 ? 'RM_CONNECTED' : 'RM_CONNECTED_CX_NO_ANSWER';
      } else {
        disposition = 'RM_CONNECTED';
      }
    } else if (lowerDial === 'no-answer' || lowerDial === 'busy') {
      disposition = 'RM_NO_ANSWER';
    } else if (lowerStatus === 'no-answer') {
      disposition = 'CUSTOMER_NOT_PICKED';
    } else if (lowerStatus === 'busy') {
      disposition = 'CALL_FAILED';
    } else if (lowerStatus === 'canceled') {
      disposition = 'CX_DROP_VOICEBOT';
    }

    // Log call
    await logCall(leadId, {
      call_sid: callSid,
      call_type: 'outbound_rm',
      direction: 'outbound',
      to_number: dialWhom,
      disposition,
      rm_who_answered: disposition.startsWith('RM_CONNECTED') ? dialWhom : null,
      call_duration_sec: duration,
      recording_url: recordingUrl,
      exotel_status: status,
      metadata: data,
    });

    // Get attempt count
    const attemptsRes = await query(
      `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1 AND call_type = 'outbound_rm' AND disposition != 'INITIATED'`,
      [leadId]
    );
    const attemptCount = parseInt(attemptsRes.rows[0]?.cnt || 1);

    // Handle disposition outcomes
    if (disposition === 'RM_CONNECTED') {
      // Success!
      await query(
        `UPDATE leads SET status = 'connected', assigned_rm_phone = $2, connected_at = NOW(), updated_at = NOW()
         WHERE lead_id = $1`,
        [leadId, dialWhom]
      );
    } else if (disposition === 'RM_CONNECTED_CX_NO_ANSWER') {
      // RM picked but customer didn't → retry (max 2)
      if (attemptCount < 2) {
        await scheduleRetry(leadId, 'cx_no_answer', attemptCount + 1, 2);
      } else {
        // Exhausted cx retries
        const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
        if (leadRes.rows[0]) {
          const { createUtmLead } = await import('../services/utm-creator.js');
          await createUtmLead(leadRes.rows[0], 'cx_no_answer');
        }
      }
    } else if (disposition === 'RM_NO_ANSWER') {
      // No RM answered → retry (max 3)
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
   */
  fastify.all('/api/v1/exotel/inbound-passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const callerPhone = formatPhone(params.CallFrom || params.callfrom);
    const callSid = params.CallSid || params.callsid;

    if (!callerPhone) return reply.status(400).send('Missing caller');

    // Look up existing lead by phone
    let leadRes = await query(
      `SELECT * FROM leads WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [callerPhone]
    );

    let leadId;
    if (leadRes.rows.length > 0) {
      leadId = leadRes.rows[0].lead_id;
    } else {
      // Create new inbound lead
      leadId = 'INB-' + Date.now();
      await query(
        `INSERT INTO leads (lead_id, customer_phone, lead_source, status)
         VALUES ($1, $2, 'inbound', 'in_progress')`,
        [leadId, callerPhone]
      );
    }

    // Log inbound call
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

    // Find lead by phone
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
    lead.lead_source = 'inbound'; // Force inbound routing rules
    const routing = await findRMsForLead(lead);

    if (routing.agents.length === 0) {
      // Fallback to call center with identifier
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
