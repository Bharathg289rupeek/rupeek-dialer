import { query } from '../db/connection.js';
import { processAgentCsv } from '../services/csv-processor.js';
import { formatPhone } from '../utils/business-hours.js';

export default async function agentRoutes(fastify) {

  // List agents
  fastify.get('/api/v1/agents', { preHandler: fastify.auth }, async (request) => {
    const { city, pincode, branch_id, is_active, search, page = 1, limit = 100 } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (city) { conditions.push(`city = $${idx++}`); params.push(city.toLowerCase()); }
    if (pincode) { conditions.push(`pincode = $${idx++}`); params.push(pincode); }
    if (branch_id) { conditions.push(`branch_id = $${idx++}`); params.push(branch_id); }
    if (is_active !== undefined) { conditions.push(`is_active = $${idx++}`); params.push(is_active === 'true'); }
    if (search) {
      conditions.push(`(agent_name ILIKE $${idx} OR agent_email ILIKE $${idx} OR agent_phone ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await query(`SELECT COUNT(*) FROM agents ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(parseInt(limit));
    params.push(offset);
    const res = await query(
      `SELECT * FROM agents ${where} ORDER BY city, priority ASC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return { agents: res.rows, total, page: parseInt(page), limit: parseInt(limit) };
  });

  // Create single agent
  fastify.post('/api/v1/agents', { preHandler: fastify.auth }, async (request, reply) => {
    const b = request.body;
    if (!b.agent_email || !b.agent_phone || !b.agent_name || !b.city || !b.branch_id || !b.pincode) {
      return reply.status(400).send({ error: 'Required: agent_email, agent_phone, agent_name, city, branch_id, pincode' });
    }

    const res = await query(
      `INSERT INTO agents (branch_id, agent_email, agent_name, agent_phone, city, pincode, priority, city_identifier, pincode_identifier, branch_identifier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        b.branch_id, b.agent_email.toLowerCase(), b.agent_name, formatPhone(b.agent_phone),
        b.city.toLowerCase(), b.pincode, b.priority || 1,
        b.city_identifier || 'dont assign', b.pincode_identifier || 'dont assign', b.branch_identifier || 'dont assign',
      ]
    );
    return reply.status(201).send(res.rows[0]);
  });

  // Update agent
  fastify.put('/api/v1/agents/:id', { preHandler: fastify.auth }, async (request) => {
    const { id } = request.params;
    const b = request.body;
    const fields = [];
    const params = [];
    let idx = 1;

    const allowed = ['branch_id','agent_name','agent_phone','city','pincode','priority',
      'city_identifier','pincode_identifier','branch_identifier','is_active'];
    for (const key of allowed) {
      if (b[key] !== undefined) {
        let val = b[key];
        if (key === 'agent_phone') val = formatPhone(val);
        if (key === 'city') val = val.toLowerCase();
        fields.push(`${key} = $${idx++}`);
        params.push(val);
      }
    }

    if (fields.length === 0) return { error: 'No fields to update' };

    fields.push(`updated_at = NOW()`);
    params.push(id);
    const res = await query(
      `UPDATE agents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return res.rows[0] || { error: 'Agent not found' };
  });

  // Soft delete
  fastify.delete('/api/v1/agents/:id', { preHandler: fastify.auth }, async (request) => {
    const { id } = request.params;
    await query(`UPDATE agents SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);
    return { success: true };
  });

  // CSV upload
  fastify.post('/api/v1/agents/upload-csv', { preHandler: fastify.auth }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const result = await processAgentCsv(buffer, data.filename, request.user?.email || 'unknown');

    if (result.error) return reply.status(400).send(result);
    return result;
  });

  // Get unique cities/pincodes/branches for filters
  fastify.get('/api/v1/agents/filters', { preHandler: fastify.auth }, async () => {
    const cities = await query(`SELECT DISTINCT city FROM agents WHERE is_active = true ORDER BY city`);
    const pincodes = await query(`SELECT DISTINCT pincode FROM agents WHERE is_active = true ORDER BY pincode`);
    const branches = await query(`SELECT DISTINCT branch_id FROM agents WHERE is_active = true ORDER BY branch_id`);
    return {
      cities: cities.rows.map(r => r.city),
      pincodes: pincodes.rows.map(r => r.pincode),
      branches: branches.rows.map(r => r.branch_id),
    };
  });
}
