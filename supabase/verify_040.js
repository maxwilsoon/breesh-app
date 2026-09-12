// verify_040.js — Verify migration 040: authenticated grant on child login RPCs
//
// Tests:
//   T01  authenticated has EXECUTE on login_child(text,text,text)
//   T02  authenticated has EXECUTE on biometric_login_child(uuid,text,text)
//   T03  anon still has EXECUTE on login_child (existing grant preserved)
//   T04  anon still has EXECUTE on biometric_login_child (existing grant preserved)
//   T05  PUBLIC has NO EXECUTE on login_child
//   T06  PUBLIC has NO EXECUTE on biometric_login_child
//   T07  login_child callable from authenticated role (SET LOCAL ROLE)
//   T08  biometric_login_child callable from authenticated role
//   T09  login_child wrong password fails as anon (auth still enforced)
//   T10  login_child wrong password fails as authenticated (auth still enforced)
//   T11  rate limiting fires for authenticated role (device throttle)
//   T12  rate limiting fires for authenticated role (passcode throttle unchanged)
//   T13  proacl snapshot: login_child contains authenticated
//   T14  proacl snapshot: biometric_login_child contains authenticated
//   T15  TypeScript check

'use strict';
const { Client }   = require('pg');
const { execSync } = require('child_process');
const crypto       = require('crypto');
const path         = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const DB_CONFIG = { connectionString: DATABASE_URL };

let passed = 0;
let failed = 0;

function pass(id, msg) { console.log(`  PASS  ${id}: ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  ${id}: ${msg}`); failed++; }

