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
  console.log('\n=== M043 Verification — Actor Filtering ===\n');

  // T01: _trigger_notification has actor guard (recipient = sender → return)
  const { rows: [t1] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification' AND pronargs = 6 LIMIT 1`
  );
  const src1 = t1?.prosrc ?? '';
  if (src1.includes('p_recipient_id = p_sender_id') && src1.includes('RETURN'))
    ok('T01 _trigger_notification has self-notification guard');
  else
    ko('T01 _trigger_notification has self-notification guard', 'guard code not found in function source');

  // T02: _trigger_notification passes actor_id in HTTP body
  if (src1.includes("'actor_id'"))
    ok('T02 _trigger_notification passes actor_id in request body');
  else
    ko('T02 _trigger_notification passes actor_id in request body', "'actor_id' not found in body build");

  // T03: _trigger_notification_multi strips actor from recipients
  const { rows: [t3] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = '_trigger_notification_multi' LIMIT 1`
  );
  const src3 = t3?.prosrc ?? '';
  if (src3.includes('array_remove') && src3.includes('p_sender_id'))
    ok('T03 _trigger_notification_multi strips actor from recipient list');
  else
    ko('T03 _trigger_notification_multi strips actor from recipient list', 'array_remove(p_sender_id) not found');

  // T04: _trigger_notification_multi passes actor_id in HTTP body
  if (src3.includes("'actor_id'"))
    ok('T04 _trigger_notification_multi passes actor_id in request body');
  else
    ko('T04 _trigger_notification_multi passes actor_id in request body', "'actor_id' not found in body build");

  // T05: _trigger_notification_multi guards empty list after strip
  if (src3.includes('v_filtered_ids') && src3.includes('array_length'))
    ok('T05 _trigger_notification_multi guards empty list after actor strip');
  else
    ko('T05 _trigger_notification_multi guards empty list after actor strip', 'empty-list guard not found');

  // T06: parent_send_to_child calls _trigger_notification
  const { rows: [t6] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname = 'parent_send_to_child' LIMIT 1`
  );
  const src6 = t6?.prosrc ?? '';
  if (src6.includes('_trigger_notification') && src6.includes("'parent_transfer'"))
    ok("T06 parent_send_to_child fires 'parent_transfer' notification");
  else
    ko("T06 parent_send_to_child fires 'parent_transfer' notification",
       '_trigger_notification or parent_transfer not found in function source');

  // T07: parent_send_to_child still has auth guard and financial logic
  if (src6.includes('auth.uid()') && src6.includes('wallet_balance'))
    ok('T07 parent_send_to_child retains auth guard and financial logic');
  else
    ko('T07 parent_send_to_child retains auth guard and financial logic',
       'auth.uid() or wallet_balance not found');

  // T08: Edge Function filters actor_id from recipients
  const r8 = await callEdge({
    type: 'money_funded',
    recipient_id:   '00000000-0000-0000-0000-000000000001',
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001', // actor = recipient (self-notification scenario)
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Test Actor',
    data:           { amount: 10 },
  });
  // After filtering, recipientIds becomes empty → 'no_recipients'
  if (r8.status === 200 && (r8.data?.reason === 'no_recipients' || r8.data?.sent === 0))
    ok('T08 Edge Function filters actor_id out of recipient list (self-notification blocked)');
  else
    ko('T08 Edge Function filters actor_id out of recipient list',
       `expected no_recipients/sent=0, got status=${r8.status} data=${JSON.stringify(r8.data)}`);

  // T09: Edge Function does NOT filter when actor_id ≠ recipient_id
  // (send to a non-existent child UUID — should get no_tokens, not no_recipients)
  const r9 = await callEdge({
    type:           'money_funded',
    recipient_id:   '00000000-0000-0000-0000-000000000002', // recipient
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001', // actor ≠ recipient
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Test Actor',
    data:           { amount: 10 },
  });
  if (r9.status === 200 && r9.data?.reason === 'no_tokens')
    ok('T09 Edge Function passes legitimate recipients (actor ≠ recipient not filtered)');
  else
    ko('T09 Edge Function passes legitimate recipients',
       `expected no_tokens, got status=${r9.status} data=${JSON.stringify(r9.data)}`);

  // T10: Edge Function multi-recipient: actor stripped, others pass
  const r10 = await callEdge({
    type:           'money_request',
    recipient_ids:  [
      '00000000-0000-0000-0000-000000000001', // actor — must be stripped
      '00000000-0000-0000-0000-000000000002', // friend — must pass through
    ],
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001',
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Borrower',
    data:           { amount: 5 },
  });
  // After stripping actor, only 000...002 remains — no token → no_tokens
  if (r10.status === 200 && r10.data?.reason === 'no_tokens')
    ok('T10 Edge Function strips actor from multi-recipient list, sends to remainder');
  else
    ko('T10 Edge Function strips actor from multi-recipient list',
       `expected no_tokens after strip, got status=${r10.status} data=${JSON.stringify(r10.data)}`);

  // T11: Edge Function all-actor list → no_recipients
  const r11 = await callEdge({
    type:           'money_request',
    recipient_ids:  ['00000000-0000-0000-0000-000000000001'],
    recipient_type: 'child',
    sender_id:      '00000000-0000-0000-0000-000000000001',
    actor_id:       '00000000-0000-0000-0000-000000000001',
    sender_name:    'Borrower',
    data:           { amount: 5 },
  });
  if (r11.status === 200 && r11.data?.reason === 'no_recipients')
    ok('T11 Edge Function all-actor recipient list → no_recipients');
  else
    ko('T11 Edge Function all-actor recipient list → no_recipients',
       `got status=${r11.status} data=${JSON.stringify(r11.data)}`);

  // T12: DB self-notification guard — call _trigger_notification with identical
  // recipient and sender UUIDs; confirm no new pg_net request is created.
  const { rows: [beforeRow] } = await PG.query(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM net._http_response`
  );
  const maxIdBefore = Number(beforeRow.max_id);

  await PG.query(
    `SELECT public._trigger_notification(
      'money_funded',
      '00000000-0000-0000-0000-000000000099'::uuid,
      'child',
      '00000000-0000-0000-0000-000000000099'::uuid,
      'Self Test'
    )`
  );

  await new Promise(r => setTimeout(r, 2000));

  const { rows: [afterRow] } = await PG.query(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM net._http_response`
  );
  const maxIdAfter = Number(afterRow.max_id);

  if (maxIdAfter === maxIdBefore)
    ok('T12 DB _trigger_notification with recipient=sender fires no pg_net request');
  else
    ko('T12 DB _trigger_notification with recipient=sender fires no pg_net request',
       `max_id before=${maxIdBefore} after=${maxIdAfter} — a pg_net call was made`);

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
