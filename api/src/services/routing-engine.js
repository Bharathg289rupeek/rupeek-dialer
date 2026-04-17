import { query } from '../db/connection.js';
import { getRoutingConfig } from '../utils/business-hours.js';

// Cache source routing rules for 60s
let _rulesCache = null;
let _rulesCacheTime = 0;
const CACHE_TTL = 60000;

export async function getSourceRules() {
  if (_rulesCache && Date.now() - _rulesCacheTime < CACHE_TTL) return _rulesCache;
  const res = await query(`SELECT * FROM source_routing_rules WHERE is_active = true`);
  _rulesCache = res.rows;
  _rulesCacheTime = Date.now();
  return _rulesCache;
}

export function clearRulesCache() {
  _rulesCache = null;
  _rulesCacheTime = 0;
}

const LEVEL_TO_COLUMN = {
  pincode:   { col: 'pincode',   identifier: 'pincode_identifier'  },
  branch_id: { col: 'branch_id', identifier: 'branch_identifier'   },
  city:      { col: 'city',      identifier: 'city_identifier'     },
};

/**
 * Find RMs for a lead based on source routing rules.
 * @param {Object} lead - { lead_source, city, pincode, branch_id }
 * @returns {{ agents: Array, matched_level: string|null }}
 */
export async function findRMsForLead(lead) {
  const rules = await getSourceRules();
  const config = await getRoutingConfig();
  const maxRMs = config?.max_parallel_rms || 3;

  // Find rule for this source, or fall back to 'default'
  let rule = rules.find(r => r.lead_source === lead.lead_source);
  if (!rule) rule = rules.find(r => r.lead_source === 'default');
  if (!rule) {
    return { agents: [], matched_level: null };
  }

  // Build full routing chain: [primary, ...fallbacks]
  const chain = [rule.routing_level, ...(rule.fallback_levels || [])];

  for (const level of chain) {
    const mapping = LEVEL_TO_COLUMN[level];
    if (!mapping) continue;

    const leadValue = lead[mapping.col];
    if (!leadValue) continue; // lead doesn't have this field, skip

    const res = await query(
      `SELECT id, agent_name, agent_phone, agent_email, branch_id, city, pincode, priority
       FROM agents
       WHERE ${mapping.col} = $1
         AND ${mapping.identifier} = 'assign'
         AND is_active = true
       ORDER BY priority ASC
       LIMIT $2`,
      [leadValue, maxRMs]
    );

    if (res.rows.length > 0) {
      return { agents: res.rows, matched_level: level };
    }
  }

  return { agents: [], matched_level: null };
}

/**
 * Test routing without making a call - used by dashboard test panel.
 */
export async function testRouting(leadData) {
  const rules = await getSourceRules();
  let rule = rules.find(r => r.lead_source === leadData.lead_source);
  if (!rule) rule = rules.find(r => r.lead_source === 'default');

  const chain = rule ? [rule.routing_level, ...(rule.fallback_levels || [])] : [];
  const result = await findRMsForLead(leadData);

  return {
    source_rule: rule || null,
    routing_chain: chain,
    matched_level: result.matched_level,
    matched_agents: result.agents,
    would_fallback_to_callcenter: result.agents.length === 0,
  };
}
