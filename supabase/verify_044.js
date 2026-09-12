#!/usr/bin/env node
'use strict';
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

const SECRET       = 'f490fb11cf23733f430d99ab3c3f31baca9113680287654b1ce997c42d67bfde';
const SUPABASE_URL = 'https://biilrksornvoqtalftty.supabase.co';
// Known UUIDs from the investigation
const DAISY_UID = 'ac504406-e1e7-4b28-87e3-2a39ab58ee08';
const ALEX_UID  = '90d87b6f-e78c-44f4-a01c-e4f5a1ad8cc2';
const MAYA_UID  = '3de8d467-9dbe-4b08-a6b4-8ade697c0dd6';
const MUM_UID   = '5b5d05d5-d04f-4a9f-8e90-50f67ae8d5cf';

let pass = 0;
let fail = 0;
function ok(label)         { console.log(`  PASS  ${label}`); pass++; }
function ko(label, detail) { console.log(`  FAIL  ${label} — ${detail}`); fail++; }

async function callEdge(body, secret = SECRET) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-notification-secret': secret },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(45_000),  // 45s — covers the 15s receipt wait + margin
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

// Small delay between tests that trigger real pushes (each takes ~15s for receipt check)
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await PG.connect();

  // Resolve real UUIDs from DB (don't hardcode — use names to look up)
  const { rows: children } = await PG.query(
    `SELECT id, display_name FROM children ORDER BY display_name`
  );
  const byName = {};
  children.forEach(r => { byName[r.display_name] = r.id; });
  const daisyId = byName['Daisy Corcut'] ?? DAISY_UID;
  const alexId  = byName['Alex Salmon']  ?? ALEX_UID;
  const mayaId  = byName['Maya Wilson']  ?? MAYA_UID;

  const { rows: parents } = await PG.query(`SELECT id, display_name FROM parents ORDER BY display_name`);
  const mumId = parents.find(r => r.display_name === 'Mum')?.id ?? MUM_UID;

  console.log('\n=== M044 Verification — Remove legacy children.push_token ===\n');
  console.log(`  Known actors: Daisy=${daisyId.slice(0,8)} Alex=${alexId.slice(0,8)} Maya=${mayaId.slice(0,8)} Mum=${mumId.slice(0,8)}\n`);

  // T01: children.push_token is NULL for all children
  const { rows: [t1] } = await PG.query(
    `SELECT COUNT(*) AS n FROM children WHERE push_token IS NOT NULL`
  );
  if (Number(t1.n) === 0)
    ok('T01 children.push_token is NULL for all rows (stale data cleared)');
  else
    ko('T01 children.push_token is NULL for all rows', `${t1.n} rows still have a non-null push_token`);

  // T02: register_child_device_token no longer writes to push_token
  const { rows: [t2] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname='register_child_device_token'
     AND pronamespace='public'::regnamespace LIMIT 1`
  );
  const syncRemoved2 = !(t2?.prosrc ?? '').includes('UPDATE children SET push_token');
  if (syncRemoved2)
    ok('T02 register_child_device_token no longer writes to children.push_token');
  else
    ko('T02 register_child_device_token no longer writes to children.push_token',
       'UPDATE children SET push_token still found in function source');

  // T03: register_device_token no longer writes to push_token
  const { rows: [t3] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname='register_device_token'
     AND pronamespace='public'::regnamespace LIMIT 1`
  );
  const syncRemoved3 = !(t3?.prosrc ?? '').includes('UPDATE children SET push_token');
  if (syncRemoved3)
    ok('T03 register_device_token no longer writes to children.push_token');
  else
    ko('T03 register_device_token no longer writes to children.push_token',
       'UPDATE children SET push_token still found in function source');

  // T04: deregister_child_device_token no longer writes to children.push_token
  const { rows: [t4] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname='deregister_child_device_token'
     AND pronamespace='public'::regnamespace LIMIT 1`
  );
  const deregClean = !(t4?.prosrc ?? '').includes('UPDATE children SET push_token');
  if (deregClean)
    ok('T04 deregister_child_device_token does not write to children.push_token');
  else
    ko('T04 deregister_child_device_token does not write to children.push_token',
       'UPDATE children SET push_token still found in deregister source');

  // T05: Edge Function with Maya as sole recipient → no_tokens
  // (Maya has no device_tokens entry; legacy fallback removed → must be no_tokens)
  const r5 = await callEdge({
    type:           'money_request',
    recipient_ids:  [mayaId],
    recipient_type: 'child',
    sender_id:      daisyId,
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10 },
  });
  if (r5.status === 200 && r5.data?.reason === 'no_tokens')
    ok('T05 Edge Function: Maya (no device_tokens) → no_tokens (legacy fallback gone)');
  else
    ko('T05 Edge Function: Maya (no device_tokens) → no_tokens',
       `got status=${r5.status} data=${JSON.stringify(r5.data)} — fallback may still be active`);

  // T06: Edge Function with Mum as recipient → no_tokens (parent token not in child recipient query)
  // Cross-check: Mum's token is NOT returned for a child notification to Mum's UUID
  const r6 = await callEdge({
    type:           'money_request',
    recipient_ids:  [mumId],
    recipient_type: 'child',  // looking up Mum UUID as if a child
    sender_id:      daisyId,
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10 },
  });
  if (r6.status === 200 && r6.data?.reason === 'no_tokens')
    ok("T06 Mum's token is not used when Mum's UUID is queried as child recipient");
  else
    ko("T06 Mum's token is not used when Mum's UUID is queried as child recipient",
       `got status=${r6.status} data=${JSON.stringify(r6.data)}`);

  // T07: Alex as recipient → token found, goes to sent (not no_tokens)
  const r7 = await callEdge({
    type:           'money_request',
    recipient_ids:  [alexId],
    recipient_type: 'child',
    sender_id:      daisyId,
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10 },
  });
  if (r7.status === 200 && (r7.data?.sent ?? 0) >= 1)
    ok('T07 Alex (registered in device_tokens) receives notification correctly');
  else
    ko('T07 Alex (registered in device_tokens) receives notification correctly',
       `got status=${r7.status} data=${JSON.stringify(r7.data)} — Alex's token may be missing`);

  // Brief pause — T07 triggered a real push with 15s receipt wait; let it settle
  await pause(2000);

  // T08: Daisy creates request to [Alex, Maya] — only Alex's token used (not Mum's)
  // This simulates the exact scenario that was broken
  const r8 = await callEdge({
    type:           'money_request',
    recipient_ids:  [alexId, mayaId],
    recipient_type: 'child',
    sender_id:      daisyId,
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10, request_id: '00000000-0000-0000-0000-000000000001' },
  });
  if (r8.status === 200 && r8.data?.sent === 1)
    ok('T08 Daisy→[Alex+Maya]: exactly 1 push sent (Alex only; Maya/Mum not included)');
  else
    ko('T08 Daisy→[Alex+Maya]: exactly 1 push sent',
       `got sent=${r8.data?.sent} (expected 1) — Maya/Mum may still be receiving`);

  // T09: Actor filtering still works (M043 regression check)
  const r9 = await callEdge({
    type:           'money_funded',
    recipient_id:   daisyId,
    recipient_type: 'child',
    sender_id:      daisyId,
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10 },
  });
  if (r9.status === 200 && r9.data?.reason === 'no_recipients')
    ok('T09 M043 actor filtering still works (recipient=actor → no_recipients)');
  else
    ko('T09 M043 actor filtering still works',
       `got status=${r9.status} data=${JSON.stringify(r9.data)}`);

  await pause(2000);

  // T10: fund_money_request scenario — borrower receives push, funder does not
  const r10a = await callEdge({
    type:           'money_funded',
    recipient_id:   alexId,    // borrower receives
    recipient_type: 'child',
    sender_id:      daisyId,   // funder is actor
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           { amount: 10 },
  });
  if (r10a.status === 200 && (r10a.data?.sent ?? 0) >= 1)
    ok('T10 money_funded: borrower (Alex) receives notification when funder (Daisy) is actor');
  else
    ko('T10 money_funded: borrower receives notification',
       `got status=${r10a.status} data=${JSON.stringify(r10a.data)}`);

  await pause(2000);

  // T11: repay — lender receives, borrower does not
  const r11 = await callEdge({
    type:           'money_repaid',
    recipient_id:   alexId,    // lender receives
    recipient_type: 'child',
    sender_id:      mayaId,    // borrower (actor) — not in device_tokens, but actor filtering is by UUID
    actor_id:       mayaId,
    sender_name:    'Maya',
    data:           { amount: 10 },
  });
  // Alex (lender) ≠ Maya (actor) → Alex's token should be found
  if (r11.status === 200 && (r11.data?.sent ?? 0) >= 1)
    ok('T11 money_repaid: lender (Alex) receives notification when borrower (Maya) is actor');
  else
    ko('T11 money_repaid: lender receives notification',
       `got status=${r11.status} data=${JSON.stringify(r11.data)}`);

  await pause(2000);

  // T12: friend_request — recipient receives, sender does not
  const r12 = await callEdge({
    type:           'friend_request',
    recipient_id:   alexId,    // receives request
    recipient_type: 'child',
    sender_id:      daisyId,   // sender (actor)
    actor_id:       daisyId,
    sender_name:    'Daisy',
    data:           {},
  });
  if (r12.status === 200 && (r12.data?.sent ?? 0) >= 1)
    ok('T12 friend_request: recipient (Alex) receives notification');
  else
    ko('T12 friend_request: recipient receives notification',
       `got status=${r12.status} data=${JSON.stringify(r12.data)}`);

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);

  if (fail > 0) {
    console.log('\nKey finding: if T05 fails with sent=1, the Edge Function legacy fallback is still active.');
    console.log('Redeploy: npx supabase functions deploy send-notification --no-verify-jwt');
  }

  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