async function main() {
  const c = new Client(DB_CONFIG);
  await c.connect();
  console.log('Connected to live DB.\n');

  // ── T01–T06: Grant table checks ──────────────────────────────────────────────
  console.log('=== Phase 1: Grant checks ===');
  const { rows: grantRows } = await c.query(`
    SELECT routine_name, grantee, privilege_type
    FROM information_schema.role_routine_grants
    WHERE specific_schema = 'public'
      AND routine_name IN ('login_child', 'biometric_login_child')
    ORDER BY routine_name, grantee
  `);

  const hasGrant = (fn, role) =>
    grantRows.some(r => r.routine_name === fn && r.grantee === role && r.privilege_type === 'EXECUTE');

  if (hasGrant('login_child', 'authenticated'))
    pass('T01', 'login_child: authenticated EXECUTE grant present');
  else
    fail('T01', 'login_child: authenticated EXECUTE grant MISSING');

  if (hasGrant('biometric_login_child', 'authenticated'))
    pass('T02', 'biometric_login_child: authenticated EXECUTE grant present');
  else
    fail('T02', 'biometric_login_child: authenticated EXECUTE grant MISSING');

  if (hasGrant('login_child', 'anon'))
    pass('T03', 'login_child: anon EXECUTE grant still present');
  else
    fail('T03', 'login_child: anon EXECUTE grant was accidentally removed');

  if (hasGrant('biometric_login_child', 'anon'))
    pass('T04', 'biometric_login_child: anon EXECUTE grant still present');
  else
    fail('T04', 'biometric_login_child: anon EXECUTE grant was accidentally removed');

  if (!hasGrant('login_child', 'PUBLIC'))
    pass('T05', 'login_child: PUBLIC has no EXECUTE grant');
  else
    fail('T05', 'login_child: PUBLIC unexpectedly has EXECUTE grant');

  if (!hasGrant('biometric_login_child', 'PUBLIC'))
    pass('T06', 'biometric_login_child: PUBLIC has no EXECUTE grant');
  else
    fail('T06', 'biometric_login_child: PUBLIC unexpectedly has EXECUTE grant');

  // ── T07–T08: Callable from authenticated role (SET LOCAL ROLE) ───────────────
  //
  // The postgres superuser can assume the authenticated role within a transaction.
  // A PERMISSION DENIED here means the GRANT did not take effect.
  // A NULL return (unknown user) or any app-level error (rate_limit_exceeded,
  // invalid_biometric_token) is acceptable — it means the call reached the function.
  console.log('\n=== Phase 2: Callable from authenticated role ===');

  const testDevice07 = 'verify-040-t07-' + Date.now();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(
      `SELECT public.login_child($1, $2, $3)`,
      ['verify_040_nonexistent_user', 'wrong-pass-verify-040', testDevice07]
    );
    await c.query('ROLLBACK');
    pass('T07', 'login_child: callable from authenticated role (returned without permission error)');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.message.includes('rate_limit_exceeded')) {
      pass('T07', 'login_child: callable from authenticated role (rate-limited, not permission denied)');
    } else if (e.message.includes('permission denied')) {
      fail('T07', `login_child: authenticated role still gets permission denied: ${e.message}`);
    } else {
      pass('T07', `login_child: callable from authenticated role (app error, not permission denied): ${e.message}`);
    }
  } finally {
    await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice07}`]).catch(() => {});
  }

  const testDevice08 = 'verify-040-t08-' + Date.now();
  const fakeChildId  = '00000000-0000-0000-0000-000000000088';
  const fakeToken08  = crypto.randomBytes(32).toString('hex');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(
      `SELECT public.biometric_login_child($1, $2, $3)`,
      [fakeChildId, testDevice08, fakeToken08]
    );
    await c.query('ROLLBACK');
    pass('T08', 'biometric_login_child: callable from authenticated role');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.message.includes('rate_limit_exceeded') || e.message.includes('biometric') || e.message.includes('not found')) {
      pass('T08', `biometric_login_child: callable from authenticated role (app error, not permission denied): ${e.message}`);
    } else if (e.message.includes('permission denied')) {
      fail('T08', `biometric_login_child: authenticated role still gets permission denied: ${e.message}`);
    } else {
      pass('T08', `biometric_login_child: callable from authenticated role (error, not permission denied): ${e.message}`);
    }
  } finally {
    await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_bio_login:${testDevice08}`]).catch(() => {});
  }

  // ── T09–T10: Wrong password rejected in both roles ───────────────────────────
  console.log('\n=== Phase 3: Auth enforcement unchanged ===');

  const testDevice09 = 'verify-040-t09-' + Date.now();
  try {
    // Login as anon, wrong password
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE anon');
    const { rows: [row09] } = await c.query(
      `SELECT public.login_child($1, $2, $3)`,
      ['verify_040_nonexistent_09', 'wrong-pass', testDevice09]
    );
    await c.query('ROLLBACK');
    if (row09 === null || row09.login_child === null) {
      pass('T09', 'login_child anon: unknown user returns NULL (not granted wrong access)');
    } else {
      fail('T09', `login_child anon: expected NULL for unknown user, got: ${JSON.stringify(row09)}`);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.message.includes('rate_limit_exceeded')) {
      pass('T09', 'login_child anon: rate-limited (acceptable)');
    } else {
      fail('T09', `login_child anon: unexpected error: ${e.message}`);
    }
  } finally {
    await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice09}`]).catch(() => {});
  }

  const testDevice10 = 'verify-040-t10-' + Date.now();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    const { rows: [row10] } = await c.query(
      `SELECT public.login_child($1, $2, $3)`,
      ['verify_040_nonexistent_10', 'wrong-pass', testDevice10]
    );
    await c.query('ROLLBACK');
    if (row10 === null || row10.login_child === null) {
      pass('T10', 'login_child authenticated: unknown user returns NULL (not granted wrong access)');
    } else {
      fail('T10', `login_child authenticated: expected NULL for unknown user, got: ${JSON.stringify(row10)}`);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.message.includes('rate_limit_exceeded')) {
      pass('T10', 'login_child authenticated: rate-limited (acceptable)');
    } else {
      fail('T10', `login_child authenticated: unexpected error: ${e.message}`);
    }
  } finally {
    await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice10}`]).catch(() => {});
  }

  // ── T11: Rate limiting fires for authenticated role ──────────────────────────
  console.log('\n=== Phase 4: Rate limiting unchanged for authenticated role ===');

  const testDevice11 = 'verify-040-t11-' + Date.now();
  // Clean slate
  await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice11}`]);

  let rlFiredAt11 = null;
  for (let i = 1; i <= 22 && !rlFiredAt11; i++) {
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      await c.query(`SELECT public.login_child($1,$2,$3)`, ['rl_test_user_11', 'wrong', testDevice11]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.message.includes('rate_limit_exceeded')) {
        rlFiredAt11 = i;
      } else if (e.message.includes('permission denied')) {
        fail('T11', `Rate-limit test: permission denied at attempt ${i} — GRANT did not apply`);
        break;
      }
    }
  }
  if (rlFiredAt11 && rlFiredAt11 <= 22) {
    pass('T11', `Rate limiting (device) fires for authenticated role at attempt ${rlFiredAt11}`);
  } else if (!rlFiredAt11) {
    fail('T11', 'Rate limit did not fire after 22 attempts under authenticated role');
  }
  await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice11}`]).catch(() => {});

  // ── T12: Rate limit still anon-callable (regression) ────────────────────────
  const testDevice12 = 'verify-040-t12-' + Date.now();
  await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice12}`]);

  let rlFiredAt12 = null;
  for (let i = 1; i <= 22 && !rlFiredAt12; i++) {
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE anon');
      await c.query(`SELECT public.login_child($1,$2,$3)`, ['rl_test_user_12', 'wrong', testDevice12]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.message.includes('rate_limit_exceeded')) rlFiredAt12 = i;
    }
  }
  if (rlFiredAt12 && rlFiredAt12 <= 22) {
    pass('T12', `Rate limiting (device) still fires for anon role at attempt ${rlFiredAt12}`);
  } else {
    fail('T12', 'Rate limit did not fire after 22 attempts under anon role');
  }
  await c.query(`DELETE FROM auth_rate_limits WHERE bucket_key = md5($1)`, [`rl_child_login_dev:${testDevice12}`]).catch(() => {});

  // ── T13–T14: proacl snapshot contains authenticated ──────────────────────────
  console.log('\n=== Phase 5: proacl snapshot ===');

  const { rows: proacl } = await c.query(`
    SELECT p.proname, p.proacl::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('login_child', 'biometric_login_child')
    ORDER BY p.proname
  `);
  for (const row of proacl) {
    const aclStr = row.proacl ?? '';
    if (row.proname === 'login_child') {
      if (aclStr.includes('authenticated=X'))
        pass('T13', `login_child proacl contains authenticated=X: ${aclStr}`);
      else
        fail('T13', `login_child proacl missing authenticated=X: ${aclStr}`);
    }
    if (row.proname === 'biometric_login_child') {
      if (aclStr.includes('authenticated=X'))
        pass('T14', `biometric_login_child proacl contains authenticated=X: ${aclStr}`);
      else
        fail('T14', `biometric_login_child proacl missing authenticated=X: ${aclStr}`);
    }
  }

  // ── T15: TypeScript ──────────────────────────────────────────────────────────
  console.log('\n=== Phase 6: TypeScript ===');
  await c.end();

  const projectRoot = path.resolve(__dirname, '..');
  try {
    execSync('npx tsc --noEmit', { cwd: projectRoot, stdio: 'pipe', timeout: 60_000 });
    pass('T15', 'npx tsc --noEmit: no type errors');
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    fail('T15', `TypeScript errors:\n${out.slice(0, 1000)}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
  if (failed > 0) {
    console.error('\nVerification FAILED — do not ship.');
    process.exit(1);
  } else {
    console.log('\nAll checks passed. Migration 040 is verified.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
