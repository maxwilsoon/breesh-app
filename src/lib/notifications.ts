import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { db } from './database';

// Always show system notifications — let the OS handle display in all app states.
// On iOS this shows the native banner even when the app is in the foreground.
// On Android the system notification channel (importance=MAX) controls presentation.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
  }),
});

// Confirmed registration state — set only after the DB call succeeds.
let _currentPushToken:    string | null = null;
let _currentUserId:       string | null = null;
let _currentUserType:     'child' | 'parent' | null = null;
let _currentSessionToken: string | null = null;
let _currentDeviceId:     string | null = null;

// Pre-registration state — set as soon as the Expo token is obtained, before the
// DB call.  Used by deregisterCurrentPushToken so that logout can still mark the
// token inactive even when the DB registration previously failed (e.g. network
// error).  The next registerPushToken call overwrites these unconditionally.
let _rawExpoToken:    string | null = null;
let _rawUserId:       string | null = null;
let _rawUserType:     'child' | 'parent' | null = null;
let _rawSessionToken: string | null = null;
let _rawDeviceId:     string | null = null;

/**
 * Obtains the Expo push token for this device without registering it in the
 * database. Returns null when push is unavailable (not a physical device, EAS
 * project not configured, permissions denied, or Expo token service error).
 *
 * Use this to pre-fetch the token before making a credential-verified DB call
 * (e.g. register_parent_push_token_passcode) that does not require a Supabase
 * Auth session.
 */
export async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId;
  if (!projectId) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    } catch {}
  }

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data || null;
  } catch {
    return null;
  }
}

export async function registerPushToken(
  userId: string,
  userType: 'child' | 'parent' = 'child',
  sessionToken?: string,
  deviceId?: string,
): Promise<string | null> {
  if (!Device.isDevice) {
    if (__DEV__) console.log('[Push] not a physical device — skipping registration');
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId;

  if (__DEV__) {
    console.log('[Push] registerPushToken —',
      'platform:', Platform.OS,
      '| userType:', userType,
      '| userId prefix:', userId.slice(0, 8),
      '| projectId present:', !!projectId,
      '| deviceId present:', !!deviceId,
      '| sessionToken present:', !!sessionToken,
    );
  }

  if (!projectId) {
    if (__DEV__) console.warn('[Push] EAS projectId missing — push notifications disabled. Check app.json extra.eas.projectId.');
    return null;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (__DEV__) console.log('[Push] existing permission status:', existing);

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (__DEV__) console.log('[Push] permission:', finalStatus);

  if (finalStatus !== 'granted') {
    if (__DEV__) console.warn('[Push] permission denied — no push token will be registered');
    return null;
  }

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
      if (__DEV__) console.log('[Push] Android notification channel created (importance=MAX)');
    } catch (e) {
      if (__DEV__) console.warn('[Push] Android channel setup failed:', e);
    }
  }

  // Stage 1: obtain Expo push token from Expo's service.
  let token: string;
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenData.data;

    if (__DEV__) {
      console.log('[Push] tokenExists:', !!token && token.length > 0,
        '| format:', token?.startsWith('ExponentPushToken[') ? 'ExponentPushToken' :
                    token?.startsWith('ExpoPushToken[')      ? 'ExpoPushToken' : 'unknown',
        '| suffix: ...', token?.slice(-4) ?? 'n/a',
      );
    }

    if (!token || token.length === 0) {
      if (__DEV__) console.warn('[Push] getExpoPushTokenAsync returned empty token');
      return null;
    }
  } catch (e: any) {
    // Token fetch fails when: EAS project not found, permission revoked, network error.
    if (__DEV__) console.warn('[Push] getExpoPushTokenAsync FAILED —', e?.message ?? String(e), '| code:', e?.code ?? 'n/a');
    return null;
  }

  // Store pre-registration state so logout can deregister even if Stage 2 fails.
  _rawExpoToken    = token;
  _rawUserId       = userId;
  _rawUserType     = userType;
  _rawSessionToken = sessionToken ?? null;
  _rawDeviceId     = deviceId ?? null;

  // Stage 2: register the token in the DB.
  try {
    if (userType === 'parent') {
      if (__DEV__) console.log('[ParentPush] registrationAttempt — platform:', Platform.OS, '| deviceId present:', !!deviceId);
      await db.registerParentDeviceToken(
        token,
        deviceId,
        Platform.OS,
        Constants.expoConfig?.version ?? undefined,
      );
      if (__DEV__) console.log('[ParentPush] registrationSuccess — parent token active in device_tokens');
    } else {
      if (!sessionToken || !deviceId) {
        if (__DEV__) console.warn('[ChildPush] child registration requires sessionToken + deviceId — both must be present');
        return null;
      }
      if (__DEV__) console.log('[ChildPush] registrationAttempt — platform:', Platform.OS, '| userId prefix:', userId.slice(0, 8));
      await db.registerChildDeviceToken(
        userId,
        sessionToken,
        deviceId,
        token,
        Platform.OS,
        Constants.expoConfig?.version ?? undefined,
      );
      if (__DEV__) console.log('[ChildPush] registrationSuccess — child token active in device_tokens');
    }
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    const prefix = userType === 'parent' ? '[ParentPush]' : '[ChildPush]';

    if (msg.includes('token_owned_by_another_user')) {
      // M070 narrowed the reclaim rules (same user / released token / same
      // device after a staleness window) specifically so this should now be
      // rare. Log unconditionally — not gated on __DEV__ — so a genuine,
      // unexpected collision is never silently invisible in production, even
      // though registration still fails open (non-fatal) below.
      console.error(`${prefix} token_owned_by_another_user — unexpected push-token collision`,
        '| userId prefix:', userId.slice(0, 8), '| deviceId present:', !!deviceId);
    } else if (__DEV__) {
      console.warn(`${prefix} DB registrationError —`, msg, '| code:', (e as any)?.code ?? 'n/a');
    }

    // Re-throw child session errors so AppContext can route to login and clear the
    // stale SecureStore token. All other errors (including ownership collisions)
    // are non-fatal — a failed push registration must never block login.
    if (userType === 'child' && (
      msg.includes('child_session_revoked') ||
      msg.includes('child_session_expired') ||
      msg.includes('invalid_child_session')
    )) {
      throw e;
    }
    return null;
  }

  _currentPushToken    = token;
  _currentUserId       = userId;
  _currentUserType     = userType;
  _currentSessionToken = sessionToken ?? null;
  _currentDeviceId     = deviceId ?? null;
  return token;
}

