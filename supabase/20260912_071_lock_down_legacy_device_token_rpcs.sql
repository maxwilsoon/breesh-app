-- Migration 071: lock down unused legacy device-token RPCs
--
-- Context:
--   register_device_token(uuid, text, text, text, text, text) and
--   deregister_device_token(text, uuid) are the pre-M039 device-token RPCs.
--   They were superseded by register_child_device_token /
--   register_parent_device_token / deregister_child_device_token /
--   deregister_parent_device_token / register_parent_push_token_passcode
--   (M039, hardened in M044/M070), which are the ones the app actually calls
--   today. Those current RPCs are NOT touched by this migration.
--
--   Live grant check performed before writing this migration:
--     register_device_token(uuid,text,text,text,text,text):
--       proacl = postgres=X/postgres, service_role=X/postgres
--       (anon's EXECUTE grant was already revoked by M039 §1e; no client
--       role currently holds EXECUTE.)
--     deregister_device_token(text, uuid):
--       does not exist in this database. M017 defined it, but nothing in
--       the migration history since actually created it live in this
--       project — M036's grant statements for it are inside a
--       DO $$ ... EXCEPTION WHEN undefined_function THEN NULL END $$ guard
--       for exactly this reason. This migration keeps that same guard so it
--       is a no-op here and safe to apply in any environment where the
--       function *does* exist.
--
--   So client access to both is already absent (or the function is absent)
--   today. This migration makes that explicit and permanent — REVOKE ALL
--   does not depend on the current grant state, so it is safe to re-run and
--   protects against a future migration re-granting either function to
--   anon/authenticated by accident (as M044 did, see below).
--
-- Bug fixed here (register_device_token ON CONFLICT):
--   M017 originally fixed this exact function so ON CONFLICT (expo_push_token)
--   DO UPDATE never reassigns user_id/user_type — a token registered to one
--   user could otherwise be silently reassigned to a different caller-supplied
--   user_id, hijacking that device's future notifications. M044's rewrite
--   (search_path/legacy-sync cleanup) recreated the function from the M014
--   body and reintroduced the M017 vulnerability: EXCLUDED.user_id /
--   EXCLUDED.user_type are back in the SET list, with no ownership WHERE.
--   This migration removes that reassignment again, matching M017's fix.
--   The function has no client grants either way (see above), so this is
--   defense-in-depth: internal callers (postgres/service_role) or a future
--   accidental re-grant cannot hijack a token through this function's
--   ON CONFLICT clause, even though the function is not reachable by
--   anon/authenticated today.
--
-- Not changed:
--   * device_tokens schema/columns/indexes.
--   * Notification logic (_trigger_notification, _trigger_notification_multi,
--     send-notification Edge Function, or any of the RPCs that call them).
--   * register_child_device_token, register_parent_device_token,
--     deregister_child_device_token, deregister_parent_device_token,
--     register_parent_push_token_passcode — the current, live notification
--     RPCs — are untouched by this migration.
--
-- Rollback: 20260912_071_rollback.sql

BEGIN;

-- ─── 1. Fix register_device_token's ON CONFLICT (remove ownership transfer) ──
-- Same signature, same RETURNS/LANGUAGE/SECURITY DEFINER/search_path as the
-- live function — only the SET list in ON CONFLICT changes: user_id and
-- user_type are no longer overwritten by EXCLUDED, so a conflicting token
-- keeps its original owner. Metadata (device_id/platform/app_version) and
-- active/last_seen/updated_at still refresh normally.
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
    -- M071: user_id/user_type intentionally NOT reassigned from EXCLUDED —
    -- a token cannot be transferred to a different owner via this RPC.
    device_id   = COALESCE(EXCLUDED.device_id,   device_tokens.device_id),
    platform    = COALESCE(EXCLUDED.platform,    device_tokens.platform),
    app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
    active      = true,
    last_seen   = now(),
    updated_at  = now();
  -- Legacy children.push_token sync removed: device_tokens is authoritative (M044)
END;
$$;

-- Explicit, permanent lock-down: no client role may call this function.
-- Current live grants already omit anon/authenticated (M039 §1e); this makes
-- that state durable rather than incidental.
REVOKE ALL ON FUNCTION
  public.register_device_token(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;

-- ─── 2. Lock down deregister_device_token(text, uuid), if it exists ─────────
-- Guarded the same way M036 guarded it: this overload does not exist in
-- every environment (see header note), so REVOKE is wrapped to avoid
-- aborting the migration with undefined_function where it's absent.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.deregister_device_token(text, uuid) FROM PUBLIC, anon, authenticated';
EXCEPTION WHEN undefined_function THEN NULL;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
