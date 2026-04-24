import { query } from '../db/connection.js';
import { clearConfigCache } from '../utils/business-hours.js';

// Columns exposed by GET and writable by POST/PUT on /routing-config.
// Keep in sync with migrations/002_retry_policies.sql.
const RETRY_CONFIG_COLUMNS = [
  'cx_not_picked_max_attempts',
  'cx_not_picked_interval_min',
  'cx_drop_voicebot_max_attempts',
  'cx_drop_voicebot_interval_min',
  'callcenter_no_answer_max_attempts',
  'callcenter_no_answer_interval_min',
  'call_failed_max_attempts',
  'call_failed_interval_min',
];

const EDITABLE_CONFIG_COLUMNS = [
  'fallback_call_center_number',
  'max_parallel_rms',
  'rm_ring_duration_sec',
  'business_hours_start',
  'business_hours_end',
  'business_days',
  ...RETRY_CONFIG_COLUMNS,
];

export default async function routingConfigRoutes(fastify) {

  fastify.get('/api/v1/routing-config', { preHandler: fastify.auth }, async () => {
    const res = await query(`SELECT * FROM routing_config WHERE is_active = true LIMIT 1`);
    return res.rows[0] || {};
  });

  fastify.post('/api/v1/routing-config', { preHandler: fastify.auth }, async (request, reply) => {
    const existing = await query(`SELECT id FROM routing_config WHERE is_active = true LIMIT 1`);
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: 'Config already exists', id: existing.rows[0].id });
    }

    const b = request.body || {};
    const res = await query(
      `INSERT INTO routing_config
         (name, fallback_call_center_number, max_parallel_rms, rm_ring_duration_sec,
          business_hours_start, business_hours_end, business_days,
          cx_not_picked_max_attempts, cx_not_picked_interval_min,
          cx_drop_voicebot_max_attempts, cx_drop_voicebot_interval_min,
          callcenter_no_answer_max_attempts, callcenter_no_answer_interval_min,
          call_failed_max_attempts, call_failed_interval_min)
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        b.fallback_call_center_number || '+910000000000',
        b.max_parallel_rms || 3,
        b.rm_ring_duration_sec || 20,
        b.business_hours_start || '09:00',
        b.business_hours_end || '18:00',
        JSON.stringify(b.business_days || ['mon','tue','wed','thu','fri','sat']),
        b.cx_not_picked_max_attempts ?? 2,
        b.cx_not_picked_interval_min ?? 10,
        b.cx_drop_voicebot_max_attempts ?? 2,
        b.cx_drop_voicebot_interval_min ?? 10,
        b.callcenter_no_answer_max_attempts ?? 2,
        b.callcenter_no_answer_interval_min ?? 10,
        b.call_failed_max_attempts ?? 3,
        b.call_failed_interval_min ?? 5,
      ]
    );
    clearConfigCache();
    return reply.status(201).send(res.rows[0]);
  });

  fastify.put('/api/v1/routing-config/:id', { preHandler: fastify.auth }, async (request) => {
    const { id } = request.params;
    const b = request.body || {};
    const fields = [];
    const params = [];
    let idx = 1;

    for (const key of EDITABLE_CONFIG_COLUMNS) {
      if (b[key] !== undefined) {
        if (key === 'business_days') {
          fields.push(`${key} = $${idx++}`);
          params.push(JSON.stringify(b[key]));
        } else if (RETRY_CONFIG_COLUMNS.includes(key)) {
          // Coerce to int, reject negative / zero
          const n = parseInt(b[key]);
          if (isNaN(n) || n < 1) return { error: `${key} must be a positive integer` };
          fields.push(`${key} = $${idx++}`);
          params.push(n);
        } else {
          fields.push(`${key} = $${idx++}`);
          params.push(b[key]);
        }
      }
    }
    if (fields.length === 0) return { error: 'Nothing to update' };

    fields.push(`updated_at = NOW()`);
    params.push(id);
    const res = await query(
      `UPDATE routing_config SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    clearConfigCache();
    return res.rows[0] || { error: 'Not found' };
  });
}

