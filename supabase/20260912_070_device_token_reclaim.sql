-- Migration 070: narrow device_id-based push-token reclaim
--
-- Context / bug:
--   On the Samsung development build, registering a push token failed with
--   token_owned_by_another_user. Expo push tokens are stable per physical
--   device/FCM registration, so the same expo_push_token can be submitted by
--   a different test account than the one that last registered it — most
--   commonly because the previous session ended without a clean logout
--   (force-quit, revoked/expired session, reinstall) and so never reached
--   deregister_child_device_token / deregister_parent_device_token to mark
--   its row active = false.
--
-- Existing reclaim rules (unchanged, still in effect):
--   register_child_device_token:  user_id match, OR active = false
--   register_parent_device_token: user_id match ONLY (M039 "ownership
--     immutable for parents" — a deliberate concurrency/atomicity choice,
--     not an anti-reassignment security policy; see M039's own header).
--   register_parent_push_token_passcode: user_id match ONLY, and on a
--     mismatch it silently returned true anyway (see fix #3 below).
--
-- Fix: add ONE additional, narrowly-scoped reclaim branch to all three RPCs:
--
--     device_tokens.device_id = p_device_id
--     AND device_tokens.updated_at < now() - interval '5 minutes'
--
--   This does NOT weaken authentication: it only ever fires for a caller who
--   has already passed a real credential check (require_valid_child_session /
--   auth.uid() / correct PIN) for SOME account. device_id merely narrows an
--   already-authenticated claim down to "this physical device" — it cannot
--   be produced by a remote attacker who doesn't hold the device, and it
--   cannot bypass the credential check itself. The staleness guard prevents
--   a same-device claim from racing a row that was JUST actively
--   re-confirmed (e.g. the rightful owner foregrounding their app).
--
--   This is intentionally NOT a time-only/broad reclaim: device_id match is
--   required in every case. A plain "updated_at < now() - interval '14
--   days'" fallback (which would let a bare reinstall reclaim any
--   sufficiently old token, device_id or not) is explicitly NOT implemented
--   here — see "Reinstall handling" below.
--
--   Concurrency: unchanged from M039's model. INSERT ... ON CONFLICT DO
--   UPDATE still acquires a row lock on the conflicting row before the WHERE
--   is evaluated; GET DIAGNOSTICS still detects a 0-row update. Adding a
--   third OR-branch to that WHERE does not introduce a second lock or a
--   TOCTOU gap — every branch is evaluated atomically under the same lock.
--
-- Reinstall handling (why this fix does NOT cover it):
--   device_id is minted fresh (Crypto.getRandomBytesAsync -> SecureStore) any
--   time none is found in SecureStore, and Android wipes app-private
--   SecureStore/EncryptedSharedPreferences storage on uninstall. So a genuine
--   uninstall+reinstall produces a NEW device_id that will never match the
--   stale row's stored device_id — branch (c) below cannot fire, by design.
--   This is deliberate: it is exactly what stops an arbitrary newly
--   installed app from reclaiming a token by device_id alone.
--
--   For development, reinstalling onto a device that previously ran a
--   DIFFERENT test account will still raise token_owned_by_another_user.
--   Safe manual cleanup (run once via the Supabase SQL editor, or
--   apply_070.js-style script, after such a reinstall):
--
--     SELECT id, user_id, user_type, device_id, active, updated_at,
--            right(expo_push_token, 8) AS token_suffix
--       FROM device_tokens
--       WHERE right(expo_push_token, 8) = '<last 8 chars from the client log>';
--
--     UPDATE device_tokens SET active = false, updated_at = now()
--       WHERE id = '<the id from the row above>';
--
--   Do NOT run a blanket UPDATE against all rows — target the specific
--   stale row by id (or by full expo_push_token) only.
--
-- Fix #3 (register_parent_push_token_passcode visibility):
--   This RPC's job is PIN verification, not push registration — a wrong PIN
--   is the only case that should make it return false; push-registration
--   failure must stay non-fatal to login (the client call site is
--   fire-and-forget with the return value discarded — see
--   ParentPasscodeScreen.tsx). Previously, a token_owned_by_another_user
--   mismatch was silently absorbed with no signal anywhere. This migration
--   keeps the boolean contract unchanged (still returns true on a correct
--   PIN, regardless of push-registration outcome) but adds a RAISE WARNING
--   so a genuine collision is visible in Postgres/Supabase logs instead of
--   vanishing entirely.
--
-- Rollback: 20260912_070_rollback.sql

BEGIN;

-- ─── 1. register_child_device_token ─────────────────────────────────────────
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
  -- M070: Allow claim only when:
  --   (a) same user re-registering their own token, OR
  --   (b) previous owner released the token via authenticated logout
  --       (active = false), OR
  --   (c) same physical device (device_id match) reclaiming a row that has
  --       been idle for 5+ minutes — covers a prior test account whose
  --       session ended without a clean logout on the SAME device. Requires
  --       BOTH device_id match AND staleness so a live foreground
  --       re-registration on this device can't be raced out from under its
  --       current rightful owner.
  WHERE device_tokens.user_id = p_child_id
     OR device_tokens.active  = false
     OR (
          p_device_id IS NOT NULL
          AND device_tokens.device_id = p_device_id
          AND device_tokens.updated_at < now() - interval '5 minutes'
        );

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

-- ─── 2. register_parent_device_token ────────────────────────────────────────
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
    -- M070: user_id reassignment is now possible, but ONLY when the WHERE
    -- below matches — i.e. only for the caller's own row, or a stale row on
    -- the caller's own physical device. The M039 atomicity guarantee (row
    -- lock + WHERE filter + GET DIAGNOSTICS) is unchanged; this SET clause
    -- has no effect unless that same lock-protected WHERE already passed.
    user_id     = v_parent_id,
    device_id   = COALESCE(EXCLUDED.device_id,   device_tokens.device_id),
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now()
  -- M070: same-user reclaim (unchanged) OR same-physical-device reclaim of a
  -- row idle 5+ minutes (a prior parent test account that switched off this
  -- device without deregistering). See register_child_device_token above
  -- for the full reasoning — identical rule, applied symmetrically.
  WHERE device_tokens.user_id = v_parent_id
     OR (
          p_device_id IS NOT NULL
          AND device_tokens.device_id = p_device_id
          AND device_tokens.updated_at < now() - interval '5 minutes'
        );

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