/**
 * Deactivates the push token registered during the current session.
 * Falls back to the pre-registration (_raw*) state when DB registration
 * previously failed, so logout reliably marks the token inactive even in
 * that case.  Propagates errors to the caller (resetSession awaits this
 * before revoking the child session, so the session must still be valid).
 */
export async function deregisterCurrentPushToken(): Promise<void> {
  // Prefer confirmed state; fall back to pre-registration state.
  const token     = _currentPushToken    ?? _rawExpoToken;
  const userId    = _currentUserId       ?? _rawUserId;
  const userType  = _currentUserType     ?? _rawUserType;
  const sessToken = _currentSessionToken ?? _rawSessionToken;
  const devId     = _currentDeviceId     ?? _rawDeviceId;

  if (!token || !userType) return;

  if (__DEV__) {
    console.log('[Push] deregisterCurrentPushToken —',
      'userType:', userType,
      '| userId prefix:', userId?.slice(0, 8) ?? 'null',
      '| token suffix: ...', token.slice(-4),
      '| source:', _currentPushToken ? 'confirmed' : 'pre-registration fallback',
    );
  }

  // Clear both state layers before the async call so a concurrent deregister is a no-op.
  _currentPushToken    = null;
  _currentUserId       = null;
  _currentUserType     = null;
  _currentSessionToken = null;
  _currentDeviceId     = null;
  _rawExpoToken        = null;
  _rawUserId           = null;
  _rawUserType         = null;
  _rawSessionToken     = null;
  _rawDeviceId         = null;

  if (userType === 'parent') {
    await db.deregisterParentDeviceToken(token);
    if (__DEV__) console.log('[Push] parent token deregistered');
  } else {
    if (userId && sessToken && devId) {
      await db.deregisterChildDeviceToken(token, userId, sessToken, devId);
      if (__DEV__) console.log('[Push] child token deregistered');
    } else {
      if (__DEV__) console.warn('[Push] deregister: missing userId/sessToken/devId — skipping RPC');
    }
  }
}

export function getCurrentPushToken(): string | null {
  return _currentPushToken;
}