export async function callLogRoutes(fastify) {

  fastify.get('/api/v1/call-logs', { preHandler: fastify.auth }, async (request) => {
    const { disposition, call_type, lead_id, from_date, to_date, page = 1, limit = 50 } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (disposition) { conditions.push(`disposition = $${idx++}`); params.push(disposition); }
    if (call_type)   { conditions.push(`call_type = $${idx++}`);   params.push(call_type); }
    if (lead_id)     { conditions.push(`lead_id = $${idx++}`);     params.push(lead_id); }
    if (from_date)   { conditions.push(`created_at >= $${idx++}`); params.push(from_date); }
    if (to_date)     { conditions.push(`created_at <= $${idx++}`); params.push(to_date); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await query(`SELECT COUNT(*) FROM call_logs ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(parseInt(limit));
    params.push(offset);
    const res = await query(
      `SELECT * FROM call_logs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return { logs: res.rows, total, page: parseInt(page), limit: parseInt(limit) };
  });
}

export async function dashboardRoutes(fastify) {

  fastify.get('/api/v1/dashboard/stats', { preHandler: fastify.auth }, async (request) => {
    const { from_date, to_date } = request.query;
    const today = new Date().toISOString().split('T')[0];
    const start = from_date || today;
    const end   = to_date   || today + 'T23:59:59Z';

    // Summary cards — new statuses added, utm_created kept for historical visibility
    const summary = await query(`
      SELECT
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE status = 'connected')              as connected,
        COUNT(*) FILTER (WHERE status = 'call_center_handled')    as call_center_handled,
        COUNT(*) FILTER (WHERE status = 'cx_notpicked_retrying')  as retrying,
        COUNT(*) FILTER (WHERE status = 'in_progress')            as in_progress,
        COUNT(*) FILTER (WHERE status = 'queued')                 as queued,
        COUNT(*) FILTER (WHERE status = 'failed')                 as failed,
        COUNT(*) FILTER (WHERE status = 'new')                    as new_leads
      FROM leads
      WHERE created_at >= $1 AND created_at <= $2
    `, [start, end]);

    // Disposition breakdown
    const dispositions = await query(`
      SELECT disposition, COUNT(*) as count
      FROM call_logs
      WHERE created_at >= $1 AND created_at <= $2
        AND disposition IS NOT NULL AND disposition != 'INITIATED'
      GROUP BY disposition
      ORDER BY count DESC
    `, [start, end]);

    // Hourly chart — new disposition buckets
    const hourly = await query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata') as hour,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE disposition = 'RM_CONNECTED')              as connected,
        COUNT(*) FILTER (WHERE disposition = 'RM_NO_ANSWER_CALLCENTER')   as call_center,
        COUNT(*) FILTER (WHERE disposition = 'CALLCENTER_NO_ANSWER')      as callcenter_no_answer,
        COUNT(*) FILTER (WHERE disposition = 'CUSTOMER_NOT_PICKED')       as cx_not_picked,
        COUNT(*) FILTER (WHERE disposition = 'CX_DROP_VOICEBOT')          as cx_drop,
        COUNT(*) FILTER (WHERE disposition = 'INVALID_NUMBER')            as invalid_number,
        COUNT(*) FILTER (WHERE disposition = 'CALL_FAILED')               as failed
      FROM call_logs
      WHERE created_at >= $1 AND created_at <= $2
        AND disposition IS NOT NULL AND disposition != 'INITIATED'
      GROUP BY hour
      ORDER BY hour
    `, [start, end]);

    const retries = await query(`SELECT COUNT(*) as count FROM retry_queue WHERE status = 'pending'`);

    const sources = await query(`
      SELECT lead_source, COUNT(*) as count,
        COUNT(*) FILTER (WHERE status = 'connected')           as connected,
        COUNT(*) FILTER (WHERE status = 'call_center_handled') as call_center_handled
      FROM leads
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY lead_source ORDER BY count DESC
    `, [start, end]);

    return {
      summary: summary.rows[0],
      dispositions: dispositions.rows,
      hourly: hourly.rows,
      pending_retries: parseInt(retries.rows[0]?.count || 0),
      sources: sources.rows,
    };
  });

  // Retry queue (unchanged)
  fastify.get('/api/v1/retry-queue', { preHandler: fastify.auth }, async (request) => {
    const { status, page = 1, limit = 50 } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`rq.status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    params.push(parseInt(limit));
    params.push(offset);
    const res = await query(`
      SELECT rq.*, l.customer_name, l.customer_phone, l.city
      FROM retry_queue rq
      LEFT JOIN leads l ON l.lead_id = rq.lead_id
      ${where}
      ORDER BY rq.scheduled_at ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const countRes = await query(`SELECT COUNT(*) FROM retry_queue rq ${where}`,
      params.slice(0, params.length - 2));

    return { retries: res.rows, total: parseInt(countRes.rows[0].count), page: parseInt(page) };
  });

  fastify.post('/api/v1/retry-queue/:id/trigger', { preHandler: fastify.auth }, async (request) => {
    const { id } = request.params;
    await query(`UPDATE retry_queue SET scheduled_at = NOW(), status = 'pending' WHERE id = $1`, [id]);
    return { success: true };
  });

  fastify.delete('/api/v1/retry-queue/:id', { preHandler: fastify.auth }, async (request) => {
    await query(`UPDATE retry_queue SET status = 'completed' WHERE id = $1`, [request.params.id]);
    return { success: true };
  });
}
