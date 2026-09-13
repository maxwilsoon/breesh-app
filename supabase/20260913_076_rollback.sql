-- Rollback for 20260913_076_block_guard_pending_request.sql
-- Restores block_user to its exact pre-M076 (M050) body: only the
-- funded-loan guard, no pending-request guard.

BEGIN;

CREATE OR REPLACE FUNCTION public.block_user(
  p_blocker_id    uuid,
  p_session_token text,
  p_device_id     text,
  p_blocked_id    uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  PERFORM require_valid_child_session(p_blocker_id, p_session_token, p_device_id);

  IF p_blocker_id = p_blocked_id THEN
    RAISE EXCEPTION 'cannot_block_self';
  END IF;

  -- Prevent blocking while either party has an outstanding funded loan with the other.
  -- Covers both directions: blocker borrowed from blocked, or blocked borrowed from blocker.
  IF EXISTS (
    SELECT 1 FROM money_requests
    WHERE status = 'funded'
      AND (
        (from_id = p_blocker_id AND funded_by = p_blocked_id)
        OR (from_id = p_blocked_id AND funded_by = p_blocker_id)
      )
  ) THEN
    RAISE EXCEPTION 'active_loan_outstanding';
  END IF;

  INSERT INTO user_blocks (blocker_id, blocked_id)
  VALUES (p_blocker_id, p_blocked_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  UPDATE circle_requests
  SET status = 'declined'
  WHERE status = 'pending'
    AND ((from_id = p_blocker_id AND to_id = p_blocked_id)
      OR (from_id = p_blocked_id AND to_id = p_blocker_id));

  UPDATE circles
  SET status     = 'removed',
      removed_at = now(),
      removed_by = p_blocker_id
  WHERE (child_id = p_blocker_id AND friend_id = p_blocked_id)
     OR (child_id = p_blocked_id AND friend_id = p_blocker_id);
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
