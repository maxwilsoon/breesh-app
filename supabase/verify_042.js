#!/usr/bin/env node
'use strict';
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

const SECRET = process.env.NOTIFICATION_SECRET;
if (!SECRET) throw new Error('NOTIFICATION_SECRET not set');
const SUPABASE_URL = 'https://biilrksornvoqtalftty.supabase.co';

let pass = 0;
let fail = 0;
function ok(label)         { console.log(`  PASS  ${label}`); pass++; }
function ko(label, detail) { console.log(`  FAIL  ${label} — ${detail}`); fail++; }

async function callEdge(body, secret = SECRET) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-notification-secret': secret },
    body:    JSON.stringify(body),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

(async () => {
  await PG.connect();
  console.log('\n=== M042 Verification ===\n');

  // T01: _notification_settings table exists
  const { rows: [t1] } = await PG.query(
    `SELECT to_regclass('public._notification_settings') AS tbl`
  );
  if (t1.tbl) ok('T01 _notification_settings table exists');
  else         ko('T01 _notification_settings table exists', 'table missing');

  // T02: secret is present in the table
  const { rows: [t2] } = await PG.query(
    `SELECT value FROM public._notification_settings WHERE key = 'notification_secret'`
  );
  if (t2?.value === SECRET) ok('T02 notification_secret value correct');
  else                       ko('T02 notification_secret value correct', `got: ${t2?.value?.slice(0,8) ?? 'null'}...`);

  // T03: RLS is enabled on _notification_settings
  const { rows: [t3] } = await PG.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = '_notification_settings' AND relnamespace = 'public'::regnamespace`
  );
  if (t3?.relrowsecurity) ok('T03 RLS enabled on _notification_settings');
  else                     ko('T03 RLS enabled on _notification_settings', 'RLS not enabled');

  // T04: anon cannot SELECT from _notification_settings
  const { rows: [t4] } = await PG.query(
    `SELECT has_table_privilege('anon', 'public._notification_settings', 'SELECT') AS ok`
  );
  if (!t4?.ok) ok('T04 anon cannot SELECT _notification_settings');
  else          ko('T04 anon cannot SELECT _notification_settings', 'anon has SELECT — secret leakage risk');

  // T05: _trigger_notification body reads from _notification_settings
  const { rows: [t5] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification' AND pronargs = 6 LIMIT 1`
  );
  const src5 = t5?.prosrc ?? '';
  if (src5.includes('_notification_settings')) ok('T05 _trigger_notification reads from _notification_settings');
  else                                          ko('T05 _trigger_notification reads from _notification_settings', 'still uses current_setting');
  if (!src5.includes('current_setting'))        ok('T05b _trigger_notification no longer uses current_setting');
  else                                           ko('T05b _trigger_notification no longer uses current_setting', 'current_setting still present');

  // T06: _trigger_notification_multi body reads from _notification_settings
  const { rows: [t6] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification_multi' LIMIT 1`
  );
  const src6 = t6?.prosrc ?? '';
  if (src6.includes('_notification_settings')) ok('T06 _trigger_notification_multi reads from _notification_settings');
  else                                          ko('T06 _trigger_notification_multi reads from _notification_settings', 'still uses current_setting');

  // T07: Edge Function is deployed (responds 401 on wrong secret, not 404)
  const r7 = await callEdge({ type: 'probe' }, 'wrong-secret');
  if (r7.status === 401) ok('T07 Edge Function deployed and reachable (401 on bad secret)');
  else                    ko('T07 Edge Function deployed and reachable', `status=${r7.status} — function may not be deployed`);

  // T08: Edge Function returns 401 on empty secret
  const r8 = await callEdge({ type: 'probe' }, '');
  if (r8.status === 401) ok('T08 Edge Function rejects empty secret');
  else                    ko('T08 Edge Function rejects empty secret', `status=${r8.status}`);

  // T09: Edge Function returns no_recipients for empty payload with correct secret
  // (This proves the NOTIFICATION_SECRET env var in the Edge Function matches the DB value)
  const r9 = await callEdge({ type: 'probe', recipient_id: '' });
  if (r9.status === 200 && (r9.data?.reason === 'no_recipients' || r9.data?.sent === 0)) {
    ok('T09 Edge Function NOTIFICATION_SECRET matches DB secret (correct secret accepted)');
  } else if (r9.status === 401) {
    ko('T09 Edge Function NOTIFICATION_SECRET matches DB secret',
       'Edge Function returned 401 — NOTIFICATION_SECRET env var in Edge Function does NOT match DB value. ' +
       'Go to Dashboard → Edge Functions → send-notification → Secrets and set: ' +
       'value intentionally not shown — set it in the Dashboard to match your own ' +
       'process.env.NOTIFICATION_SECRET; do not print it.');
  } else {
    ko('T09 Edge Function NOTIFICATION_SECRET matches DB secret', `unexpected: ${JSON.stringify(r9.data)}`);
  }

  // T10: device_tokens table accessible
  const { rows: [t10] } = await PG.query(
    `SELECT count(*) AS n FROM device_tokens WHERE active = true`
  );
  console.log(`\n  INFO  Active device tokens: ${t10.n}`);
  if (Number(t10.n) > 0) ok('T10 active device tokens exist');
  else                    ko('T10 active device tokens exist', 'no active tokens — no child has registered a push token');

  // T11: _trigger_notification and _trigger_notification_multi are NOT callable by anon/authenticated
  const { rows: [ta] } = await PG.query(
    `SELECT has_function_privilege('anon', 'public._trigger_notification(text,uuid,text,uuid,text,jsonb)', 'EXECUTE') AS ok`
  );
  const { rows: [tb] } = await PG.query(
    `SELECT has_function_privilege('authenticated', 'public._trigger_notification(text,uuid,text,uuid,text,jsonb)', 'EXECUTE') AS ok`
  );
  if (!ta.ok && !tb.ok) ok('T11 _trigger_notification locked to internal callers only');
  else                   ko('T11 _trigger_notification locked to internal callers only',
                            `anon=${ta.ok} auth=${tb.ok} — should both be false`);

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nREMINDER: You must also set the Edge Function secret in the Supabase Dashboard:');
    console.log('  Dashboard → Edge Functions → send-notification → Secrets');
    console.log('  NOTIFICATION_SECRET: value intentionally not printed — set it via Supabase Dashboard → Edge Functions → Secrets.');
    console.log('Then redeploy: supabase functions deploy send-notification --no-verify-jwt');
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
