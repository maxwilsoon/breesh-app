/**
 * verify_034.js — 30 tests for migration 034 (bcrypt passcode + column-protection trigger)
 *
 * Runs as the postgres superuser.  Uses BEGIN/SET LOCAL/ROLLBACK blocks to simulate
 * authenticated JWT calls where needed.  Helper functions that install or clear test
 * hashes temporarily set truzo.allow_passcode_write at session level (then reset it)
 * so they can bypass the trigger for controlled test setup only.
 *
 * Tests:
 *   V1        Migration: force-reset applied correctly
 *   V2        set_parent_passcode stores a valid bcrypt hash
 *   V3–V9     set_parent_passcode validation errors (format, weak PINs)
 *   V10/V24   Caller-identity guard (Parent A cannot set Parent B's PIN)
 *   V11       verify_parent_passcode returns true for correct PIN
 *   V12       verify_parent_passcode returns false for wrong PIN
 *   V13       verify_parent_passcode returns false for null hash
 *   V14       Rate limit: 5 wrong attempts allowed; 6th raises rate_limit_exceeded
 *   V15       Rate limit: correct PIN while locked still raises rate_limit_exceeded
 *   V16       Rate limit: correct PIN before threshold clears the counter
 *   V17       set_parent_passcode not callable by anon
 *   V18       get_parent_passcode_status does not exist
 *   V19       verify_parent_passcode callable by anon
 *   V20       verify_parent_passcode does not return passcode_hash
 *   V21       Unknown UUID and wrong PIN produce same false return
 *   V22       SHA-256 format hash returns false without exception
 *   V23       No endpoint reveals passcode configuration to arbitrary callers
 *   V25       Family-switch note (client-side; documented below)
 *   V26       Rollback does not restore SHA-256 (separate manual test)
 *   V27       Normal profile update (marketing_notifications) succeeds
 *   V28       Direct passcode_hash UPDATE blocked by trigger
 *   V29       set_parent_passcode UPDATE passes through trigger
 *   V30       verify_parent_passcode works after trigger is installed
 */

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const DB = { connectionString: DATABASE_URL };

const TEST_PIN   = '246813';  // valid 6-digit, not in weak list
const WRONG_PIN  = '135792';
const SHA256_HEX = 'a'.repeat(64); // simulates a legacy SHA-256 hash

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  failed++;
}

async function check(label, condition, detail = '') {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail || 'assertion failed');
  }
}

async function mustThrow(c, label, sql, params, expectedMsg) {
  try {
    await c.query(sql, params);
    fail(label, `expected exception containing '${expectedMsg}' but no error was raised`);
  } catch (e) {
    if (e.message.includes(expectedMsg)) {
      pass(label);
    } else {
      fail(label, `expected '${expectedMsg}' but got: ${e.message}`);
    }
  }
}

