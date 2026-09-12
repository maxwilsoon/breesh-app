-- Migration 069: enforce CURRENT circle status on money-request visibility
--
-- Context / bug:
--   A user removed a friend from their circle, then created a NEW money
--   request. The removed friend could still see that request in their own
--   requests list, even though the two are no longer connected.
--
-- Data model (for reference):
--   circles(child_id, friend_id, status, removed_at, removed_by) is a
--   bidirectional join table; a row is never deleted on removal, only
--   flipped to status = 'removed'. money_requests does NOT reference the
--   circles row at all — it carries its own `viewer_ids uuid[]` snapshot
--   column, populated once at creation time and otherwise only touched by
--   remove_from_circle (migration 038), which correctly scrubs a removed
--   friend's id out of viewer_ids on EXISTING pending requests.
--
-- Root cause (two independent bugs, both in the authorization-relevant
-- path, neither checking CURRENT circles.status — same class of problem
-- as migration 068's parent-ownership gate):
--
--   1. create_money_request (migration 067) inserted the raw,
--      client-supplied p_viewer_ids array directly into
--      money_requests.viewer_ids with no server-side check that those ids
--      are still active circle members of p_from_id. The function already
--      computes a live, correctly-filtered `active circle members` list
--      for the purpose of sending push notifications (v_viewer_ids, joined
--      against circles WHERE status = 'active') — but that filtered list
--      was only ever used for notifications, never for what gets stored
--      and later read back. A stale client-side circle cache (or a
--      malicious client) could persist a removed friend as a legitimate
--      viewer on a BRAND NEW request.
--
--   2. get_active_requests (migration 049) decides whether a circle
--      member may see someone else's pending request with:
--        mr.from_id IN (SELECT friend_id FROM circles WHERE child_id = p_child_id)
--      This subquery has NO status filter at all. Since a removed circle
--      row is kept around with status = 'removed' (not deleted), the
--      removed friend's id NEVER leaves this subquery's result set —
--      remove_from_circle's viewer_ids scrub becomes irrelevant, because
--      this check alone is sufficient to let a removed friend see:
--        (a) any pending request with viewer_ids IS NULL from their
--            ex-friend (the common case — "visible to whole circle"), and
--        (b) any pending request whose viewer_ids happens to still
--            include them (bug 1, above, or a future regression of the
--            same kind).
--      This is why the reproduction worked even for a request created
--      AFTER the removal: bug 1 doesn't even need to be present for the
--      user's exact repro to occur — bug 2 alone reproduces it whenever
--      the new request has no explicit viewer exclusions (viewer_ids NULL).
--
-- Fix (defense-in-depth, mirrors migration 068's pattern of validating
-- against CURRENT state at the point of data access, not stored/client
-- state):
--   1. get_active_requests: add `AND status = 'active'` to the circles
--      membership subquery. This alone closes the reported repro and is
--      the authoritative read-time gate — even if viewer_ids is ever
--      wrong or stale again, a removed friend can no longer pass the
--      circle-membership check.
--   2. create_money_request: before INSERT, intersect the caller-supplied
--      p_viewer_ids with the caller's CURRENT active circle membership
--      (server-derived, not trusted from the client) and store only that
--      sanitized array. Belt-and-suspenders — prevents a non-circle-member
--      id (stale, mistaken, or malicious) from ever being persisted as a
--      viewer in the first place.
--
-- Audit (item 6 — other circle-scoped data):
--   get_circle (migration 037) already correctly filters
--   `ci.status = 'active'` — the circle list itself was never affected.
--   Activity-feed rows for a money request are fanned out (materialized
--   per-recipient) using the already-correctly-filtered v_viewer_ids, so
--   they were never affected either. search_children and
--   get_pending_requests do not key off circles.status by design (they
--   concern users who are NOT yet — or no longer relevantly — circle
--   members). No other circle-status-checking query was found missing the
--   filter (see the grep audit across all migrations referencing
--   `FROM circles` / `JOIN circles`).
--
-- Rollback: 20260912_069_rollback.sql

BEGIN;

-- ─── 1. get_active_requests — require ACTIVE circle status, not just any
--        historical circles row ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_active_requests(
  p_child_id      uuid,
  p_session_token text,
  p_device_id     text
) RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
DECLARE v_results json;
BEGIN
  PERFORM require_valid_child_session(p_child_id, p_session_token, p_device_id);

  SELECT json_agg(row_to_json(r)) INTO v_results
  FROM (
    SELECT
      mr.id, mr.from_id,
      c.display_name  AS from_name,
      c.avatar_emoji  AS from_emoji,
      c.avatar_url    AS from_url,
      c.trust_score   AS from_trust,
      mr.amount, mr.reason, mr.reason_emoji, mr.deadline_days,
      TO_CHAR(mr.repay_by_date, 'DD Mon') AS repay_by_date,
      mr.expires_at, mr.status, mr.created_at,
      (mr.from_id = p_child_id) AS is_own,
      mr.funded_by,
      fc.display_name AS funded_by_name,
      fc.avatar_emoji AS funded_by_emoji,
      fc.avatar_url   AS funded_by_url
    FROM money_requests mr
    JOIN      children c  ON c.id  = mr.from_id
    LEFT JOIN children fc ON fc.id = mr.funded_by
    WHERE
      ((mr.status = 'pending' AND mr.expires_at > now()) OR mr.status = 'funded')
      AND (
        -- Own requests: always visible (financial visibility preserved)
        mr.from_id = p_child_id
        -- Funded loans where caller is lender: always visible (financial obligation)
        OR mr.funded_by = p_child_id
        -- Circle members' pending requests: block-filtered AND CURRENT-circle-filtered.
        -- M069: a `circles` row survives friend removal with status = 'removed'
        -- (never deleted) — the status check here is what actually revokes
        -- visibility once two users are no longer connected. Without it, a
        -- removed friend keeps matching this subquery forever.
        OR (
          mr.status = 'pending'
          AND mr.from_id IN (
            SELECT friend_id FROM circles WHERE child_id = p_child_id AND status = 'active'
          )
          AND (mr.viewer_ids IS NULL OR p_child_id = ANY(mr.viewer_ids))
          -- M049: hide pending requests from/to blocked users
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id = p_child_id AND ub.blocked_id = mr.from_id)
               OR (ub.blocker_id = mr.from_id AND ub.blocked_id = p_child_id)
          )
        )
      )
    ORDER BY mr.created_at DESC
  ) r;

  RETURN COALESCE(v_results, '[]'::json);
