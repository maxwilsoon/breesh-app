-- Rollback migration 071: restore register_device_token's pre-071 body
-- (the M044 version, verbatim).
--
-- WARNING: this restores the ON CONFLICT DO UPDATE SET user_id =
-- EXCLUDED.user_id / user_type = EXCLUDED.user_type behavior that M071
-- removed — a conflicting token can once again be reassigned to a
-- caller-supplied user_id through this function. It has no client grants in
-- either direction (M039 already revoked anon's EXECUTE before M071 ran),
-- so this only matters for internal/service_role callers.
--
-- Grants are intentionally NOT reverted: this rollback does not re-grant
-- register_device_token or deregister_device_token(text, uuid) to
-- PUBLIC/anon/authenticated. Undoing that lock-down was never the point of
-- a rollback and would reopen client access to unused legacy RPCs.

CREATE OR REPLACE FUNCTION public.register_device_token(
  p_user_id         uuid,
  p_user_type       text,
  p_expo_push_token text,
  p_device_id       text    DEFAULT NULL,
  p_platform        text    DEFAULT NULL,
  p_app_version     text    DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO device_tokens (
    user_id, user_type, expo_push_token, device_id, platform, app_version,
    active, last_seen, updated_at
  )
  VALUES (
    p_user_id, p_user_type, p_expo_push_token, p_device_id, p_platform, p_app_version,
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
    updated_at  = now();
  -- Legacy children.push_token sync removed: device_tokens is authoritative (M044)
END;
$$;

NOTIFY pgrst, 'reload schema';
