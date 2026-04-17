import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { query } from './connection.js';

async function seed() {
  console.log('Seeding database...');

  // Admin user
  const email = process.env.ADMIN_EMAIL || 'admin@rupeek.com';
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(pw, 10);
  await query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, 'Admin', 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );

  // Default routing config
  await query(
    `INSERT INTO routing_config (name, fallback_call_center_number, max_parallel_rms, rm_ring_duration_sec)
     VALUES ('default', $1, 3, 20)
     ON CONFLICT DO NOTHING`,
    [process.env.FALLBACK_CALL_CENTER_NUMBER || '+910000000000']
  );

  // Default source routing rules
  const rules = [
    ['chakra',  'branch_id', '["pincode","city"]'],
    ['inbound', 'city',      '["branch_id","pincode"]'],
    ['default', 'pincode',   '["branch_id","city"]'],
  ];
  for (const [src, level, fb] of rules) {
    await query(
      `INSERT INTO source_routing_rules (lead_source, routing_level, fallback_levels)
       VALUES ($1, $2, $3)
       ON CONFLICT (lead_source) DO NOTHING`,
      [src, level, fb]
    );
  }

  console.log('Seed complete.');
  process.exit(0);
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1); });