-- ─── 3. register_parent_push_token_passcode ─────────────────────────────────
-- Signature change: p_device_id is inserted before the trailing p_platform /
-- p_app_version params, so the old 5-arg overload must be dropped explicitly.
DROP FUNCTION IF EXISTS public.register_parent_push_token_passcode(uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION public.register_parent_push_token_passcode(
  p_parent_id       uuid,
  p_pin             text,
  p_expo_push_token text,
  p_device_id       text DEFAULT NULL,
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
    p_device_id, p_platform, p_app_version,
    true, now(), now()
  )
  ON CONFLICT (expo_push_token) DO UPDATE SET
    user_id     = p_parent_id,
    device_id   = COALESCE(EXCLUDED.device_id,   device_tokens.device_id),
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now()
  WHERE device_tokens.user_id = p_parent_id
     OR (
          p_device_id IS NOT NULL
          AND device_tokens.device_id = p_device_id
          AND device_tokens.updated_at < now() - interval '5 minutes'
        );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- v_rows = 0: token is actively owned by a different parent and neither
  -- reclaim condition matched. This function's contract is "was the PIN
  -- correct?" (the client call site is fire-and-forget and never inspects
  -- this return value for push-registration success — see
  -- ParentPasscodeScreen.tsx) so we do not fail the PIN check over a push
  -- registration collision. M070: unlike before, this is no longer silent —
  -- log it so a genuine unexpected collision is visible in Postgres logs.
  IF v_rows = 0 THEN
    RAISE WARNING 'push_token_registration_skipped: token_owned_by_another_user (parent_id=%)', p_parent_id;
  ELSE
    UPDATE device_tokens
      SET active = false, updated_at = now()
    WHERE user_id         = p_parent_id
      AND user_type       = 'parent'
      AND expo_push_token <> p_expo_push_token;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.register_parent_push_token_passcode(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.register_parent_push_token_passcode(uuid, text, text, text, text, text)
  TO anon, authenticated, postgres, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
