-- M076: extend block_user's guard to also cover PENDING (unfunded) requests
--
-- Problem: block_user (M050) only rejects blocking while a FUNDED, unrepaid
--          loan exists between the two parties. It does NOT check a
--          money_requests row that's still 'pending' (sent, not yet funded
--          by anyone) — so two users with an outstanding, unfunded request
--          between them could still block each other, silently orphaning
--          that request (the requester's ask stays visible to whoever else
--          is in viewer_ids, but the blocked relationship is now gone
--          without the two parties ever resolving it).
--
-- Fix: block_user now also rejects the block with a new, distinct error
--      ('active_request_outstanding', separate from 'active_loan_outstanding'
--      because no money has moved yet — the client copy differs) whenever an
--      unexpired pending request exists where one party is the requester
--      (from_id) and the other is a listed viewer (eligible to fund it).
--
-- Scope: block_user only. The existing funded-loan guard is untouched.

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

  -- Prevent blocking while either party has an outstanding, unexpired PENDING
  -- request the other could still fund (nobody has funded it yet, so no
  -- money has moved — distinct error code/copy from the funded-loan case).
  IF EXISTS (
    SELECT 1 FROM money_requests
    WHERE status = 'pending'
      AND expires_at > now()
      AND (
        (from_id = p_blocker_id AND p_blocked_id = ANY(viewer_ids))
        OR (from_id = p_blocked_id AND p_blocker_id = ANY(viewer_ids))
      )
  ) THEN
    RAISE EXCEPTION 'active_request_outstanding';
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
