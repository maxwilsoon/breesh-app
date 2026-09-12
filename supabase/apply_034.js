/**
 * apply_034.js — Apply migration 034: bcrypt passcode upgrade + column-protection trigger
 *
 * Sets the session-level approval flag (truzo.c2_reset_approved = 'yes') before
 * executing the migration SQL.  This flag is required by the migration's precondition
 * DO block and confirms that:
 *   - This is a test environment with test data only.
 *   - All existing parent passcode_hash values will be nulled (PINs stop working).
 *   - Affected parents must use email/password login to set a new 6-digit PIN.
 *
 * The entire migration runs inside a single transaction for atomicity.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const c = new Client({ connectionString: DATABASE_URL });

(async () => {
  await c.connect();

  const sqlPath = path.join(__dirname, '20260803_034_bcrypt_passcode.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // The migration SQL contains its own BEGIN/COMMIT.  Set the session-level approval
  // flag before running so the precondition DO block sees it.
  // TEST ENVIRONMENT ONLY — this confirms all affected rows are test data.
  await c.query("SET truzo.c2_reset_approved = 'yes'");

  await c.query(sql);
  console.log('Migration 034 applied successfully.');

  await c.end();
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
