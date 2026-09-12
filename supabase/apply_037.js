// apply_037.js — Apply migration 037: child-session enforcement on read RPCs
//
// Usage:
//   node supabase/apply_037.js              # apply + verify
//   node supabase/apply_037.js --verify-only

'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const MIGRATION_FILE = path.join(__dirname, '20260804_037_data_read_sessions.sql');
const VERIFY_FILE    = path.join(__dirname, 'verify_037.js');

async function applyMigration() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  console.log('Connected to live DB.\n');
  try {
    console.log('Applying migration 037...');
    await c.query(sql);
    console.log('Migration 037 applied successfully.\n');
  } catch (e) {
    console.error('Migration 037 FAILED:', e.message);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

async function runVerify() {
  console.log('Running verify_037.js...\n');
  const env = { ...process.env, DATABASE_URL };
  try {
    execSync(`node "${VERIFY_FILE}"`, { env, stdio: 'inherit', timeout: 120_000 });
  } catch (e) {
    console.error('\nverify_037.js exited non-zero — migration applied but verification failed.');
    process.exit(1);
  }
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (!verifyOnly) await applyMigration();
  await runVerify();
  console.log(verifyOnly
    ? '\nMigration 037 verification complete.'
    : '\nMigration 037 applied and verified successfully.');
}

main().catch(e => {
  console.error('Fatal:', e.message ?? String(e));
  process.exit(1);
});
