#!/usr/bin/env node
'use strict';
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

const SECRET = process.env.NOTIFICATION_SECRET;
if (!SECRET) throw new Error('NOTIFICATION_SECRET not set');
const SUPABASE_URL = 'https://biilrksornvoqtalftty.supabase.co';

let pass = 0, fail = 0;
const ok = label         => { console.log(`  PASS  ${label}`); pass++; };
const ko = (label, detail) => { console.log(`  FAIL  ${label} — ${detail}`); fail++; };

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
  console.log('\n=== M046 Verification — Actor-filter exception list ===\n');

  // T01: _trigger_notification has exemption list
  const { rows: [r1] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification' AND pronargs = 6 LIMIT 1`
  );
  const src1 = r1?.prosrc ?? '';
  if (src1.includes('tier_unlocked') && src1.includes('security_alert'))
    ok('T01 _trigger_notification has owner-event exemption list');
  else
    ko('T01 _trigger_notification has owner-event exemption list', 'tier_unlocked or security_alert not found in source');

  // T02: _trigger_notification still has actor guard
  if (src1.includes('p_recipient_id = p_sender_id') && src1.includes('RETURN'))
    ok('T02 _trigger_notification retains actor guard');
  else
    ko('T02 _trigger_notification retains actor guard', 'guard not found');

  // T03: _trigger_notification_multi has exemption list
  const { rows: [r3] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification_multi' LIMIT 1`
  );
  const src3 = r3?.prosrc ?? '';
  if (src3.includes('tier_unlocked') && src3.includes('security_alert'))
    ok('T03 _trigger_notification_multi has owner-event exemption list');
  else
    ko('T03 _trigger_notification_multi has owner-event exemption list', 'exemption list not found');

  // T04: _trigger_notification_multi still strips actor for non-exempt types
  if (src3.includes('array_remove') && src3.includes('p_sender_id'))
    ok('T04 _trigger_notification_multi still strips actor for regular events');
  else
    ko('T04 _trigger_notification_multi still strips actor', 'array_remove not found');

  // T05: parent_send_to_child still fires notification
  const { rows: [r5] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = 'parent_send_to_child' LIMIT 1`
  );
  const src5 = r5?.prosrc ?? '';
  if (src5.includes('_trigger_notification') && src5.includes("'parent_transfer'"))
    ok("T05 parent_send_to_child still fires 'parent_transfer' notification");
  else
    ko("T05 parent_send_to_child still fires notification", 'trigger call missing');

  // ── Edge Function tests ──────────────────────────────────────────────────────

  // T06: parent_transfer with actor≠recipient → recipient passes through (no_tokens not no_recipients)
  const r6 = await callEdge({
    type:           'parent_transfer',
    recipient_id:   '00000000-0000-0000-0000-000000000002', // child UUID
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001', // parent UUID (actor)
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Mum',
    data:           { amount: 20 },
  });
  if (r6.status === 200 && r6.data?.reason === 'no_tokens')
    ok('T06 Edge: parent_transfer child not filtered (actor≠recipient → no_tokens not no_recipients)');
  else
    ko('T06 Edge: parent_transfer child not filtered',
       `expected no_tokens, got status=${r6.status} data=${JSON.stringify(r6.data)}`);

  // T07: social event with actor=recipient → filtered (no_recipients)
  const r7 = await callEdge({
    type:           'money_funded',
    recipient_id:   '00000000-0000-0000-0000-000000000001',
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001',
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Self',
    data:           { amount: 5 },
  });
  if (r7.status === 200 && (r7.data?.reason === 'no_recipients' || r7.data?.sent === 0))
    ok('T07 Edge: social event with actor=recipient → filtered (no_recipients)');
  else
    ko('T07 Edge: social event actor=recipient should be filtered',
       `got status=${r7.status} data=${JSON.stringify(r7.data)}`);

  // T08: owner-event (tier_unlocked) with actor=recipient → NOT filtered (no_tokens)
  const r8 = await callEdge({
    type:           'tier_unlocked',
    recipient_id:   '00000000-0000-0000-0000-000000000001',
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001', // actor = recipient
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'System',
    data:           {},
  });
  if (r8.status === 200 && r8.data?.reason === 'no_tokens')
    ok('T08 Edge: tier_unlocked with actor=recipient NOT filtered (no_tokens, not no_recipients)');
  else
    ko('T08 Edge: tier_unlocked should bypass actor filter',
       `expected no_tokens, got status=${r8.status} data=${JSON.stringify(r8.data)}`);

  // T09: security_alert with actor=recipient → NOT filtered
  const r9 = await callEdge({
    type:           'security_alert',
    recipient_id:   '00000000-0000-0000-0000-000000000003',
    recipient_type: 'parent',
    sender_id:      '00000000-0000-0000-0000-000000000003',
    actor_id:       '00000000-0000-0000-0000-000000000003',
    sender_name:    'System',
    data:           {},
  });
  if (r9.status === 200 && r9.data?.reason === 'no_tokens')
    ok('T09 Edge: security_alert with actor=recipient NOT filtered');
  else
    ko('T09 Edge: security_alert should bypass actor filter',
       `expected no_tokens, got status=${r9.status} data=${JSON.stringify(r9.data)}`);

  // T10: points_milestone with actor=recipient → NOT filtered
  const r10 = await callEdge({
    type:           'points_milestone',
    recipient_id:   '00000000-0000-0000-0000-000000000004',
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000004',
    actor_id:       '00000000-0000-0000-0000-000000000004',
    sender_name:    'System',
    data:           {},
  });
  if (r10.status === 200 && r10.data?.reason === 'no_tokens')
    ok('T10 Edge: points_milestone with actor=recipient NOT filtered');
  else
    ko('T10 Edge: points_milestone should bypass actor filter',
       `expected no_tokens, got status=${r10.status} data=${JSON.stringify(r10.data)}`);

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
