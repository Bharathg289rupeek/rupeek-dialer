import { query } from '../db/connection.js';
import { findRMsForLead } from '../services/routing-engine.js';
import { getRoutingConfig, formatPhone, isBusinessHours } from '../utils/business-hours.js';
import { logCall } from '../services/call-orchestrator.js';
import { scheduleRetry } from '../services/retry-manager.js';
import { triggerWhatsAppNotification } from '../services/whatsapp-notify.js';

export default async function exotelRoutes(fastify) {

  /**
   * Passthru — Exotel hits this after CX picks up.
   */
  fastify.all('/api/v1/exotel/passthru', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;
    const callSid = params.CallSid || params.callsid;

    console.log('[PASSTHRU] hit:', { leadId, callSid, params: Object.keys(params) });

    if (!leadId) return reply.status(400).send('Missing CustomField');

    const config = await getRoutingConfig();
    if (!isBusinessHours(config)) return reply.status(403).send('Outside business hours');

    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    if (leadRes.rows.length === 0) return reply.status(404).send('Lead not found');

    const lead = leadRes.rows[0];
    if (lead.status === 'connected') return reply.status(409).send('Already connected');

    if (callSid) {
      await query(
        `UPDATE call_logs SET call_sid = $1 WHERE id = (SELECT id FROM call_logs WHERE lead_id = $2 AND call_sid IS NULL ORDER BY created_at DESC LIMIT 1)`,
        [callSid, leadId]
      );
    }

    return reply.status(200).send('OK');
  });

  /**
   * Connect Dynamic URL — returns RM numbers for parallel dialing.
   * CX is already on the line waiting.
   */
  fastify.all('/api/v1/exotel/connect', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const leadId = params.CustomField || params.customfield;

    console.log('[CONNECT] hit:', { leadId, params: Object.keys(params) });

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
      console.log('[CONNECT] No agents found, falling back to call center');
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

    console.log('[CONNECT] Returning RM numbers:', numbers);

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
   * Status Callback — Exotel POSTs (or GETs) final call status.
   * Accepts both JSON and form-urlencoded.
   * Logs disposition, triggers retries, sends WhatsApp notification.
   */
  fastify.all('/api/v1/exotel/status-callback', async (request, reply) => {
    const data = { ...request.query, ...request.body };

    console.log('[STATUS-CALLBACK] received:', JSON.stringify(data));

    const callSid = data.CallSid || data.callsid || '';
    const leadId = data.CustomField || data.customfield || '';
    const status = data.Status || data.status || '';
    const dialStatus = data.DialCallStatus || data.dialcallstatus || '';
    const dialWhom = data.DialWhomNumber || data.dialwhomnumber || '';
    const duration = parseInt(data.Duration || data.duration || data.DialCallDuration || 0);
    const recordingUrl = data.RecordingUrl || data.recordingurl || '';

    if (!leadId) {
      console.log('[STATUS-CALLBACK] No CustomField/leadId, ignoring');
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
    } else if (lowerDial === 'completed' && duration > 5) {
      disposition = 'RM_CONNECTED';
    } else if (lowerDial === 'no-answer' || lowerDial === 'busy') {
      disposition = 'RM_NO_ANSWER';
    } else if (lowerStatus === 'completed' && lowerDial === '') {
      // Call completed but no RM was dialed (flow ended after passthru/greeting)
      disposition = duration > 10 ? 'RM_CONNECTED' : 'RM_NO_ANSWER';
    } else if (lowerStatus === 'completed') {
      disposition = duration > 10 ? 'RM_CONNECTED' : 'RM_NO_ANSWER';
    }

    console.log(`[STATUS-CALLBACK] Lead: ${leadId}, Status: ${status}, DialStatus: ${dialStatus}, Disposition: ${disposition}, Duration: ${duration}`);

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

    // Update the INITIATED log entry with final status
    await query(
      `UPDATE call_logs SET disposition = $1, call_sid = $2, exotel_status = $3, call_duration_sec = $4, rm_who_answered = $5, recording_url = $6, metadata = $7
       WHERE id = (SELECT id FROM call_logs WHERE lead_id = $8 AND disposition = 'INITIATED' ORDER BY created_at DESC LIMIT 1)`,
      [disposition, callSid, status, duration, disposition === 'RM_CONNECTED' ? dialWhom : null, recordingUrl, JSON.stringify(data), leadId]
    );

    // Get lead data for WhatsApp notification
    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [leadId]);
    const lead = leadRes.rows[0];

    // Get attempt count
    const attemptsRes = await query(
      `SELECT COUNT(*) as cnt FROM call_logs WHERE lead_id = $1 AND call_type = 'outbound_cx' AND disposition NOT IN ('INITIATED')`,
      [leadId]
    );
    const attemptCount = parseInt(attemptsRes.rows[0]?.cnt || 1);

    // Handle outcomes
    if (disposition === 'RM_CONNECTED') {
      await query(
        `UPDATE leads SET status = 'connected', assigned_rm_phone = $2, connected_at = NOW(), updated_at = NOW() WHERE lead_id = $1`,
        [leadId, dialWhom]
      );
      // WhatsApp: notify success
      if (lead) await triggerWhatsAppNotification(lead, disposition, { call_sid: callSid, rm_who_answered: dialWhom, call_duration_sec: duration, attempt_number: attemptCount });

    } else if (disposition === 'CUSTOMER_NOT_PICKED' || disposition === 'CX_DROP_VOICEBOT') {
      if (attemptCount < 2) {
        await scheduleRetry(leadId, 'cx_no_answer', attemptCount + 1, 2);
      } else {
        if (lead) {
          const { createUtmLead } = await import('../services/utm-creator.js');
          await createUtmLead(lead, 'cx_no_answer');
          await triggerWhatsAppNotification(lead, 'UTM_LEAD_CREATED', { attempt_number: attemptCount });
        }
      }
      // WhatsApp: notify CX not picked
      if (lead) await triggerWhatsAppNotification(lead, disposition, { attempt_number: attemptCount });

    } else if (disposition === 'RM_NO_ANSWER') {
      if (attemptCount < 3) {
        await scheduleRetry(leadId, 'rm_no_answer', attemptCount + 1, 3);
      } else {
        if (lead) {
          const { createUtmLead } = await import('../services/utm-creator.js');
          await createUtmLead(lead, 'rm_no_answer');
          await triggerWhatsAppNotification(lead, 'UTM_LEAD_CREATED', { attempt_number: attemptCount });
        }
      }
      // WhatsApp: notify RM not answered
      if (lead) await triggerWhatsAppNotification(lead, disposition, { call_sid: callSid, attempt_number: attemptCount });

    } else if (disposition === 'CALL_FAILED') {
      await query(`UPDATE leads SET status = 'failed', updated_at = NOW() WHERE lead_id = $1`, [leadId]);
      if (lead) await triggerWhatsAppNotification(lead, disposition, { attempt_number: attemptCount });
    }

    return reply.status(200).send('OK');
  });

  /**
   * Inbound passthru — customer calls ExoPhone.
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
        `INSERT INTO leads (lead_id, customer_phone, lead_source, status) VALUES ($1, $2, 'inbound', 'in_progress')`,
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
      await query(`UPDATE leads SET utm_identifier = 'already_spoke_to_cx', updated_at = NOW() WHERE lead_id = $1`, [lead.lead_id]);
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
