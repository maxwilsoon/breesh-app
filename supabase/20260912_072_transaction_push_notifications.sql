-- Migration 072: banking-style transaction push notifications
--
-- Context:
--   Product ask: send a push notification to the relevant user the moment a
--   money transaction actually completes, in banking-app style ("£5.00 sent
--   to Alex" / "Your Breesh balance is now £20.00."), covering four cases:
--     1. Lend / money sent        (funder,  on fund_money_request)
--     2. Money received           (borrower, on fund_money_request)
--     3. Loan repayment received  (funder,  on repay_money_request)
--     4. Safety Pool repayment    (borrower, on process_due_loan_defaults)
--
-- Bug found + fixed here (money_lent notification silently dropped):
--   M056 added a 'money_lent' confirmation push to fund_money_request's
--   funder side ("You've lent £X to Y"). M062's rewrite of the same function
--   (search_path/reward-qualification cleanup) recreated the body from an
--   earlier version and dropped that PERFORM entirely — the live function has
--   only the borrower-side 'money_funded' notification. Confirmed live via
--   pg_get_functiondef before writing this migration. This migration restores
--   the funder-side notification (as 'money_lent', new copy) alongside the
--   fix, so case 1 above actually fires again.
--
-- What changes:
--   * fund_money_request:
--       - Adds v_funder_balance_after / v_borrower_balance_after, captured via
--         RETURNING on the existing balance UPDATEs (no new UPDATEs, no
--         behavior change to the balances themselves).
--       - money_funded notification (borrower) now includes 'balance' in its
--         payload.
--       - Restores the money_lent notification (funder) with 'balance' in its
--         payload — same trigger point, after all mutations, same as
--         money_funded, so it only fires once the fund succeeds and never on
--         a rolled-back attempt (net.http_post's queue insert is part of this
--         same transaction).
--   * process_due_loan_defaults:
--       - Adds a third notification_queue row, type 'safety_pool_repayment',
--         to the borrower, alongside the existing loan_defaulted_lender /
--         loan_defaulted_borrower rows. Uses its own event_key
--         ('default_pool_repay_' || loan id) in the same
--         ON CONFLICT (event_key) DO NOTHING outbox insert those two already
--         use, so it inherits the same at-most-once-per-loan dedup guarantee
--         on cron retry.
--   * repay_money_request: NOT modified. It already fires 'money_repaid' to
--     the funder with the borrower as sender — exactly what case 3 needs.
--     Only the Edge Function copy for that type changes (see
--     supabase/functions/send-notification/index.ts, deployed separately).
--
-- Not changed:
--   * device_tokens / notification_queue schema.
--   * Any balance, points, trust_score, streak, reward-qualification, or
--     safety-pool arithmetic — every UPDATE's SET list is byte-for-byte the
--     live version; only RETURNING clauses were added to read back values
--     that are already being written.
--   * Loan-default consequences (freeze, activity_feed rows, circle
--     broadcast, loan_defaulted_lender/borrower notifications) — untouched,
--     the new row is additive.
--   * _trigger_notification / _trigger_notification_multi — untouched.
--
-- Rollback: 20260912_072_rollback.sql

BEGIN;

-- ─── 1. fund_money_request — add balances + restore money_lent notification ──
CREATE OR REPLACE FUNCTION public.fund_money_request(
  p_request_id  uuid,
  p_funder_id   uuid,
  p_amount      numeric,
  p_session_token text,
  p_device_id   text
) RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
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
  v_funder_balance_after   numeric;
  v_borrower_balance_after numeric;
BEGIN
  PERFORM public.require_valid_gbp_amount(p_amount, 'funding amount');

  PERFORM require_valid_child_session(p_funder_id, p_session_token, p_device_id);

  SELECT from_id, amount INTO v_borrower_id, v_request_amount
    FROM money_requests
    WHERE id = p_request_id AND status = 'pending';
  IF v_borrower_id IS NULL THEN
    RAISE EXCEPTION 'Request not found or already funded';
  END IF;

  IF p_funder_id = v_borrower_id THEN
    RAISE EXCEPTION 'cannot_fund_own_request';
  END IF;

  IF p_amount <> v_request_amount THEN
    RAISE EXCEPTION 'Amount mismatch: request is for %, client sent %',
      v_request_amount, p_amount;
  END IF;

  SELECT COALESCE(account_frozen, false) INTO v_frozen
    FROM children WHERE id = v_borrower_id;
  IF v_frozen THEN RAISE EXCEPTION 'borrower_frozen'; END IF;

  SELECT p.id,
         (COALESCE(p.safety_pool_limit,    0)
          - COALESCE(p.safety_pool_used,   0)
          - COALESCE(p.safety_pool_reserved, 0))
    INTO v_parent_id, v_pool_avail
    FROM parents p
    JOIN children c ON c.parent_id = p.id
    WHERE c.id = v_borrower_id
    FOR UPDATE;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'Parent not found for borrower';
  END IF;

  IF COALESCE(v_pool_avail, 0) < p_amount THEN
    RAISE EXCEPTION 'safety_pool_insufficient';
  END IF;

  SELECT wallet_balance INTO v_funder_balance
    FROM children WHERE id = p_funder_id FOR UPDATE;
  IF COALESCE(v_funder_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance to fund this request';
  END IF;

  UPDATE money_requests
    SET status                      = 'funded',
        funded_by                   = p_funder_id,
        funded_at                   = now(),
        safety_pool_reserved_amount = p_amount
    WHERE id = p_request_id AND status = 'pending'
    RETURNING from_id INTO v_borrower_id;

  IF v_borrower_id IS NULL THEN
    RAISE EXCEPTION 'Request not found or already funded';
  END IF;

  UPDATE parents
    SET safety_pool_reserved = COALESCE(safety_pool_reserved, 0) + p_amount
    WHERE id = v_parent_id;

  SELECT username,     display_name INTO v_funder_user,   v_funder_name   FROM children WHERE id = p_funder_id;
  SELECT display_name, username     INTO v_borrower_name, v_borrower_user FROM children WHERE id = v_borrower_id;

  v_amt_str := '£' || to_char(p_amount, 'FM999990.00');

  UPDATE children SET
    wallet_balance = wallet_balance - p_amount,
    loaned_out     = loaned_out     + p_amount,
    total_lent     = total_lent     + p_amount,
    times_lent     = times_lent     + 1,
    trust_score    = LEAST(100, trust_score + 2)
  WHERE id = p_funder_id
  RETURNING wallet_balance INTO v_funder_balance_after;

  PERFORM _update_weekly_streak(p_funder_id);
  PERFORM _evaluate_reward_qualification(p_funder_id, p_request_id, 'fund', v_borrower_id);

  UPDATE children SET
    wallet_balance = wallet_balance + p_amount,
    borrowed       = borrowed       + p_amount,
    total_borrowed = total_borrowed + p_amount,
    times_borrowed = times_borrowed + 1
  WHERE id = v_borrower_id
  RETURNING wallet_balance INTO v_borrower_balance_after;

  INSERT INTO transactions (child_id, type, amount, description, counterparty) VALUES
    (p_funder_id,   'lend',   -p_amount,
     v_amt_str || ' lent to @'       || v_borrower_user, v_borrower_name),
    (v_borrower_id, 'borrow',  p_amount,
     v_amt_str || ' borrowed from @' || v_funder_user,   NULL);

  -- Recipient: borrower — they received money.
  PERFORM _trigger_notification(
    'money_funded', v_borrower_id, 'child', p_funder_id, v_funder_name,
    jsonb_build_object(
      'amount',     p_amount,
      'request_id', p_request_id,
      'balance',    v_borrower_balance_after
    )
  );

  -- Recipient: funder — confirmation of their own sent payment (M056,
  -- restored here after M062 dropped it — see migration header).
  PERFORM _trigger_notification(
    'money_lent', p_funder_id, 'child', v_borrower_id, v_borrower_name,
    jsonb_build_object(
      'amount',     p_amount,
      'request_id', p_request_id,
      'balance',    v_funder_balance_after
    )
  );

  RETURN json_build_object('borrower_id', v_borrower_id);
END;
$$;

-- ─── 2. process_due_loan_defaults — add Safety Pool repayment notification ───
CREATE OR REPLACE FUNCTION public.process_due_loan_defaults()
  RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_req RECORD;

  v_parent_id    uuid;
  v_reserved     numeric;
  v_updated      int;
  v_processed    int := 0;
  v_skipped      int := 0;
  v_notif_sent   int := 0;

  v_borrower_user  text;
  v_borrower_name  text;
  v_funder_user    text;
  v_funder_name    text;
  v_amt_str        text;

  v_loan_id      uuid;
  v_borrower_id  uuid;
  v_funder_id    uuid;

  v_notif RECORD;
BEGIN
  FOR v_req IN
    SELECT mr.id,
           mr.from_id                    AS borrower_id,
           mr.funded_by                  AS funder_id,
           mr.amount,
           mr.safety_pool_reserved_amount,
           mr.repay_by_date
    FROM   public.money_requests mr
    WHERE  mr.status = 'funded'
      AND  mr.repay_by_date < CURRENT_DATE
      AND  mr.safety_pool_reservation_released_at IS NULL
    ORDER  BY mr.repay_by_date ASC
  LOOP
    BEGIN
      SELECT p.id INTO v_parent_id
        FROM public.parents p
        JOIN public.children c ON c.parent_id = p.id
        WHERE c.id = v_req.borrower_id
        FOR UPDATE;

      IF v_parent_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      UPDATE public.money_requests
        SET status                              = 'defaulted',
            repaid_at                           = now(),
            safety_pool_reservation_released_at = now()
        WHERE id      = v_req.id
          AND status  = 'funded'
          AND repay_by_date < CURRENT_DATE
          AND safety_pool_reservation_released_at IS NULL;

      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated = 0 THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_loan_id     := v_req.id;
      v_borrower_id := v_req.borrower_id;
      v_funder_id   := v_req.funder_id;

      v_reserved := COALESCE(v_req.safety_pool_reserved_amount, v_req.amount);

      UPDATE public.parents
        SET safety_pool_reserved = GREATEST(0, COALESCE(safety_pool_reserved, 0) - v_reserved),
            safety_pool_used     = COALESCE(safety_pool_used, 0) + v_req.amount
        WHERE id = v_parent_id;

      v_amt_str := '£' || to_char(v_req.amount, 'FM999990.00');

      SELECT username, display_name
        INTO v_funder_user, v_funder_name
        FROM public.children WHERE id = v_req.funder_id;

      SELECT username, display_name
        INTO v_borrower_user, v_borrower_name
        FROM public.children WHERE id = v_req.borrower_id;

      UPDATE public.children
        SET wallet_balance = wallet_balance + v_req.amount,
            loaned_out     = GREATEST(0, loaned_out - v_req.amount)
        WHERE id = v_req.funder_id;

      UPDATE public.children
        SET account_frozen = true,
            parent_debt    = COALESCE(parent_debt, 0) + v_req.amount,
            borrowed       = GREATEST(0, borrowed - v_req.amount),
            trust_score    = GREATEST(0, trust_score - 15),
            points         = GREATEST(0, points - 15),
            streak         = 0,
            missed         = missed + 1
        WHERE id = v_req.borrower_id;

      INSERT INTO public.transactions (child_id, type, amount, description, counterparty)
        VALUES (v_req.funder_id, 'receive', v_req.amount,
                v_amt_str || ' received from Parent Safety Pool (Loan Guarantee)',
                'Safety Pool');

      -- Activity feed — full display names throughout
      INSERT INTO public.activity_feed (child_id, id, emoji, text, type)
        VALUES (v_req.funder_id,
                'default_recv_' || v_req.id::text, '🛡️',
                v_amt_str || ' received from Safety Pool — ' || v_borrower_name || ' defaulted',
                'funded')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.activity_feed (child_id, id, emoji, text, type)
        VALUES (v_req.borrower_id,
                'default_brw_' || v_req.id::text, '🔒',
                'Missed repayment · Safety Pool paid ' || v_amt_str || ' to ' || v_funder_name ||
                ' · -15 pts · Account frozen',
                'missed')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.activity_feed (child_id, id, emoji, text, type)
        SELECT c.child_id,
               'default_circle_' || v_loan_id::text || '_' || c.child_id::text,
               '⚠️',
               v_borrower_name || ' missed their ' || v_amt_str || ' repayment — -15 pts',
               'missed'
        FROM   public.circles c
        WHERE  c.friend_id = v_borrower_id
          AND  c.status    = 'active'
          AND  c.child_id <> v_funder_id
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.notification_queue
        (event_key, child_id, event_type, sender_id, sender_name, payload)
        VALUES
          ('default_lender_' || v_req.id::text,
           v_req.funder_id, 'loan_defaulted_lender',
           v_req.borrower_id, v_borrower_name,
           jsonb_build_object('amount', v_req.amount, 'request_id', v_req.id)),
          ('default_borrower_' || v_req.id::text,
           v_req.borrower_id, 'loan_defaulted_borrower',
           v_req.funder_id, v_funder_name,
           jsonb_build_object('amount', v_req.amount, 'request_id', v_req.id)),
          -- New (M072): banking-style confirmation to the borrower that the
          -- Safety Pool settled their debt with the lender. Additive — does
          -- not replace the account-frozen consequence notice above.
          ('default_pool_repay_' || v_req.id::text,
           v_req.borrower_id, 'safety_pool_repayment',
           v_req.funder_id, v_funder_name,
           jsonb_build_object('amount', v_req.amount, 'request_id', v_req.id))
        ON CONFLICT (event_key) DO NOTHING;

      v_processed := v_processed + 1;

    EXCEPTION
      WHEN deadlock_detected THEN
        v_skipped := v_skipped + 1;
      WHEN OTHERS THEN
        v_skipped := v_skipped + 1;
        RAISE WARNING 'process_due_loan_defaults: error on loan %: %', v_req.id, SQLERRM;
    END;
  END LOOP;

  FOR v_notif IN
    SELECT id, child_id, event_type, sender_id, sender_name, payload
      FROM public.notification_queue
      WHERE status = 'pending'
      ORDER BY id ASC
      FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public._trigger_notification(
        v_notif.event_type, v_notif.child_id, 'child',
        v_notif.sender_id, v_notif.sender_name, v_notif.payload
      );
      UPDATE public.notification_queue
        SET status = 'sent', processed_at = now()
        WHERE id = v_notif.id;
      v_notif_sent := v_notif_sent + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_queue
        SET status = 'failed', processed_at = now()
        WHERE id = v_notif.id;
    END;
  END LOOP;

  RETURN json_build_object(
    'processed',          v_processed,
    'skipped',            v_skipped,
    'notifications_sent', v_notif_sent
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_loan_defaults() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
