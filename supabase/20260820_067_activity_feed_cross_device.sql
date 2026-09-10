-- M067 — persist friend-request / money-request activity server-side
--
-- Problem: "wants to join your circle", "accepted your friend request",
-- "requested £X", and "funded your request of £X" activity-feed items were
-- only ever synthesized client-side (AppContext's 5s poll), never written to
-- the activity_feed table. Effects:
--   1. A child logging in on a new/different device never sees this history
--      — it only ever existed in the originating device's local state/cache.
--   2. Even on the original device, the item only appears if that device
--      happened to be open and polling at the exact moment the transition
--      was first observed (recipient online at the right time).
--
-- Fix: insert the same activity_feed rows (same id scheme, so no client-side
-- change is needed to de-duplicate) directly inside the RPCs that cause
-- these events, mirroring the existing pattern already used by
-- repay_money_request ('recv_<request_id>') and stripe_complete_topup.
--
-- "Your request expired unfunded" is intentionally NOT covered here — expiry
-- is a passively-computed client-side state (no DB row transition happens
-- when a request's 24h window lapses), so there is no natural RPC to hook.
--
-- Safe to run multiple times — all functions are CREATE OR REPLACE and all
-- activity_feed inserts use ON CONFLICT (id) DO NOTHING.
-- Run this in the Supabase SQL Editor.

-- ── 1. send_circle_request — notify recipient ────────────────────────────────
CREATE OR REPLACE FUNCTION public.send_circle_request(p_from_id uuid, p_to_id uuid, p_session_token text, p_device_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_from_name text;
  v_request_id uuid;
BEGIN
  PERFORM require_valid_child_session(p_from_id, p_session_token, p_device_id);

  IF p_from_id = p_to_id THEN
    RAISE EXCEPTION 'cannot_add_self';
  END IF;

  -- M049: reject if a block exists in either direction
  IF EXISTS (
    SELECT 1 FROM user_blocks
    WHERE (blocker_id = p_from_id AND blocked_id = p_to_id)
       OR (blocker_id = p_to_id   AND blocked_id = p_from_id)
  ) THEN
    RAISE EXCEPTION 'user_blocked';
  END IF;

  IF EXISTS (
    SELECT 1 FROM circles
    WHERE status = 'active'
      AND ((child_id = p_from_id AND friend_id = p_to_id)
        OR (child_id = p_to_id   AND friend_id = p_from_id))
  ) THEN
    RAISE EXCEPTION 'already_friends';
  END IF;

  IF EXISTS (
    SELECT 1 FROM circle_requests
    WHERE status = 'pending'
      AND ((from_id = p_from_id AND to_id = p_to_id)
        OR (from_id = p_to_id   AND to_id = p_from_id))
  ) THEN
    RAISE EXCEPTION 'already_pending';
  END IF;

  -- Remove any prior stale (non-pending) request so re-add flows work.
  DELETE FROM circle_requests WHERE from_id = p_from_id AND to_id = p_to_id;

  INSERT INTO circle_requests(from_id, to_id, status, created_at)
  VALUES (p_from_id, p_to_id, 'pending', now())
  RETURNING id INTO v_request_id;

  SELECT display_name INTO v_from_name FROM children WHERE id = p_from_id;

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (p_to_id, 'req_' || v_request_id::text, '👋', v_from_name || ' wants to join your circle', 'request')
    ON CONFLICT (id) DO NOTHING;

  PERFORM _trigger_notification(
    'friend_request', p_to_id, 'child', p_from_id, v_from_name, '{}'::jsonb
  );
END;
$function$;

-- ── 2. accept_circle_request — notify original sender ─────────────────────────
CREATE OR REPLACE FUNCTION public.accept_circle_request(p_request_id uuid, p_acting_child_id uuid, p_session_token text, p_device_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_from_id uuid;
  v_to_id   uuid;
  v_status  text;
  v_to_name text;
BEGIN
  SELECT from_id, to_id, status
    INTO v_from_id, v_to_id, v_status
    FROM circle_requests WHERE id = p_request_id FOR UPDATE;

  IF v_from_id IS NULL THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF p_acting_child_id <> v_to_id THEN RAISE EXCEPTION 'not_authorized'; END IF;

  PERFORM require_valid_child_session(v_to_id, p_session_token, p_device_id);

  UPDATE circle_requests SET status = 'accepted' WHERE id = p_request_id;

  INSERT INTO circles(child_id, friend_id, status) VALUES (v_from_id, v_to_id, 'active')
    ON CONFLICT (child_id, friend_id) DO UPDATE
      SET status = 'active', removed_at = NULL, removed_by = NULL;
  INSERT INTO circles(child_id, friend_id, status) VALUES (v_to_id, v_from_id, 'active')
    ON CONFLICT (child_id, friend_id) DO UPDATE
      SET status = 'active', removed_at = NULL, removed_by = NULL;

  -- Update streak for the acceptor (server-side; client's recordWeeklyStreak no-ops)
  PERFORM _update_weekly_streak(v_to_id);

  SELECT display_name INTO v_to_name FROM children WHERE id = v_to_id;

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (v_from_id, 'resolved_' || p_request_id::text, '✅', v_to_name || ' accepted your friend request', 'joined')
    ON CONFLICT (id) DO NOTHING;

  PERFORM _trigger_notification('friend_accepted', v_from_id, 'child', v_to_id, v_to_name, '{}'::jsonb);
END;
$function$;

-- ── 3. create_money_request — notify requester + circle viewers ──────────────
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

-- ── 4. fund_money_request — notify borrower ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fund_money_request(p_request_id uuid, p_funder_id uuid, p_amount numeric, p_session_token text, p_device_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_borrower_id    uuid;
  v_request_amount numeric;
  v_parent_id      uuid;
  v_funder_user    text;
  v_funder_name    text;
  v_borrower_name  text;
  v_borrower_user  text;
  v_amt_str        text;
  v_frozen         boolean;
  v_pool_avail     numeric;
  v_funder_balance numeric;
BEGIN
  PERFORM public.require_valid_gbp_amount(p_amount, 'funding amount');
  PERFORM require_valid_child_session(p_funder_id, p_session_token, p_device_id);

  SELECT from_id, amount INTO v_borrower_id, v_request_amount
    FROM money_requests WHERE id = p_request_id AND status = 'pending';
  IF v_borrower_id IS NULL THEN
    RAISE EXCEPTION 'Request not found or already funded';
  END IF;

  IF p_funder_id = v_borrower_id THEN
    RAISE EXCEPTION 'cannot_fund_own_request';
  END IF;

  IF p_amount <> v_request_amount THEN
    RAISE EXCEPTION 'Amount mismatch: request is for %, client sent %', v_request_amount, p_amount;
  END IF;

  SELECT COALESCE(account_frozen, false) INTO v_frozen FROM children WHERE id = v_borrower_id;
  IF v_frozen THEN RAISE EXCEPTION 'borrower_frozen'; END IF;

  SELECT p.id,
         (COALESCE(p.safety_pool_limit, 0) - COALESCE(p.safety_pool_used, 0) - COALESCE(p.safety_pool_reserved, 0))
    INTO v_parent_id, v_pool_avail
    FROM parents p JOIN children c ON c.parent_id = p.id
    WHERE c.id = v_borrower_id FOR UPDATE;

  IF v_parent_id IS NULL THEN RAISE EXCEPTION 'Parent not found for borrower'; END IF;
  IF COALESCE(v_pool_avail, 0) < p_amount THEN RAISE EXCEPTION 'safety_pool_insufficient'; END IF;

  SELECT wallet_balance INTO v_funder_balance FROM children WHERE id = p_funder_id FOR UPDATE;
  IF COALESCE(v_funder_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance to fund this request';
  END IF;

  UPDATE money_requests
    SET status = 'funded', funded_by = p_funder_id, funded_at = now(), safety_pool_reserved_amount = p_amount
    WHERE id = p_request_id AND status = 'pending'
    RETURNING from_id INTO v_borrower_id;

  IF v_borrower_id IS NULL THEN RAISE EXCEPTION 'Request not found or already funded'; END IF;

  UPDATE parents SET safety_pool_reserved = COALESCE(safety_pool_reserved, 0) + p_amount WHERE id = v_parent_id;

  SELECT username, display_name INTO v_funder_user, v_funder_name FROM children WHERE id = p_funder_id;
  SELECT display_name, username INTO v_borrower_name, v_borrower_user FROM children WHERE id = v_borrower_id;

  v_amt_str := '£' || to_char(p_amount, 'FM999990.00');

  UPDATE children SET
    wallet_balance = wallet_balance - p_amount,
    loaned_out     = loaned_out     + p_amount,
    total_lent     = total_lent     + p_amount,
    times_lent     = times_lent     + 1,
    trust_score    = LEAST(100, trust_score + 2)
  WHERE id = p_funder_id;

  PERFORM _update_weekly_streak(p_funder_id);
  PERFORM _evaluate_reward_qualification(p_funder_id, p_request_id, 'fund', v_borrower_id);

  UPDATE children SET
    wallet_balance = wallet_balance + p_amount,
    borrowed       = borrowed       + p_amount,
    total_borrowed = total_borrowed + p_amount,
    times_borrowed = times_borrowed + 1
  WHERE id = v_borrower_id;

  INSERT INTO transactions (child_id, type, amount, description, counterparty) VALUES
    (p_funder_id,   'lend',   -p_amount, v_amt_str || ' lent to @'       || v_borrower_user, v_borrower_name),
    (v_borrower_id, 'borrow',  p_amount, v_amt_str || ' borrowed from @' || v_funder_user,   NULL);

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (v_borrower_id, 'funded_' || p_request_id::text, '💚', v_funder_name || ' funded your request of ' || v_amt_str, 'funded')
    ON CONFLICT (id) DO NOTHING;

  PERFORM _trigger_notification(
    'money_funded', v_borrower_id, 'child', p_funder_id, v_funder_name,
    jsonb_build_object('amount', p_amount, 'request_id', p_request_id)
  );

  RETURN json_build_object('borrower_id', v_borrower_id);
END;
$function$;

-- ── 5. cancel_money_request — clean up the now-server-side rows too ──────────
CREATE OR REPLACE FUNCTION public.cancel_money_request(p_request_id uuid, p_child_id uuid, p_session_token text, p_device_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_rows int;
BEGIN
  -- Session validation is the first operation — before any read or write.
  PERFORM require_valid_child_session(p_child_id, p_session_token, p_device_id);

  UPDATE money_requests
    SET    status = 'cancelled'
    WHERE  id      = p_request_id
      AND  from_id = p_child_id
      AND  status  = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Only delete activity rows when we actually cancelled something.
  -- A no-op UPDATE (already cancelled, funded, or wrong owner) is safe — no cleanup needed.
  IF v_rows > 0 THEN
    DELETE FROM activity_feed
      WHERE id = 'a_req_' || p_request_id::text          -- borrower's "You requested £X"
         OR id LIKE 'moneyreq_' || p_request_id::text || '_%'; -- each viewer's "X requested £Y"
  END IF;
END;
$function$;

-- ── 6. One-time backfill for rows created before this migration existed ──────
-- Purely additive (ON CONFLICT DO NOTHING) — safe to re-run. Uses the
-- original event's timestamp so items sort into their correct chronological
-- position rather than jumping to the top as "Just now".

-- 6a. Still-pending incoming friend requests
INSERT INTO activity_feed (child_id, id, emoji, text, type, created_at)
SELECT cr.to_id, 'req_' || cr.id::text, '👋', c.display_name || ' wants to join your circle', 'request', cr.created_at
FROM circle_requests cr
JOIN children c ON c.id = cr.from_id
WHERE cr.status = 'pending'
ON CONFLICT (id) DO NOTHING;

-- 6b. Already-accepted friend requests (notify original sender)
INSERT INTO activity_feed (child_id, id, emoji, text, type, created_at)
SELECT cr.from_id, 'resolved_' || cr.id::text, '✅', c.display_name || ' accepted your friend request', 'joined', cr.created_at
FROM circle_requests cr
JOIN children c ON c.id = cr.to_id
WHERE cr.status = 'accepted'
ON CONFLICT (id) DO NOTHING;

-- 6c. Requester's own "You requested £X" for still-relevant requests
INSERT INTO activity_feed (child_id, id, emoji, text, type, created_at)
SELECT mr.from_id, 'a_req_' || mr.id::text, '💸',
       'You requested £' || to_char(mr.amount, 'FM999990.00'), 'request', mr.created_at
FROM money_requests mr
WHERE mr.status IN ('pending', 'funded')
ON CONFLICT (id) DO NOTHING;

-- 6d. Circle viewers' "X requested £Y" for still-pending unexpired requests
INSERT INTO activity_feed (child_id, id, emoji, text, type, created_at)
SELECT ci.friend_id,
       'moneyreq_' || mr.id::text || '_' || ci.friend_id::text,
       '💸',
       c.display_name || ' requested £' || to_char(mr.amount, 'FM999990.00') ||
         CASE WHEN mr.reason IS NOT NULL AND trim(mr.reason) <> '' THEN ' for ' || trim(mr.reason) ELSE '' END,
       'request', mr.created_at
FROM money_requests mr
JOIN children c ON c.id = mr.from_id
JOIN circles ci ON ci.child_id = mr.from_id AND ci.status = 'active'
  AND (mr.viewer_ids IS NULL OR ci.friend_id = ANY(mr.viewer_ids))
WHERE mr.status = 'pending' AND mr.expires_at > now()
ON CONFLICT (id) DO NOTHING;

-- 6e. Funded requests — notify borrower
INSERT INTO activity_feed (child_id, id, emoji, text, type, created_at)
SELECT mr.from_id, 'funded_' || mr.id::text, '💚',
       c.display_name || ' funded your request of £' || to_char(mr.amount, 'FM999990.00'), 'funded', mr.funded_at
FROM money_requests mr
JOIN children c ON c.id = mr.funded_by
WHERE mr.status = 'funded'
ON CONFLICT (id) DO NOTHING;
