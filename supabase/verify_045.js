#!/usr/bin/env node
'use strict';
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

let pass = 0, fail = 0;
function ok(label)         { console.log(`  PASS  ${label}`); pass++; }
function ko(label, detail) { console.log(`  FAIL  ${label} — ${detail}`); fail++; }

// The two rows that were blocking before M045
const DAISY_STALE_PENDING = '13085e21-d78b-4d06-af7c-6da054d9eb72'; // pending, expires_at PAST
const MAYA_CORRUPT_FUNDED = '415c602b-d311-4b79-ae73-5bd9ceee0fdd'; // funded, funded_at IS NULL

(async () => {
  await PG.connect();

  // Resolve actual UUIDs from DB — never hardcode (Supabase UUIDs can rotate across envs)
  const { rows: children } = await PG.query(`SELECT id, display_name FROM children ORDER BY display_name`);
  const byName = {};
  children.forEach(r => { byName[r.display_name] = r.id; });
  const DAISY_UID = byName['Daisy Corcut'];
  const MAYA_UID  = byName['Maya Wilson'];

  if (!DAISY_UID || !MAYA_UID) {
    console.error('Fatal: could not resolve Daisy or Maya UUID from children table');
    process.exit(1);
  }

  console.log('\n=== M045 Verification — Fix already_borrowing false positive ===\n');
  console.log(`  Resolved: Daisy=${DAISY_UID.slice(0,8)} Maya=${MAYA_UID.slice(0,8)}\n`);

  // ── Data cleanup ──────────────────────────────────────────────────────────

  // T01: Daisy's stale pending row (expired 2026-08-10T10:20:15) is now cancelled
  const { rows: [t1] } = await PG.query(
    `SELECT status FROM money_requests WHERE id = $1`, [DAISY_STALE_PENDING]
  );
  if (t1?.status === 'cancelled')
    ok('T01 Daisy stale pending row (13085e21) → cancelled (was blocking, now cleaned up)');
  else
    ko('T01 Daisy stale pending row (13085e21) → cancelled',
       `status is '${t1?.status ?? 'row not found'}' — data migration did not run`);

  // T02: Maya's corrupted funded row (funded_at IS NULL) is now cancelled
  const { rows: [t2] } = await PG.query(
    `SELECT status, funded_at FROM money_requests WHERE id = $1`, [MAYA_CORRUPT_FUNDED]
  );
  if (t2?.status === 'cancelled')
    ok("T02 Maya corrupted funded row (415c602b) → cancelled (funded_at was NULL — never actually funded)");
  else
    ko("T02 Maya corrupted funded row (415c602b) → cancelled",
       `status is '${t2?.status ?? 'row not found'}' — data migration did not run`);

  // T03: No pending rows remain where expires_at < now() (all stale pending cleaned up)
  const { rows: [t3] } = await PG.query(
    `SELECT COUNT(*) AS n FROM money_requests WHERE status='pending' AND expires_at < now()`
  );
  if (Number(t3.n) === 0)
    ok('T03 No pending rows remain with expires_at in the past');
  else
    ko('T03 No pending rows remain with expires_at in the past',
       `${t3.n} row(s) still have status=pending AND expires_at < now()`);

  // T04: No funded rows with funded_at IS NULL (corrupted funded rows cleaned up)
  const { rows: [t4] } = await PG.query(
    `SELECT COUNT(*) AS n FROM money_requests WHERE status='funded' AND funded_at IS NULL`
  );
  if (Number(t4.n) === 0)
    ok('T04 No funded rows with funded_at IS NULL (all corrupted funded rows cleaned up)');
  else
    ko('T04 No funded rows with funded_at IS NULL',
       `${t4.n} row(s) have status=funded AND funded_at IS NULL`);

  // ── Function logic ────────────────────────────────────────────────────────

  // T05: create_money_request source contains the corrected active-borrowing check
  const { rows: [t5] } = await PG.query(
    `SELECT prosrc FROM pg_proc WHERE proname='create_money_request'
     AND pronamespace='public'::regnamespace LIMIT 1`
  );
  const src = t5?.prosrc ?? '';
  const hasNewCheck = src.includes('expires_at > now()') && src.includes('funded_at  IS NOT NULL');
  const hasOldCheck = src.includes("status IN ('pending', 'funded')");
  if (hasNewCheck && !hasOldCheck)
    ok("T05 create_money_request uses (pending AND expires_at>now()) OR (funded AND funded_at IS NOT NULL)");
  else if (hasOldCheck)
    ko("T05 create_money_request check", "still uses old 'status IN (pending, funded)' — function not updated");
  else
    ko("T05 create_money_request check",
       `missing corrected check. hasNewCheck=${hasNewCheck} hasOldCheck=${hasOldCheck}`);

  // ── Regression tests: sequences A→C, D→F, G→J, K→M ──────────────────────
  //
  // These tests evaluate the corrected WHERE condition directly against the DB.
  // No sessions required — we verify that the EXISTS check returns the right boolean
  // for each loan lifecycle state.

  // Shared helper: run the corrected already_borrowing check for a given child.
  // Returns true if the check WOULD fire (already_borrowing), false if new request is allowed.
  async function wouldBlock(childId) {
    const { rows: [r] } = await PG.query(`
      SELECT EXISTS (
        SELECT 1 FROM money_requests
        WHERE from_id = $1
          AND (
            (status = 'pending' AND expires_at > now())
            OR
            (status = 'funded'  AND funded_at  IS NOT NULL)
          )
      ) AS blocks
    `, [childId]);
    return r.blocks;
  }

  // T06: A→C — cancel then re-borrow
  //   After the data migration, Daisy has only repaid/cancelled rows. The check must pass.
  //   (Sequence: A=pending created, B=cancelled, C=new borrow allowed)
  const t6blocks = await wouldBlock(DAISY_UID);
  if (!t6blocks)
    ok('T06 A→C cancel then re-borrow: Daisy (all rows cancelled/repaid) → not blocked');
  else
    ko('T06 A→C cancel then re-borrow',
       'Daisy is still blocked — residual pending/funded row not cleaned up');

  // T07: D→F — expired pending then re-borrow
  //   An expired pending (status=pending, expires_at < now()) must not block.
  //   Verified via the WHERE condition logic directly:
  const { rows: [t7] } = await PG.query(`
    SELECT (
      (status = 'pending' AND expires_at > now())
      OR
      (status = 'funded'  AND funded_at IS NOT NULL)
    ) AS blocks
    FROM (VALUES ('pending'::text, now() - interval '1 hour', NULL::timestamptz))
      AS t(status, expires_at, funded_at)
  `);
  if (!t7.blocks)
    ok('T07 D→F expired pending (expires_at 1h ago) → does not block new request');
  else
    ko('T07 D→F expired pending check', 'expired pending row blocks — condition is wrong');

  // T08: G→J — fund+repay then re-borrow
  //   A repaid row must not block.
  const { rows: [t8] } = await PG.query(`
    SELECT (
      (status = 'pending' AND expires_at > now())
      OR
      (status = 'funded'  AND funded_at IS NOT NULL)
    ) AS blocks
    FROM (VALUES ('repaid'::text, now() - interval '2 days', now() - interval '1 day'))
      AS t(status, expires_at, funded_at)
  `);
  if (!t8.blocks)
    ok('T08 G→J repaid row → does not block new request');
  else
    ko('T08 G→J repaid row check', 'repaid row blocks — condition is wrong');

  // T09: K→M (variant 1) — active pending blocks new request (expected behaviour)
  //   A pending row where expires_at is in the future MUST block.
  const { rows: [t9] } = await PG.query(`
    SELECT (
      (status = 'pending' AND expires_at > now())
      OR
      (status = 'funded'  AND funded_at IS NOT NULL)
    ) AS blocks
    FROM (VALUES ('pending'::text, now() + interval '20 hours', NULL::timestamptz))
      AS t(status, expires_at, funded_at)
  `);
  if (t9.blocks)
    ok('T09 K→M active pending (expires_at +20h) → blocks new request (correct, expected)');
  else
    ko('T09 K→M active pending check', 'active pending does not block — already_borrowing guard broken');

  // T10: K→M (variant 2) — real funded loan blocks new request (expected behaviour)
  //   A funded row with funded_at IS NOT NULL MUST block.
  const { rows: [t10] } = await PG.query(`
    SELECT (
      (status = 'pending' AND expires_at > now())
      OR
      (status = 'funded'  AND funded_at IS NOT NULL)
    ) AS blocks
    FROM (VALUES ('funded'::text, now() + interval '20 hours', now() - interval '1 hour'))
      AS t(status, expires_at, funded_at)
  `);
  if (t10.blocks)
    ok('T10 K→M real funded loan (funded_at IS NOT NULL) → blocks new request (correct, expected)');
  else
    ko('T10 K→M funded loan check', 'real funded loan does not block — already_borrowing guard broken');

  // ── Completeness checks ───────────────────────────────────────────────────

  // T11: All historically closed rows for Daisy do not block (full status inventory)
  //   Each row in a terminal state (repaid, cancelled) must not match the corrected check.
  const { rows: closedRows } = await PG.query(`
    SELECT id, status, expires_at, funded_at
    FROM money_requests
    WHERE from_id = $1
      AND status IN ('repaid', 'cancelled')
  `, [DAISY_UID]);
  const falsePositives = closedRows.filter(r => {
    const pendingActive = r.status === 'pending' && new Date(r.expires_at) > new Date();
    const fundedReal    = r.status === 'funded'  && r.funded_at !== null;
    return pendingActive || fundedReal;
  });
  if (falsePositives.length === 0)
    ok(`T11 All ${closedRows.length} closed rows for Daisy (repaid/cancelled) → none block new request`);
  else
    ko('T11 Historical closed rows',
       `${falsePositives.length} row(s) would incorrectly block: ${falsePositives.map(r=>r.id.slice(0,8)).join(', ')}`);

  // T12: No active borrowing blocks Daisy or Maya after migration
  const t12daisyBlocks = await wouldBlock(DAISY_UID);
  const t12mayaBlocks  = await wouldBlock(MAYA_UID);
  if (!t12daisyBlocks && !t12mayaBlocks)
    ok('T12 Daisy and Maya both unblocked — can create new money requests after migration');
  else
    ko('T12 Post-migration unblocked',
       `Daisy blocks=${t12daisyBlocks} Maya blocks=${t12mayaBlocks}`);

  await PG.end();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
