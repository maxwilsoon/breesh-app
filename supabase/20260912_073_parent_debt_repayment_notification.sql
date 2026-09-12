-- M073: banking-style push notification when a child's wallet is debited to
-- clear parent_debt (confirm_parent_repayment).
--
-- Context: confirm_parent_repayment is the only real "money leaves the
-- wallet" path in the codebase besides lending (fund_money_request, which
-- M072 already covers with 'money_lent'). It runs when a parent confirms a
-- child has repaid money they owed after a missed loan default — it debits
-- wallet_balance, zeroes parent_debt, and unfreezes the account — but today
-- it sends NO notification at all. This migration is purely additive: no
-- existing behaviour, validation, or return value changes.
--
-- New notification type: 'parent_debt_repaid'
--   Recipient: the child (p_child_id) — money left *their* wallet.
--   Sender:    the parent (p_parent_id) — whose confirmation triggered it.
--   Payload:   amount (the debt just cleared), balance (wallet_balance after).
--
-- Fires only after the UPDATE has committed its effect within this same
-- transaction (per the established convention — see M072 header) — a
-- rolled-back call (e.g. the 'unauthorized' or insufficient-balance
-- exceptions above it) can never reach this PERFORM.

BEGIN;

CREATE OR REPLACE FUNCTION public.confirm_parent_repayment(
  p_child_id  uuid,
  p_parent_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_debt          numeric;
  v_child_balance numeric;
  v_new_balance   numeric;
  v_parent_name   text;
BEGIN
  -- Caller-identity guard: the parent's Supabase Auth JWT must match p_parent_id.
  -- Rejects all anon callers and any authenticated caller acting for another family.
  IF auth.uid() IS NULL OR auth.uid() <> p_parent_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT COALESCE(parent_debt, 0), wallet_balance
  INTO   v_debt, v_child_balance
  FROM   children
  WHERE  id = p_child_id AND parent_id = p_parent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'not_parent');
  END IF;

  IF v_debt = 0 THEN
    RETURN json_build_object('repaid', 0);
  END IF;

  IF COALESCE(v_child_balance, 0) < v_debt THEN
    RAISE EXCEPTION 'Insufficient balance: child has £% but owes £%',
      to_char(COALESCE(v_child_balance, 0), 'FM999990.00'),
      to_char(v_debt, 'FM999990.00');
  END IF;

  UPDATE children SET
    wallet_balance = wallet_balance - v_debt,
    parent_debt    = 0,
    account_frozen = false
  WHERE id = p_child_id
  RETURNING wallet_balance INTO v_new_balance;

  UPDATE parents
    SET safety_pool_used = GREATEST(0, COALESCE(safety_pool_used, 0) - v_debt)
    WHERE id = p_parent_id;

  SELECT COALESCE(display_name, trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), 'Your parent')
    INTO v_parent_name
    FROM parents WHERE id = p_parent_id;

  PERFORM _trigger_notification(
    'parent_debt_repaid', p_child_id, 'child', p_parent_id, v_parent_name,
    jsonb_build_object(
      'amount',  v_debt,
      'balance', v_new_balance
    )
  );

  RETURN json_build_object('repaid', v_debt);
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
