// apply_036.js — Apply migration 036: critical/high RPC authorization hardening
//
// Usage:
//   node supabase/apply_036.js
//
// Steps:
//   1. Connects to live DB.
//   2. Applies 20260803_036_revoke_public_grants.sql.
//   3. Passes DATABASE_URL through and runs verify_036.js inline.
//   4. Fails fast — stops on any verification failure and reports the exact group.
//   5. Credentials are never printed to stdout or stderr.

'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const MIGRATION_FILE = path.join(__dirname, '20260803_036_revoke_public_grants.sql');
const VERIFY_FILE    = path.join(__dirname, 'verify_036.js');

async function applyMigration() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');

  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  console.log('Connected to live DB.\n');

  try {
    console.log('Applying migration 036...');
    await c.query(sql);
    console.log('Migration 036 applied successfully.\n');
  } catch (e) {
    console.error('Migration 036 FAILED:', e.message);
    await c.end();
    process.exit(1);
  }

  await c.end();
}

async function runVerify() {
  console.log('Running verify_036.js...\n');
  const env = { ...process.env, DATABASE_URL };

  try {
    const output = execSync(`node "${VERIFY_FILE}"`, {
      env,
      stdio: 'inherit',
      timeout: 60_000,
    });
  } catch (e) {
    console.error('\nverify_036.js exited non-zero — migration applied but verification failed.');
    process.exit(1);
  }
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (!verifyOnly) {
    await applyMigration();
  }
  await runVerify();
  if (verifyOnly) {
    console.log('\nMigration 036 verification complete.');
  } else {
    console.log('\nMigration 036 applied and verified successfully.');
  }
}

main().catch(e => {
  console.error('Fatal:', e.message ?? String(e));
  process.exit(1);
});