END;
$$;

-- ─── 2. create_money_request — sanitize p_viewer_ids against CURRENT active
--        circle membership before persisting, instead of trusting the raw
--        client-supplied array ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_money_request(p_from_id uuid, p_amount numeric, p_deadline_days integer, p_session_token text, p_device_id text, p_reason text DEFAULT ''::text, p_reason_emoji text DEFAULT '💸'::text, p_viewer_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_req_id     uuid;
  v_trust      int;
  v_max_borrow numeric;
  v_frozen     boolean;
  v_from_name  text;
  v_viewer_ids uuid[];
  v_amt_str    text;
  v_viewer_id  uuid;
BEGIN
  PERFORM public.require_valid_gbp_amount(p_amount, 'request amount');
  PERFORM require_valid_child_session(p_from_id, p_session_token, p_device_id);

  SELECT trust_score, COALESCE(account_frozen, false)
    INTO v_trust, v_frozen
    FROM children WHERE id = p_from_id;

  IF v_frozen THEN RAISE EXCEPTION 'account_frozen'; END IF;

  -- Active borrowing: pending within the 24-hour acceptance window,
  -- OR genuinely funded (fund_money_request always sets funded_at).
  -- Expired pending rows and corrupted funded rows (funded_at IS NULL) do not block.
  IF EXISTS (
    SELECT 1 FROM money_requests
    WHERE from_id = p_from_id
      AND (
        (status = 'pending' AND expires_at > now())
        OR
        (status = 'funded'  AND funded_at  IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'already_borrowing';
  END IF;

  v_max_borrow := CASE
    WHEN v_trust < 50 THEN 20
    WHEN v_trust < 70 THEN 30
    WHEN v_trust < 85 THEN 50
    ELSE 100
  END;

  IF p_amount > v_max_borrow THEN
    RAISE EXCEPTION 'amount_exceeds_limit:%', v_max_borrow;
  END IF;

  -- M069: never trust the client's viewer list as-is. Sanitize it down to
  -- ids that are CURRENTLY active circle members of p_from_id — this is
  -- the array that gets persisted to money_requests.viewer_ids and is later
  -- read back (indefinitely) by get_active_requests, so it must reflect
  -- live authorization state at write time, not whatever the client's
  -- possibly-stale local circle cache happened to contain.
  IF p_viewer_ids IS NOT NULL THEN
    SELECT array_agg(v) INTO p_viewer_ids
    FROM unnest(p_viewer_ids) AS v
    WHERE v IN (
      SELECT friend_id FROM circles WHERE child_id = p_from_id AND status = 'active'
    );
  END IF;

  INSERT INTO money_requests
    (from_id, amount, reason, reason_emoji, deadline_days, repay_by_date, expires_at, viewer_ids)
  VALUES (
    p_from_id, p_amount, p_reason, p_reason_emoji, p_deadline_days,
    (now() + (p_deadline_days || ' days'::text)::interval)::date,
    now() + interval '24 hours',
    p_viewer_ids
  ) RETURNING id INTO v_req_id;

  PERFORM _update_weekly_streak(p_from_id);

  SELECT array_agg(ci.friend_id) INTO v_viewer_ids
    FROM circles ci
    WHERE ci.child_id = p_from_id
      AND ci.status   = 'active'
      AND (p_viewer_ids IS NULL OR ci.friend_id = ANY(p_viewer_ids));

  SELECT display_name INTO v_from_name FROM children WHERE id = p_from_id;

  v_amt_str := '£' || to_char(p_amount, 'FM999990.00');

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (p_from_id, 'a_req_' || v_req_id::text, '💸', 'You requested ' || v_amt_str, 'request')
    ON CONFLICT (id) DO NOTHING;

  IF v_viewer_ids IS NOT NULL THEN
    FOREACH v_viewer_id IN ARRAY v_viewer_ids LOOP
      INSERT INTO activity_feed (child_id, id, emoji, text, type)
        VALUES (
          v_viewer_id,
          'moneyreq_' || v_req_id::text || '_' || v_viewer_id::text,
          '💸',
          v_from_name || ' requested ' || v_amt_str ||
            CASE WHEN p_reason IS NOT NULL AND trim(p_reason) <> '' THEN ' for ' || trim(p_reason) ELSE '' END,
          'request'
        )
        ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END IF;

  PERFORM _trigger_notification_multi(
    'money_request', v_viewer_ids, 'child', p_from_id, v_from_name,
    jsonb_build_object('amount', p_amount, 'request_id', v_req_id)
  );

  RETURN json_build_object('request_id', v_req_id);
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
