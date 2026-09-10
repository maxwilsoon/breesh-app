import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

// expo-secure-store key validation: /^[\w.-]+$/ — only alphanumeric, ".", "-", "_".
// Colons are NOT allowed. All compound keys here use "_" as separator.

// ─── Secure helpers ───────────────────────────────────────────────────────────

async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e) {
    if (__DEV__) console.warn('[biometrics] secureGet error for key', key, String(e));
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (e) {
    if (__DEV__) console.warn('[biometrics] secureSet error for key', key, String(e));
  }
}

async function secureDel(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (e) {
    if (__DEV__) console.warn('[biometrics] secureDel error for key', key, String(e));
  }
}

// ─── Key helpers ─────────────────────────────────────────────────────────────
// All biometric state is scoped by childId so Child A's Face ID setup never
// leaks to Child B (even on the same device).
// Separator is "_" — colon ":" is rejected by SecureStore key validation.

const DEVICE_KEY        = 'breesh_device_id';
const LAST_CHILD_KEY    = 'breesh_last_child';
const LAST_PARENT_KEY   = 'breesh_last_parent_id';
const tokenKey          = (childId: string) => `breesh_bio_token_${childId}`;
const declinedKey       = (childId: string) => `breesh_bio_declined_${childId}`;
const refreshTokenKey   = (userId: string) => `breesh_auth_refresh_${userId}`;

// ─── Parent auth refresh token ────────────────────────────────────────────────
// Stored after email login so PIN login can restore the Supabase Auth session.

export async function saveParentRefreshToken(userId: string, token: string): Promise<void> {
  await secureSet(refreshTokenKey(userId), token);
}

export async function getParentRefreshToken(userId: string): Promise<string | null> {
  return secureGet(refreshTokenKey(userId));
}

export async function deleteParentRefreshToken(userId: string): Promise<void> {
  await secureDel(refreshTokenKey(userId));
}

// ─── Device ID (stable, per-install) ─────────────────────────────────────────

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

export async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'web') {
    // Web: persist a stable device ID in localStorage so it survives page
    // refreshes and is consistent across logins in the same browser profile.
    // Falls back to an ephemeral ID if localStorage is unavailable (private mode).
    const WEB_DEVICE_KEY = 'breesh_web_device_id';
    try {
      const stored = localStorage.getItem(WEB_DEVICE_KEY);
      if (stored) return stored;
      const buf = new Uint8Array(24);
      crypto.getRandomValues(buf);
      const id = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(WEB_DEVICE_KEY, id);
      return id;
    } catch {
      const buf = new Uint8Array(24);
      crypto.getRandomValues(buf);
      return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  }
  let id = await secureGet(DEVICE_KEY);
  if (!id) {
    const bytes = await Crypto.getRandomBytesAsync(24);
    id = bytesToHex(bytes);
    await secureSet(DEVICE_KEY, id);
  }
  return id;
}

// ─── Hardware availability ────────────────────────────────────────────────────

export async function isBiometricAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const hasHw    = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (__DEV__) console.log('[biometrics] isBiometricAvailable: hasHw=', hasHw, 'enrolled=', enrolled);
    return hasHw && enrolled;
  } catch (e) {
    if (__DEV__) console.warn('[biometrics] isBiometricAvailable error:', String(e));
    return false;
  }
}

// ─── Biometric-prompt-in-progress guard ──────────────────────────────────────
// While a native biometric dialog (Face ID / Touch ID) is on screen, iOS pushes
// the app to the 'inactive' AppState — indistinguishable, to AppState listeners,
// from the user leaving the app. useAppLock consults this flag so it does NOT
// render the privacy cover or stamp a background timestamp during a biometric
// prompt that the app itself triggered as part of its own auth flow.
// The short cooldown after the prompt resolves covers the window where the app
// transitions back to 'active' as the dialog dismisses.

let biometricPromptActive = false;
let biometricPromptCooldownUntil = 0;
const BIOMETRIC_PROMPT_COOLDOWN_MS = 800;

export function isBiometricPromptInProgress(): boolean {
  return biometricPromptActive || Date.now() < biometricPromptCooldownUntil;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

export async function promptBiometric(reason: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  biometricPromptActive = true;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (__DEV__) console.log('[biometrics] promptBiometric result:', result);
    return result.success;
  } catch (e) {
    if (__DEV__) console.warn('[biometrics] promptBiometric error:', String(e));
    return false;
  } finally {
    biometricPromptActive = false;
    biometricPromptCooldownUntil = Date.now() + BIOMETRIC_PROMPT_COOLDOWN_MS;
  }
}

