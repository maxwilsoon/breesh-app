-- Rollback migration 069: restore get_active_requests and create_money_request
-- to their pre-069 bodies (migration 049 and migration 067, verbatim).
--
-- WARNING: after this rollback, a removed friend can once again see a
-- circle-member's pending money requests (the `circles` status filter is
-- removed from get_active_requests, and create_money_request stops
-- sanitizing p_viewer_ids against current circle membership).

BEGIN;

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
        mr.from_id = p_child_id
        OR mr.funded_by = p_child_id
        OR (
          mr.status = 'pending'
          AND mr.from_id IN (SELECT friend_id FROM circles WHERE child_id = p_child_id)
          AND (mr.viewer_ids IS NULL OR p_child_id = ANY(mr.viewer_ids))
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

NOTIFY pgrst, 'reload schema';

COMMIT;
