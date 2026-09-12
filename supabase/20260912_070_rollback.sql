-- Rollback migration 070: restore register_child_device_token,
-- register_parent_device_token, and register_parent_push_token_passcode to
-- their pre-070 bodies (migration 055 and migration 052, verbatim).
--
-- WARNING: after this rollback, the device_id-based same-physical-device
-- reclaim is removed again. register_parent_device_token and
-- register_parent_push_token_passcode go back to having NO fallback at all
-- (user_id match only) — parent-to-parent test-account switching on the same
-- device will once again raise token_owned_by_another_user even after a
-- clean logout. register_child_device_token keeps its (a)/(b) rules but
-- loses the (c) same-device-and-stale rule.
--
-- Signature note: this rollback drops the 6-arg register_parent_push_token_
-- passcode (added by 070) and restores the original 5-arg overload from
-- migration 052 (no p_device_id parameter; device_id was always stored as
-- NULL for this login path).

BEGIN;

-- ─── 1. register_child_device_token (pre-070 body, from M055) ──────────────
CREATE OR REPLACE FUNCTION public.register_child_device_token(
  p_child_id        uuid,
  p_session_token   text,
  p_device_id       text,
  p_expo_push_token text,
  p_platform        text DEFAULT NULL,
  p_app_version     text DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
DECLARE v_rows int;
BEGIN
  PERFORM require_valid_child_session(p_child_id, p_session_token, p_device_id);

  IF p_expo_push_token IS NULL OR length(trim(p_expo_push_token)) = 0 THEN
    RAISE EXCEPTION 'invalid_push_token';
  END IF;

  INSERT INTO device_tokens (
    user_id, user_type, expo_push_token, device_id, platform, app_version,
    active, last_seen, updated_at
  ) VALUES (
    p_child_id, 'child', p_expo_push_token,
    p_device_id, p_platform, p_app_version,
    true, now(), now()
  )
  ON CONFLICT (expo_push_token) DO UPDATE SET
    user_id     = EXCLUDED.user_id,
    user_type   = EXCLUDED.user_type,
    device_id   = COALESCE(EXCLUDED.device_id,   device_tokens.device_id),
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now()
  -- Allow claim only when: (a) same user, OR (b) previous owner logged out (active=false)
  WHERE device_tokens.user_id = p_child_id
     OR device_tokens.active  = false;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'token_owned_by_another_user';
  END IF;

  -- Deactivate all other tokens for this child — new device becomes sole recipient.
  UPDATE device_tokens
    SET active = false, updated_at = now()
  WHERE user_id         = p_child_id
    AND user_type       = 'child'
    AND expo_push_token <> p_expo_push_token;
END;
$$;

-- ─── 2. register_parent_device_token (pre-070 body, from M055) ─────────────
CREATE OR REPLACE FUNCTION public.register_parent_device_token(
  p_expo_push_token text,
  p_device_id       text DEFAULT NULL,
  p_platform        text DEFAULT NULL,
  p_app_version     text DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions
AS $$
DECLARE
  v_parent_id uuid := auth.uid();
  v_rows      int;
BEGIN
  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_expo_push_token IS NULL OR length(trim(p_expo_push_token)) = 0 THEN
    RAISE EXCEPTION 'invalid_push_token';
  END IF;

  INSERT INTO device_tokens (
    user_id, user_type, expo_push_token, device_id, platform, app_version,
    active, last_seen, updated_at
  ) VALUES (
    v_parent_id, 'parent', p_expo_push_token,
    p_device_id, p_platform, p_app_version,
    true, now(), now()
  )
  ON CONFLICT (expo_push_token) DO UPDATE SET
    -- user_id intentionally omitted — ownership immutable for parents (M039)
    device_id   = COALESCE(EXCLUDED.device_id,   device_tokens.device_id),
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now()
  WHERE device_tokens.user_id = v_parent_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'token_owned_by_another_user';
  END IF;

  -- Deactivate all other tokens for this parent — new device becomes sole recipient.
  UPDATE device_tokens
    SET active = false, updated_at = now()
  WHERE user_id         = v_parent_id
    AND user_type       = 'parent'
    AND expo_push_token <> p_expo_push_token;
END;
$$;

-- ─── 3. register_parent_push_token_passcode (pre-070 body, from M052) ──────
DROP FUNCTION IF EXISTS public.register_parent_push_token_passcode(uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.register_parent_push_token_passcode(
  p_parent_id       uuid,
  p_pin             text,
  p_expo_push_token text,
  p_platform        text DEFAULT NULL,
  p_app_version     text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions
AS $$
DECLARE
  v_stored_hash text;
  v_allowed     boolean;
  v_rows        int;
BEGIN
  v_allowed := _rl_attempt(
    'rl_parent_passcode', p_parent_id::text,
    5, interval '5 minutes', interval '5 minutes'
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  IF p_expo_push_token IS NULL OR length(trim(p_expo_push_token)) = 0 THEN
    RAISE EXCEPTION 'invalid_push_token';
  END IF;

  SELECT passcode_hash INTO v_stored_hash FROM public.parents WHERE id = p_parent_id;

  IF v_stored_hash IS NULL
     OR v_stored_hash !~ '^\$2[aby]\$[0-9]{2}\$'
     OR length(v_stored_hash) <> 60 THEN
    RETURN false;
  END IF;

  IF crypt(p_pin, v_stored_hash) <> v_stored_hash THEN
    RETURN false;
  END IF;

  PERFORM _rl_clear('rl_parent_passcode', p_parent_id::text);

  INSERT INTO device_tokens (
    user_id, user_type, expo_push_token, device_id, platform, app_version,
    active, last_seen, updated_at
  ) VALUES (
    p_parent_id, 'parent', p_expo_push_token,
    NULL, p_platform, p_app_version,
    true, now(), now()
  )
  ON CONFLICT (expo_push_token) DO UPDATE SET
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now()
  WHERE device_tokens.user_id = p_parent_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- v_rows = 0: token belongs to another user; PIN still correct → return true.
  -- Only deactivate other tokens when this parent successfully claimed the new token.
  IF v_rows > 0 THEN
    UPDATE device_tokens
      SET active = false, updated_at = now()
    WHERE user_id         = p_parent_id
      AND user_type       = 'parent'
      AND expo_push_token <> p_expo_push_token;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.register_parent_push_token_passcode(uuid,text,text,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.register_parent_push_token_passcode(uuid,text,text,text,text)
  TO anon, authenticated, postgres, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