// Run fn inside BEGIN/SET LOCAL JWT/... and COMMIT or ROLLBACK on error.
// Returns { ok: true, result } or { ok: false, error: message }.
async function asParent(c, parentId, fn) {
  const claims = JSON.stringify({ sub: parentId, role: 'authenticated' }).replace(/'/g, "''");
  await c.query('BEGIN');
  await c.query(`SET LOCAL "request.jwt.claims" = '${claims}'`);
  try {
    const result = await fn();
    await c.query('COMMIT');
    return { ok: true, result };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    return { ok: false, error: e.message };
  }
}

// Install a bcrypt test hash, bypassing the trigger via session-level flag.
async function installTestHash(c, parentId, pin) {
  await c.query("SET truzo.allow_passcode_write = 'true'");
  await c.query(`
    UPDATE public.parents
    SET passcode_hash       = crypt($2, gen_salt('bf', 10)),
        passcode_created    = true,
        passcode_created_at = now()
    WHERE id = $1
  `, [parentId, pin]);
  await c.query('RESET truzo.allow_passcode_write');
}

// Install a raw string as passcode_hash (for testing malformed-hash handling).
async function installRawHash(c, parentId, rawHash) {
  await c.query("SET truzo.allow_passcode_write = 'true'");
  await c.query(`
    UPDATE public.parents
    SET passcode_hash       = $2,
        passcode_created    = true,
        passcode_created_at = now()
    WHERE id = $1
  `, [parentId, rawHash]);
  await c.query('RESET truzo.allow_passcode_write');
}

// Reset passcode fields for a parent, bypassing trigger.
async function clearTestHash(c, parentId) {
  await c.query("SET truzo.allow_passcode_write = 'true'");
  await c.query(`
    UPDATE public.parents
    SET passcode_hash = NULL, passcode_created = false, passcode_created_at = NULL
    WHERE id = $1
  `, [parentId]);
  await c.query('RESET truzo.allow_passcode_write');
}

// Clear rate limit for a parent.
async function clearRateLimit(c, parentId) {
  await c.query(`SELECT _rl_clear('rl_parent_passcode', $1::text)`, [parentId]);
  await c.query(`SELECT _rl_clear('rl_set_passcode',    $1::text)`, [parentId]);
}

(async () => {
  const c = new Client(DB);
  await c.connect();

  console.log('\n── Fetching test parents');
  const { rows: parents } = await c.query('SELECT id FROM public.parents ORDER BY id LIMIT 2');
  if (parents.length < 2) {
    console.error('Need at least 2 parent rows in DB.  Found:', parents.length);
    process.exit(1);
  }
  const [parentA, parentB] = [parents[0].id, parents[1].id];
  console.log(`  parentA: ${parentA.slice(0, 8)}…`);
  console.log(`  parentB: ${parentB.slice(0, 8)}…`);

  // ── V1: Force-reset applied correctly ────────────────────────────────────────
  console.log('\n── V1  Migration: force-reset');
  {
    const { rows } = await c.query(`
      SELECT COUNT(*) FILTER (WHERE passcode_hash IS NOT NULL) AS with_hash,
             COUNT(*) FILTER (WHERE passcode_created = true)   AS created_true
      FROM public.parents
    `);
    await check('V1a — passcode_hash is NULL for all parents',  rows[0].with_hash    === '0', `with_hash=${rows[0].with_hash}`);
    await check('V1b — passcode_created is false for all parents', rows[0].created_true === '0', `created_true=${rows[0].created_true}`);
  }

  // ── V2: set_parent_passcode stores a valid bcrypt hash ────────────────────────
  console.log('\n── V2  set_parent_passcode: bcrypt hash stored');
  {
    const res = await asParent(c, parentA, async () => {
      await c.query('SELECT set_parent_passcode($1, $2)', [parentA, TEST_PIN]);
      const { rows } = await c.query(
        `SELECT left(passcode_hash, 7) AS prefix, length(passcode_hash) AS len, passcode_created
         FROM public.parents WHERE id = $1`, [parentA]);
      return rows[0];
    });
    await check('V2a — set_parent_passcode succeeded',    res.ok, res.error);
    if (res.ok) {
      await check('V2b — hash has bcrypt prefix ($2a/b/y)', res.result.prefix.startsWith('$2'), `prefix=${res.result.prefix}`);
      await check('V2c — hash length is 60',               res.result.len === 60,               `len=${res.result.len}`);
      await check('V2d — passcode_created is true',        res.result.passcode_created === true, `passcode_created=${res.result.passcode_created}`);
    }
  }
  // parentA now has TEST_PIN hash in DB (committed by asParent).
  // Clear rate limit so subsequent tests start clean.
  await clearRateLimit(c, parentA);

  // ── V3–V9: Validation errors ──────────────────────────────────────────────────
  console.log('\n── V3–V9  set_parent_passcode: validation errors');
  const validationCases = [
    ['V3',  '12345',    'invalid_pin_format', '5-digit PIN rejected'],
    ['V4',  '1234567',  'invalid_pin_format', '7-digit PIN rejected'],
    ['V5',  '12345a',   'invalid_pin_format', 'alphanumeric PIN rejected'],
    ['V6',  '000000',   'weak_pin',           'weak PIN 000000 rejected'],
    ['V7',  '111111',   'weak_pin',           'weak PIN 111111 rejected'],
    ['V8',  '123456',   'weak_pin',           'weak PIN 123456 rejected'],
    ['V9',  '654321',   'weak_pin',           'weak PIN 654321 rejected'],
  ];
  for (const [label, pin, errFragment, desc] of validationCases) {
    const res = await asParent(c, parentA, async () => {
      await c.query('SELECT set_parent_passcode($1, $2)', [parentA, pin]);
    });
    await check(`${label} — ${desc}`, !res.ok && res.error.includes(errFragment),
      res.ok ? 'no error raised' : `error: ${res.error}`);
  }

  // ── V10/V24: Caller-identity guard ────────────────────────────────────────────
  console.log('\n── V10/V24  Caller-identity guard: Parent A cannot set Parent B\'s PIN');
  {
    // JWT says auth.uid() = parentA, but we pass parentB as the target.
    const res = await asParent(c, parentA, async () => {
      await c.query('SELECT set_parent_passcode($1, $2)', [parentB, TEST_PIN]);
    });
    await check('V10 — unauthorized when parentA tries to write parentB\'s passcode',
      !res.ok && res.error.includes('unauthorized'),
      res.ok ? 'no error raised' : `error: ${res.error}`);
  }

  // ── V11: correct PIN returns true ─────────────────────────────────────────────
  console.log('\n── V11  verify_parent_passcode: correct PIN returns true');
  {
    // parentA hash was installed by V2.
    const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, TEST_PIN]);
    await check('V11 — correct PIN returns true', rows[0].verify_parent_passcode === true,
      `got ${rows[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentA);
  }

  // ── V12: wrong PIN returns false ──────────────────────────────────────────────
  console.log('\n── V12  verify_parent_passcode: wrong PIN returns false');
  {
    const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
    await check('V12 — wrong PIN returns false', rows[0].verify_parent_passcode === false,
      `got ${rows[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentA);
  }

  // ── V13: null hash (passcode not configured) returns false ────────────────────
  console.log('\n── V13  verify_parent_passcode: null hash returns false');
  {
    // parentB has null hash (never set).
    const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentB, TEST_PIN]);
    await check('V13 — null hash returns false', rows[0].verify_parent_passcode === false,
      `got ${rows[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentB);
  }

  // ── V14: rate limit — 5 wrong attempts allowed, 6th raises exception ──────────
  console.log('\n── V14  Rate limit: 5 attempts allowed, 6th raises rate_limit_exceeded');
  {
    // parentA still has TEST_PIN hash from V2.
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
      if (rows[0].verify_parent_passcode === false) allowed++;
    }
    await check('V14a — 5 wrong attempts return false (not throttled)', allowed === 5,
      `only ${allowed}/5 returned false`);

    // 6th attempt should be throttled.
    try {
      await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
      fail('V14b — 6th attempt should raise rate_limit_exceeded', 'no error raised');
    } catch (e) {
      await check('V14b — 6th attempt raises rate_limit_exceeded',
        e.message.includes('rate_limit_exceeded'), `got: ${e.message}`);
    }
  }

  // ── V15: correct PIN during active lock still raises rate_limit_exceeded ───────
  console.log('\n── V15  Rate limit: correct PIN while locked raises rate_limit_exceeded');
  {
    // parentA is locked from V14.
    try {
      await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, TEST_PIN]);
      fail('V15 — should raise rate_limit_exceeded while locked', 'no error raised');
    } catch (e) {
      await check('V15 — correct PIN during lock raises rate_limit_exceeded',
        e.message.includes('rate_limit_exceeded'), `got: ${e.message}`);
    }
  }
  await clearRateLimit(c, parentA);

  // ── V16: correct PIN before threshold clears the counter ─────────────────────
  console.log('\n── V16  Rate limit: correct PIN before threshold clears counter');
  {
    // Make 2 wrong attempts to create a rate-limit entry.
    await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
    await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
    // Correct PIN should return true and clear the counter.
    const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, TEST_PIN]);
    await check('V16a — correct PIN returns true', rows[0].verify_parent_passcode === true,
      `got ${rows[0].verify_parent_passcode}`);
    // Verify rate limit row was deleted.
    const { rows: rlRows } = await c.query(`
      SELECT * FROM public.auth_rate_limits
      WHERE scope = 'rl_parent_passcode'
        AND bucket_key = md5('rl_parent_passcode:' || $1::text)
    `, [parentA]);
    await check('V16b — rate limit entry cleared after correct PIN', rlRows.length === 0,
      `found ${rlRows.length} row(s)`);
  }

  // ── V17: set_parent_passcode not callable by anon ─────────────────────────────
  console.log('\n── V17  Grant: set_parent_passcode not callable by anon');
  {
    const { rows } = await c.query(`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE specific_schema = 'public' AND routine_name = 'set_parent_passcode'
        AND grantee = 'anon'
    `);
    await check('V17 — anon has no EXECUTE on set_parent_passcode', rows.length === 0,
      `found grant to anon`);
  }

  // ── V18: get_parent_passcode_status does not exist ────────────────────────────
  console.log('\n── V18  get_parent_passcode_status removed');
  {
    const { rows } = await c.query(`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'get_parent_passcode_status'
    `);
    await check('V18 — get_parent_passcode_status does not exist', rows.length === 0,
      `function exists`);
  }

  // ── V19: verify_parent_passcode callable by anon ─────────────────────────────
  console.log('\n── V19  Grant: verify_parent_passcode callable by anon');
  {
    const { rows } = await c.query(`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE specific_schema = 'public' AND routine_name = 'verify_parent_passcode'
        AND grantee = 'anon'
    `);
    await check('V19 — anon has EXECUTE on verify_parent_passcode', rows.length > 0,
      `anon grant missing`);
  }

  // ── V20: verify_parent_passcode does not return passcode_hash ────────────────
  console.log('\n── V20  verify_parent_passcode return type is boolean (no hash exposure)');
  {
    const { rows } = await c.query(`
      SELECT pg_get_function_result(oid) AS return_type
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname = 'verify_parent_passcode'
    `);
    await check('V20 — return type is boolean', rows[0]?.return_type === 'boolean',
      `got ${rows[0]?.return_type}`);
  }

  // ── V21: unknown UUID and wrong PIN return identical false ────────────────────
  console.log('\n── V21  Enumeration: unknown UUID and wrong PIN return identical false');
  {
    const unknownUUID = '00000000-0000-0000-0000-000000000000';
    const { rows: r1 } = await c.query('SELECT verify_parent_passcode($1, $2)', [unknownUUID, WRONG_PIN]);
    const { rows: r2 } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
    await check('V21 — unknown UUID returns false',     r1[0].verify_parent_passcode === false, `got ${r1[0].verify_parent_passcode}`);
    await check('V21 — wrong PIN on known UUID returns false', r2[0].verify_parent_passcode === false, `got ${r2[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentA);
    // Rate limit on unknownUUID doesn't need clearing — it's a throwaway UUID.
  }

  // ── V22: SHA-256 format hash returns false without exception ──────────────────
  console.log('\n── V22  Malformed hash: SHA-256 hex returns false (no exception)');
  {
    // parentB has no hash; install a 64-char hex string directly.
    await installRawHash(c, parentB, SHA256_HEX);
    const { rows } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentB, TEST_PIN]);
    await check('V22 — SHA-256 hex hash returns false without exception',
      rows[0].verify_parent_passcode === false, `got ${rows[0].verify_parent_passcode}`);
    await clearTestHash(c, parentB);
    await clearRateLimit(c, parentB);
  }

  // ── V23: no endpoint leaks passcode configuration state ──────────────────────
  console.log('\n── V23  No status endpoint leaks passcode configuration');
  {
    // V18 confirmed get_parent_passcode_status does not exist.
    // verify_parent_passcode returns false for both null hash (V13) and wrong PIN (V12)
    // — already confirmed.  Check no other passcode-status function was added.
    const { rows } = await c.query(`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname ILIKE '%passcode%status%'
    `);
    await check('V23 — no passcode status function exists', rows.length === 0,
      `found: ${rows.map(r => r.proname).join(', ')}`);
  }

  // ── V27: normal profile update succeeds (trigger does not block it) ───────────
  console.log('\n── V27  Trigger: normal profile update succeeds');
  {
    await c.query('BEGIN');
    try {
      await c.query(
        `UPDATE public.parents SET marketing_notifications = NOT COALESCE(marketing_notifications, false) WHERE id = $1`,
        [parentA]
      );
      await c.query('ROLLBACK');  // restore original value
      pass('V27 — UPDATE to marketing_notifications succeeded (trigger did not block)');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch {}
      fail('V27 — normal profile UPDATE unexpectedly blocked', e.message);
    }
  }

  // ── V28: direct passcode_hash UPDATE blocked by trigger ──────────────────────
  console.log('\n── V28  Trigger: direct passcode_hash UPDATE blocked');
  {
    await c.query('BEGIN');
    try {
      await c.query(`UPDATE public.parents SET passcode_hash = 'x' WHERE id = $1`, [parentA]);
      await c.query('ROLLBACK');
      fail('V28 — direct passcode_hash UPDATE should have been blocked', 'no error raised');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch {}
      await check('V28 — direct passcode_hash UPDATE raises exception',
        e.message.includes('set_parent_passcode'), `error: ${e.message}`);
    }
  }

  // ── V29: set_parent_passcode UPDATE passes through trigger ────────────────────
  console.log('\n── V29  Trigger: set_parent_passcode succeeds (sets allow flag)');
  {
    // parentA's hash was committed by V2/V11 etc; clear it first so V29 is a clean create.
    await clearTestHash(c, parentA);
    await clearRateLimit(c, parentA);

    const res = await asParent(c, parentA, async () => {
      await c.query('SELECT set_parent_passcode($1, $2)', [parentA, TEST_PIN]);
      const { rows } = await c.query(
        `SELECT passcode_created, left(passcode_hash, 3) AS prefix FROM public.parents WHERE id = $1`,
        [parentA]);
      return rows[0];
    });
    await check('V29a — set_parent_passcode succeeded through trigger', res.ok, res.error);
    if (res.ok) {
      await check('V29b — hash starts with $2', res.result.prefix === '$2b' || res.result.prefix.startsWith('$2'),
        `prefix=${res.result.prefix}`);
      await check('V29c — passcode_created=true', res.result.passcode_created === true,
        `passcode_created=${res.result.passcode_created}`);
    }
    await clearRateLimit(c, parentA);
  }

  // ── V30: verify_parent_passcode works correctly after trigger is installed ────
  console.log('\n── V30  verify_parent_passcode correct after trigger installation');
  {
    // parentA has TEST_PIN hash from V29.
    const { rows: r1 } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, TEST_PIN]);
    await check('V30a — correct PIN returns true',  r1[0].verify_parent_passcode === true,
      `got ${r1[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentA);

    const { rows: r2 } = await c.query('SELECT verify_parent_passcode($1, $2)', [parentA, WRONG_PIN]);
    await check('V30b — wrong PIN returns false', r2[0].verify_parent_passcode === false,
      `got ${r2[0].verify_parent_passcode}`);
    await clearRateLimit(c, parentA);
  }

  // ── V25 / V26: manual-only tests ─────────────────────────────────────────────
  console.log('\n── V25/V26  Manual tests (not exercised by this script)');
  console.log('  V25 — Family switch: setLastParentForPasscode() overwrites LAST_PARENT_KEY');
  console.log('        in SecureStore so a subsequent cold start uses the new parent UUID.');
  console.log('        Verified by reading SecureStore in a device test after two parent logins.');
  console.log('  V26 — Rollback: apply 034_rollback.sql, then confirm verify_parent_passcode');
  console.log('        returns false for the correct PIN and set_parent_passcode no longer exists.');
  console.log('        Run in a separate environment — re-applying 034 after rollback is required.');

  // ── Final cleanup ─────────────────────────────────────────────────────────────
  await clearTestHash(c, parentA);
  await clearTestHash(c, parentB);
  await clearRateLimit(c, parentA);
  await clearRateLimit(c, parentB);

  await c.end();

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  const total = passed + failed;
  console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) {
    console.error('One or more tests failed.');
    process.exit(1);
  } else {
    console.log('All tests passed.');
  }
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
