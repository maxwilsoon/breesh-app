#!/usr/bin/env node
'use strict';
// Verify M041: authenticated grants on all client-callable child RPCs

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

const SUPABASE_URL = 'https://biilrksornvoqtalftty.supabase.co';
const ANON_KEY     = 'sb_publishable_WFy3MKZimL3OcD35Tn6QBQ_jxzMaUCw';

async function callRpc(name, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` },
    body:    JSON.stringify(body),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

// The 28 functions that must now have authenticated EXECUTE
// has_function_privilege requires type-only signatures (no parameter names)
const CHILD_RPCS = [
  ['revoke_child_session',          'text'],
  ['search_children',               'text, uuid, text, text'],
  ['get_circle',                    'uuid, text, text'],
  ['get_circle_history',            'uuid, text, text'],
  ['get_outgoing_pending_requests', 'uuid, text, text'],
  ['get_pending_requests',          'uuid, text, text'],
  ['send_circle_request',           'uuid, uuid, text, text'],
  ['accept_circle_request',         'uuid, uuid, text, text'],
  ['cancel_circle_request',         'uuid, uuid, text, text'],
  ['decline_circle_request',        'uuid, uuid, text, text'],
  ['remove_from_circle',            'uuid, uuid, text, text'],
  ['get_active_requests',           'uuid, text, text'],
  ['get_resolved_sent_requests',    'uuid, text, text'],
  ['create_money_request',          'uuid, numeric, integer, text, text, text, text, uuid[]'],
  ['cancel_money_request',          'uuid, uuid, text, text'],
  ['fund_money_request',            'uuid, uuid, numeric, text, text'],
  ['repay_money_request',           'uuid, uuid, text, text'],
  ['get_child_stats',               'uuid, text, text'],
  ['get_child_transactions',        'uuid, text, text, integer'],
  ['get_activity_feed',             'uuid, text, text, integer'],
  ['get_loan_history',              'uuid, text, text'],
  ['enable_biometric',              'uuid, text, text, text'],
  ['disable_biometric',             'uuid, text, text'],
  ['register_child_device_token',   'uuid, text, text, text, text, text'],
  ['deregister_child_device_token', 'text, uuid, text, text'],
  ['update_profile_image',          'uuid, text, text, text'],
  ['record_weekly_streak',          'uuid'],
  ['check_streak_expiry',           'uuid'],
];

let pass = 0;
let fail = 0;

function ok(label) { console.log(`  PASS  ${label}`); pass++; }
function ko(label, detail) { console.log(`  FAIL  ${label} — ${detail}`); fail++; }

(async () => {
  await PG.connect();

  console.log('\n=== M041 Verification ===\n');

  // T01–T28: authenticated grant present on each child RPC
  for (const [name, args] of CHILD_RPCS) {
    const { rows: [r] } = await PG.query(
      `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS ok`,
      [`public.${name}(${args})`]
    );
    if (r.ok) ok(`T authenticated EXECUTE: ${name}`);
    else      ko(`T authenticated EXECUTE: ${name}`, 'grant missing');
  }

  // T29: anon grant still present on key child RPCs (must not have been revoked)
  const anonSample = [
    ['search_children',    'text, uuid, text, text'],
    ['get_circle',         'uuid, text, text'],
    ['get_activity_feed',  'uuid, text, text, integer'],
    ['send_circle_request','uuid, uuid, text, text'],
  ];
  for (const [name, args] of anonSample) {
    const { rows: [r] } = await PG.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok`,
      [`public.${name}(${args})`]
    );
    if (r.ok) ok(`T anon EXECUTE preserved: ${name}`);
    else      ko(`T anon EXECUTE preserved: ${name}`, 'anon grant was lost');
  }

  // T33: streak functions now have anon too
  for (const fn of ['record_weekly_streak(uuid)', 'check_streak_expiry(uuid)']) {
    const { rows: [r] } = await PG.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok`, [`public.${fn}`]);
    if (r.ok) ok(`T anon EXECUTE: ${fn.split('(')[0]}`);
    else      ko(`T anon EXECUTE: ${fn.split('(')[0]}`, 'grant missing');
  }

  // T35: REST API: search_children with anon key + fake session returns invalid_child_session (NOT 42501)
  const r35 = await callRpc('search_children', { p_query: 'test', p_exclude_id: '00000000-0000-0000-0000-000000000000', p_session_token: 'fake', p_device_id: 'fake' });
  if (r35.data?.message === 'invalid_child_session' || r35.data?.code === 'P0001') {
    ok('T35 search_children (anon key, bad session) → invalid_child_session, not 42501');
  } else {
    ko('T35 search_children (anon key, bad session)', `unexpected: ${JSON.stringify(r35.data)}`);
  }

  // T36: parent-only functions have NOT gained authenticated grant from this migration
  // (ensure no regressions — these already had it from M036-M040)
  const parentFns = [
    ['set_parent_passcode', 'uuid, text'],
    ['verify_parent_passcode', 'uuid, text'],
  ];
  for (const [name, args] of parentFns) {
    const { rows: [r] } = await PG.query(
      `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS ok`,
      [`public.${name}(${args})`]
    );
    if (r.ok) ok(`T parent RPC still has auth EXECUTE: ${name}`);
    else      ko(`T parent RPC auth EXECUTE missing: ${name}`, 'parent regression');
  }

  // T38: internal helpers still NOT callable by anon or authenticated
  // _rl_attempt(text, text, integer, interval, interval), require_valid_child_session(uuid, text, text)
  const internalFns = [['_rl_attempt', 'text, text, integer, interval, interval'], ['require_valid_child_session', 'uuid, text, text']];
  for (const [name, args] of internalFns) {
    const { rows: [ra] } = await PG.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok`, [`public.${name}(${args})`]);
    const { rows: [rb] } = await PG.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS ok`, [`public.${name}(${args})`]);
    if (!ra.ok && !rb.ok) ok(`T internal function locked down: ${name}`);
    else                  ko(`T internal function ${name}`, `anon=${ra.ok} auth=${rb.ok} — should both be false`);
  }

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
