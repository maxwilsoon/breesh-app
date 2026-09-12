-- M075: repayer (borrower) self-notification on repay_money_request
--
-- Today, when a borrower repays a loan via repay_money_request, only the
-- funder/lender receives a notification ('money_repaid'). This migration adds
-- a second, self-directed notification to the borrower confirming their own
-- outgoing repayment and their own resulting wallet balance (after the
-- deduction) — mirroring the existing 'money_lent' self-notification pattern
-- used in fund_money_request for the funder's own outgoing loan payment.
--
-- Changes (additive only):
--   1. Add `RETURNING wallet_balance INTO v_borrower_balance_after` to the
--      borrower's existing balance-decrementing UPDATE.
--   2. Add a new PERFORM _trigger_notification('repayment_sent', ...) call,
--      placed after all mutations (per established convention — pg_net's
--      queue insert is transactional, so a rollback of the whole function
--      also rolls back the queued notification).
--
-- No other behavior changes. See 20260912_075_rollback.sql to revert.

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
  v_funder_balance_after   numeric;
  v_borrower_balance_after numeric;
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
  WHERE id = p_borrower_id
  RETURNING wallet_balance INTO v_borrower_balance_after;

  PERFORM _update_weekly_streak(p_borrower_id);
  PERFORM _evaluate_reward_qualification(p_borrower_id, p_request_id, 'repay', v_funder_id);

  UPDATE children SET
    wallet_balance = wallet_balance + v_amount,
    loaned_out     = GREATEST(0, loaned_out - v_amount)
  WHERE id = v_funder_id
  RETURNING wallet_balance INTO v_funder_balance_after;

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
    jsonb_build_object(
      'amount',     v_amount,
      'request_id', p_request_id,
      'balance',    v_funder_balance_after
    )
  );

  PERFORM _trigger_notification(
    'repayment_sent', p_borrower_id, 'child', v_funder_id, v_funder_name,
    jsonb_build_object(
      'amount',     v_amount,
      'request_id', p_request_id,
      'balance',    v_borrower_balance_after
    )
  );

  RETURN json_build_object('funder_id', v_funder_id, 'amount', v_amount);
END;
$function$
;

NOTIFY pgrst, 'reload schema';

COMMIT;
