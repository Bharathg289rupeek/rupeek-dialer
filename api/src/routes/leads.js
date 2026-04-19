import { query } from '../db/connection.js';
import { isBusinessHours, getRoutingConfig, getNextBusinessDay, formatPhone } from '../utils/business-hours.js';
import { triggerOutboundCall } from '../services/call-orchestrator.js';

export default async function leadRoutes(fastify) {

  // Webhook: Lead ingestion from Chakra CRM (no auth — secured by webhook secret)
  fastify.post('/api/v1/leads/ingest', async (request, reply) => {
    const body = request.body || {};
    const { phone, name, city, pincode, branch_id, loan_type, loan_amount, lead_source } = body;
    // Auto-generate lead_id if not provided
    const lead_id = body.lead_id || `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (!phone) {
      return reply.status(400).send({ error: 'phone is required' });
    }

    // Deduplicate
    const existing = await query(`SELECT id, status FROM leads WHERE lead_id = $1`, [lead_id]);
    if (existing.rows.length > 0) {
      const st = existing.rows[0].status;
      if (st === 'connected' || st === 'in_progress') {
        return reply.status(409).send({ error: 'Lead already in progress or connected', status: st });
      }
      // If failed, allow re-trigger — delete old record
      if (st === 'failed') {
        await query(`DELETE FROM leads WHERE lead_id = $1`, [lead_id]);
      }
    }

    const config = await getRoutingConfig();
    const inHours = isBusinessHours(config);
    const customerPhone = formatPhone(phone);
    const source = lead_source || 'chakra';

    if (!inHours) {
      const nextDay = getNextBusinessDay(config);
      await query(
        `INSERT INTO leads (lead_id, customer_name, customer_phone, city, pincode, branch_id, loan_type, loan_amount, lead_source, status, queued_for)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)
         ON CONFLICT (lead_id) DO UPDATE SET status='queued', queued_for=$10, updated_at=NOW()`,
        [lead_id, name, customerPhone, city?.toLowerCase(), pincode, branch_id, loan_type, loan_amount || null, source, nextDay]
      );
      return reply.status(202).send({ success: true, lead_id, status: 'queued', scheduled_at: nextDay });
    }

    // Insert lead
    await query(
      `INSERT INTO leads (lead_id, customer_name, customer_phone, city, pincode, branch_id, loan_type, loan_amount, lead_source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new')
       ON CONFLICT (lead_id) DO UPDATE SET status='new', updated_at=NOW()`,
      [lead_id, name, customerPhone, city?.toLowerCase(), pincode, branch_id, loan_type, loan_amount || null, source]
    );

    // Trigger call asynchronously (don't block webhook response)
    const lead = { lead_id, customer_name: name, customer_phone: customerPhone, city: city?.toLowerCase(), pincode, branch_id, lead_source: source, loan_type, loan_amount };
    setImmediate(() => triggerOutboundCall(lead, 1).catch(err => console.error('Call trigger error:', err)));

    return { success: true, lead_id, status: 'new' };
  });

  // List leads (dashboard)
  fastify.get('/api/v1/leads', { preHandler: fastify.auth }, async (request) => {
    const { status, city, lead_source, search, page = 1, limit = 50, from_date, to_date } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`l.status = $${idx++}`); params.push(status); }
    if (city) { conditions.push(`l.city = $${idx++}`); params.push(city.toLowerCase()); }
    if (lead_source) { conditions.push(`l.lead_source = $${idx++}`); params.push(lead_source); }
    if (search) {
      conditions.push(`(l.lead_id ILIKE $${idx} OR l.customer_name ILIKE $${idx} OR l.customer_phone ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (from_date) { conditions.push(`l.created_at >= $${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`l.created_at <= $${idx++}`); params.push(to_date); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await query(`SELECT COUNT(*) FROM leads l ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(parseInt(limit));
    params.push(offset);
    const res = await query(
      `SELECT l.*, 
        (SELECT COUNT(*) FROM call_logs cl WHERE cl.lead_id = l.lead_id) as call_count
       FROM leads l ${where}
       ORDER BY l.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return { leads: res.rows, total, page: parseInt(page), limit: parseInt(limit) };
  });

  // Lead detail with call history
  fastify.get('/api/v1/leads/:lead_id', { preHandler: fastify.auth }, async (request) => {
    const { lead_id } = request.params;
    const leadRes = await query(`SELECT * FROM leads WHERE lead_id = $1`, [lead_id]);
    if (leadRes.rows.length === 0) return { error: 'Lead not found' };

    const callsRes = await query(
      `SELECT * FROM call_logs WHERE lead_id = $1 ORDER BY created_at ASC`,
      [lead_id]
    );
    const retriesRes = await query(
      `SELECT * FROM retry_queue WHERE lead_id = $1 ORDER BY created_at ASC`,
      [lead_id]
    );

    return { lead: leadRes.rows[0], calls: callsRes.rows, retries: retriesRes.rows };
  });
}
