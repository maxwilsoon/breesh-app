-- Rollback for M074 (balance added to money_repaid, loan_defaulted_lender,
-- parent_transfer payloads). Restores the exact pre-M074 live bodies of
-- repay_money_request, process_due_loan_defaults, and parent_send_to_child
-- (captured via pg_get_functiondef immediately before M074 was applied).

BEGIN;

CREATE OR REPLACE FUNCTION public.repay_money_request(p_request_id uuid, p_borrower_id uuid, p_session_token text, p_device_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_parent_id        uuid;
  v_funder_id        uuid;
  v_amount           numeric;
  v_reserved_amount  numeric;
  v_borrower_user    text;
  v_borrower_name    text;
  v_funder_name      text;
  v_funder_user      text;
  v_amt_str          text;
  v_act_id           text;
  v_borrower_balance numeric;
BEGIN
  PERFORM require_valid_child_session(p_borrower_id, p_session_token, p_device_id);

  SELECT parent_id INTO v_parent_id FROM children WHERE id = p_borrower_id;
  IF v_parent_id IS NULL THEN RAISE EXCEPTION 'Borrower not found'; END IF;

  PERFORM 1 FROM parents WHERE id = v_parent_id FOR UPDATE;

  SELECT wallet_balance INTO v_borrower_balance FROM children WHERE id = p_borrower_id FOR UPDATE;

  SELECT funded_by, amount, safety_pool_reserved_amount
    INTO v_funder_id, v_amount, v_reserved_amount
    FROM money_requests
    WHERE id = p_request_id AND from_id = p_borrower_id AND status = 'funded'
    FOR UPDATE;

  IF v_funder_id IS NULL THEN RAISE EXCEPTION 'Request not found or not in funded state'; END IF;
  IF COALESCE(v_borrower_balance, 0) < v_amount THEN
    RAISE EXCEPTION 'Insufficient balance to repay this loan';
  END IF;

  SELECT username, display_name INTO v_borrower_user, v_borrower_name FROM children WHERE id = p_borrower_id;
  SELECT display_name, username INTO v_funder_name, v_funder_user FROM children WHERE id = v_funder_id;

  v_amt_str := '£' || to_char(v_amount, 'FM999990.00');
  v_act_id  := 'recv_' || p_request_id::text;

  UPDATE money_requests
    SET status = 'repaid', repaid_at = now(), safety_pool_reservation_released_at = now()
    WHERE id = p_request_id;

  UPDATE children SET
    wallet_balance = wallet_balance - v_amount,
    borrowed       = GREATEST(0, borrowed - v_amount),
    repaid         = repaid         + 1,
    trust_score    = LEAST(100, trust_score + 5)
  WHERE id = p_borrower_id;

  PERFORM _update_weekly_streak(p_borrower_id);
  PERFORM _evaluate_reward_qualification(p_borrower_id, p_request_id, 'repay', v_funder_id);

  UPDATE children SET
    wallet_balance = wallet_balance + v_amount,
    loaned_out     = GREATEST(0, loaned_out - v_amount)
  WHERE id = v_funder_id;

  IF v_reserved_amount IS NOT NULL AND v_reserved_amount > 0 THEN
    UPDATE parents
      SET safety_pool_reserved = GREATEST(0, COALESCE(safety_pool_reserved, 0) - v_reserved_amount)
      WHERE id = v_parent_id;
  END IF;

  INSERT INTO transactions (child_id, type, amount, description, counterparty) VALUES
    (p_borrower_id, 'repay',   -v_amount, 'Repaid '   || v_amt_str || ' to @'   || v_funder_user,   v_funder_name),
    (v_funder_id,   'receive',  v_amount, 'Received ' || v_amt_str || ' from @' || v_borrower_user, NULL);

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (v_funder_id, v_act_id, '✅', v_borrower_name || ' repaid you ' || v_amt_str, 'repaid')
    ON CONFLICT (id) DO NOTHING;

  PERFORM _trigger_notification(
    'money_repaid', v_funder_id, 'child', p_borrower_id, v_borrower_name,
    jsonb_build_object('amount', v_amount, 'request_id', p_request_id)
  );

  RETURN json_build_object('funder_id', v_funder_id, 'amount', v_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_due_loan_defaults()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.parent_send_to_child(p_user_id uuid, p_child_id uuid, p_amount numeric, p_parent_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx_id      text := 'ps_' || floor(extract(epoch from now()))::bigint;
  v_amount_str text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM public.require_valid_gbp_amount(p_amount, 'transfer amount');

  IF NOT EXISTS (
    SELECT 1 FROM children WHERE id = p_child_id AND parent_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'not_parent';
  END IF;

  v_amount_str := CASE
    WHEN p_amount = floor(p_amount) THEN floor(p_amount)::integer::text
    ELSE round(p_amount, 2)::text
  END;

  UPDATE children SET wallet_balance = wallet_balance + p_amount WHERE id = p_child_id;

  INSERT INTO transactions (child_id, type, amount, description, counterparty)
    VALUES (p_child_id, 'parent_transfer', p_amount,
            p_parent_name || ' sent you £' || v_amount_str, p_parent_name);

  INSERT INTO activity_feed (child_id, id, emoji, text, type)
    VALUES (p_child_id, 'act_' || v_tx_id, '💚',
            p_parent_name || ' sent you £' || v_amount_str, 'topup');

  PERFORM public._trigger_notification(
    'parent_transfer',
    p_child_id,
    'child',
    p_user_id,
    p_parent_name,
    jsonb_build_object('amount', p_amount)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
