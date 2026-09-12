// apply_039.js — Apply migration 039: final grant cleanup + device-token ownership
//
// Usage:
//   node supabase/apply_039.js              # apply + verify
//   node supabase/apply_039.js --verify-only

'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const MIGRATION_FILE = path.join(__dirname, '20260804_039_grant_cleanup.sql');
const VERIFY_FILE    = path.join(__dirname, 'verify_039.js');

async function applyMigration() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  console.log('Connected to live DB.\n');
  try {
    console.log('Applying migration 039...');
    await c.query(sql);
    console.log('Migration 039 applied successfully.\n');
  } catch (e) {
    console.error('Migration 039 FAILED:', e.message);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

async function runVerify() {
  console.log('Running verify_039.js...\n');
  const env = { ...process.env, DATABASE_URL };
  try {
    execSync(`node "${VERIFY_FILE}"`, { env, stdio: 'inherit', timeout: 180_000 });
  } catch (e) {
    console.error('\nverify_039.js exited non-zero — migration applied but verification failed.');
    process.exit(1);
  }
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (!verifyOnly) await applyMigration();
  await runVerify();
  console.log(verifyOnly
    ? '\nMigration 039 verification complete.'
    : '\nMigration 039 applied and verified successfully.');
}

main().catch(e => {
  console.error('Fatal:', e.message ?? String(e));
  process.exit(1);
});
