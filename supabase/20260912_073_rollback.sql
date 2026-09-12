-- Rollback for M073 (parent_debt_repaid notification on confirm_parent_repayment).
-- Restores the exact pre-M073 live function body (captured via pg_get_functiondef
-- before this migration was applied) — removes the notification, the 'balance'
-- capture, and the parent-name lookup. No other behaviour changes.

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
  WHERE id = p_child_id;

  UPDATE parents
    SET safety_pool_used = GREATEST(0, COALESCE(safety_pool_used, 0) - v_debt)
    WHERE id = p_parent_id;

  RETURN json_build_object('repaid', v_debt);
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