// ─── Per-child biometric token ────────────────────────────────────────────────
// The token is a random string stored in SecureStore under a key scoped to the
// child's UUID. Its presence means biometric login is active for that child
// on this device. The DB RPC performs the actual authentication check
// (biometric_enabled = true AND last_device_id = deviceId).

export async function hasBiometricForChild(childId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const key   = tokenKey(childId);
  const token = await secureGet(key);
  const has   = !!token;
  if (__DEV__) console.log('[biometrics] hasBiometricForChild', childId.slice(0, 8), '→', has, '(key:', key + ')');
  return has;
}

export async function saveBiometricForChild(childId: string): Promise<{ rawToken: string; tokenHash: string }> {
  const bytes    = await Crypto.getRandomBytesAsync(32);
  const rawToken = bytesToHex(bytes);
  const tokenHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawToken,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  await secureSet(tokenKey(childId), rawToken);
  if (__DEV__) console.log('[biometrics] saveBiometricForChild: wrote token to', tokenKey(childId));
  return { rawToken, tokenHash };
}

export async function getBiometricTokenForChild(childId: string): Promise<string | null> {
  return secureGet(tokenKey(childId));
}

export async function clearBiometricForChild(
  childId: string,
  opts?: { keepLastChild?: boolean },
): Promise<void> {
  const stored = await secureGet(LAST_CHILD_KEY);
  const dropLastChild = stored === childId && !opts?.keepLastChild;
  if (__DEV__) console.log('[biometrics] clearBiometricForChild', childId.slice(0, 8), 'dropLastChild:', dropLastChild);
  await Promise.all([
    secureDel(tokenKey(childId)),
    secureDel(declinedKey(childId)),
    ...(dropLastChild ? [secureDel(LAST_CHILD_KEY)] : []),
  ]);
}

// ─── Last-child persistence (survives logout) ────────────────────────────────
// Stores the childId of the most recently authenticated child in SecureStore so
// WhoIsLoggingInScreen can offer Face ID after logout or a cold app restart,
// even though the regular AsyncStorage cache is cleared on logout.

export async function setLastChildForBiometric(childId: string): Promise<void> {
  await secureSet(LAST_CHILD_KEY, childId);
  if (__DEV__) console.log('[biometrics] setLastChildForBiometric:', childId.slice(0, 8));
}

export async function getLastChildForBiometric(): Promise<string | null> {
  const id = await secureGet(LAST_CHILD_KEY);
  if (__DEV__) console.log('[biometrics] getLastChildForBiometric:', id ? id.slice(0, 8) : 'null');
  return id;
}

// ─── Last-parent persistence (survives logout and app restart) ────────────────
// Stores the parent UUID so ParentPasscodeScreen can identify the parent for
// PIN verification when the AsyncStorage userId cache is stale or the parent
// has not done a fresh email login in this session.
// Contains only the UUID — no passcode or hash is stored here.

export async function setLastParentForPasscode(parentId: string): Promise<void> {
  await secureSet(LAST_PARENT_KEY, parentId);
}

export async function getLastParentForPasscode(): Promise<string | null> {
  return secureGet(LAST_PARENT_KEY);
}

// ─── Declined state ───────────────────────────────────────────────────────────
// Tracks whether a child tapped "Not Now" on the biometric setup prompt.
// The declined flag is child-and-device-specific so future logins don't
// auto-prompt the same child again, while a sibling or new child gets a
// fresh setup offer after their own first successful username/password login.

export async function setBiometricDeclined(childId: string): Promise<void> {
  const key = declinedKey(childId);
  await secureSet(key, '1');
  if (__DEV__) console.log('[biometrics] setBiometricDeclined:', childId.slice(0, 8));
}

export async function isBiometricDeclined(childId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const key = declinedKey(childId);
  const val = await secureGet(key);
  const declined = val === '1';
  if (__DEV__) console.log('[biometrics] isBiometricDeclined', childId.slice(0, 8), '→', declined);
  return declined;
}

export async function clearBiometricDeclined(childId: string): Promise<void> {
  await secureDel(declinedKey(childId));
}
