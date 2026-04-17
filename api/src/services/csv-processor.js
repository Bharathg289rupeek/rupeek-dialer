import { parse } from 'csv-parse/sync';
import { query, getClient } from '../db/connection.js';
import { formatPhone } from '../utils/business-hours.js';

const REQUIRED_COLS = ['branch_id', 'agent_email', 'agent_name', 'agent_phone', 'city', 'pincode'];
const IDENTIFIER_COLS = ['city_identifier', 'pincode_identifier', 'branch_identifier'];

export async function processAgentCsv(csvBuffer, filename, uploadedBy) {
  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Validate columns
  const cols = Object.keys(records[0] || {});
  const missing = REQUIRED_COLS.filter(c => !cols.includes(c));
  if (missing.length > 0) {
    return { error: `Missing required columns: ${missing.join(', ')}` };
  }

  const hasIdentifiers = IDENTIFIER_COLS.some(c => cols.includes(c));
  const hasPriority = cols.includes('priority');

  let newCount = 0, updatedCount = 0, skippedCount = 0;
  const errors = [];
  const client = await getClient();

  try {
    await client.query('BEGIN');

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2; // 1-indexed + header

      // Validate row
      const rowErrors = [];
      if (!row.agent_email) rowErrors.push('agent_email is empty');
      if (!row.agent_phone) rowErrors.push('agent_phone is empty');
      if (!row.city) rowErrors.push('city is empty');
      if (!row.branch_id) rowErrors.push('branch_id is empty');

      if (rowErrors.length > 0) {
        errors.push({ row: rowNum, errors: rowErrors });
        skippedCount++;
        continue;
      }

      const phone = formatPhone(row.agent_phone);
      const priority = hasPriority && row.priority ? parseInt(row.priority) || 1 : 1;

      // Check if agent exists
      const existing = await client.query(
        `SELECT id, city_identifier, pincode_identifier, branch_identifier FROM agents WHERE agent_email = $1`,
        [row.agent_email.toLowerCase()]
      );

      if (existing.rows.length > 0) {
        // UPDATE — preserve identifiers unless explicitly provided in CSV
        const agent = existing.rows[0];
        const cityId = (hasIdentifiers && row.city_identifier?.trim())
          ? row.city_identifier.trim() : agent.city_identifier;
        const pincodeId = (hasIdentifiers && row.pincode_identifier?.trim())
          ? row.pincode_identifier.trim() : agent.pincode_identifier;
        const branchId = (hasIdentifiers && row.branch_identifier?.trim())
          ? row.branch_identifier.trim() : agent.branch_identifier;

        await client.query(
          `UPDATE agents SET
            branch_id = $2, agent_name = $3, agent_phone = $4, city = $5, pincode = $6,
            priority = $7, city_identifier = $8, pincode_identifier = $9, branch_identifier = $10,
            is_active = true, updated_at = NOW()
           WHERE id = $1`,
          [agent.id, row.branch_id, row.agent_name, phone, row.city.toLowerCase(), row.pincode, priority, cityId, pincodeId, branchId]
        );
        updatedCount++;
      } else {
        // INSERT new agent
        const cityId = (hasIdentifiers && row.city_identifier?.trim()) ? row.city_identifier.trim() : 'dont assign';
        const pincodeId = (hasIdentifiers && row.pincode_identifier?.trim()) ? row.pincode_identifier.trim() : 'dont assign';
        const branchId = (hasIdentifiers && row.branch_identifier?.trim()) ? row.branch_identifier.trim() : 'dont assign';

        await client.query(
          `INSERT INTO agents (branch_id, agent_email, agent_name, agent_phone, city, pincode, priority, city_identifier, pincode_identifier, branch_identifier)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [row.branch_id, row.agent_email.toLowerCase(), row.agent_name, phone, row.city.toLowerCase(), row.pincode, priority, cityId, pincodeId, branchId]
        );
        newCount++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Audit log
  await query(
    `INSERT INTO csv_uploads (filename, uploaded_by, total_rows, new_agents, updated_agents, skipped_agents, errors)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [filename, uploadedBy, records.length, newCount, updatedCount, skippedCount, JSON.stringify(errors)]
  );

  return {
    total_rows: records.length,
    new_agents: newCount,
    updated_agents: updatedCount,
    skipped_agents: skippedCount,
    errors,
  };
}
