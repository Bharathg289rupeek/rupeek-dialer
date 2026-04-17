import { query } from '../db/connection.js';
import { clearRulesCache, testRouting } from '../services/routing-engine.js';

export default async function sourceRoutingRoutes(fastify) {

  // List all rules
  fastify.get('/api/v1/source-routing-rules', { preHandler: fastify.auth }, async () => {
    const res = await query(`SELECT * FROM source_routing_rules ORDER BY lead_source ASC`);
    return { rules: res.rows };
  });

  // Create new rule
  fastify.post('/api/v1/source-routing-rules', { preHandler: fastify.auth }, async (request, reply) => {
    const { lead_source, routing_level, fallback_levels } = request.body || {};
    if (!lead_source || !routing_level) {
      return reply.status(400).send({ error: 'lead_source and routing_level are required' });
    }
    if (!['pincode', 'branch_id', 'city'].includes(routing_level)) {
      return reply.status(400).send({ error: 'routing_level must be pincode, branch_id, or city' });
    }

    const res = await query(
      `INSERT INTO source_routing_rules (lead_source, routing_level, fallback_levels)
       VALUES ($1, $2, $3) RETURNING *`,
      [lead_source.toLowerCase(), routing_level, JSON.stringify(fallback_levels || [])]
    );
    clearRulesCache();
    return reply.status(201).send(res.rows[0]);
  });

  // Update rule
  fastify.put('/api/v1/source-routing-rules/:id', { preHandler: fastify.auth }, async (request) => {
    const { id } = request.params;
    const { routing_level, fallback_levels, is_active } = request.body || {};
    const fields = [];
    const params = [];
    let idx = 1;

    if (routing_level) {
      if (!['pincode', 'branch_id', 'city'].includes(routing_level)) {
        return { error: 'routing_level must be pincode, branch_id, or city' };
      }
      fields.push(`routing_level = $${idx++}`);
      params.push(routing_level);
    }
    if (fallback_levels !== undefined) {
      fields.push(`fallback_levels = $${idx++}`);
      params.push(JSON.stringify(fallback_levels));
    }
    if (is_active !== undefined) {
      fields.push(`is_active = $${idx++}`);
      params.push(is_active);
    }

    if (fields.length === 0) return { error: 'Nothing to update' };

    fields.push(`updated_at = NOW()`);
    params.push(id);
    const res = await query(
      `UPDATE source_routing_rules SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    clearRulesCache();
    return res.rows[0] || { error: 'Rule not found' };
  });

  // Delete rule (cannot delete 'default')
  fastify.delete('/api/v1/source-routing-rules/:id', { preHandler: fastify.auth }, async (request, reply) => {
    const { id } = request.params;
    const check = await query(`SELECT lead_source FROM source_routing_rules WHERE id = $1`, [id]);
    if (check.rows[0]?.lead_source === 'default') {
      return reply.status(400).send({ error: 'Cannot delete the default rule' });
    }
    await query(`DELETE FROM source_routing_rules WHERE id = $1`, [id]);
    clearRulesCache();
    return { success: true };
  });

  // Test routing — simulate routing for a sample lead
  fastify.post('/api/v1/source-routing-rules/test', { preHandler: fastify.auth }, async (request) => {
    const { lead_source, city, pincode, branch_id } = request.body || {};
    return await testRouting({
      lead_source: lead_source || 'default',
      city: city?.toLowerCase(),
      pincode,
      branch_id,
    });
  });
}
