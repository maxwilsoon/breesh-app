import { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { cache } from '../lib/cache';
import { navigationRef } from '../navigation';
import { useApp } from '../context/AppContext';
import { isBiometricPromptInProgress } from '../lib/biometrics';

// How long the app may sit in the background before returning to it forces a
// full re-login. Overridable via env for testing — set
// EXPO_PUBLIC_INACTIVITY_TIMEOUT_MS=10000 in .env.local to make it 10s, then
// remove the line to restore the 5-minute default (no code change to revert).
export const INACTIVITY_TIMEOUT_MS =
  Number(process.env.EXPO_PUBLIC_INACTIVITY_TIMEOUT_MS) || 5 * 60 * 1000;

// Screens shown before a session exists — there is nothing to time out on these,
// so backgrounding here never triggers a logout. Anything NOT in this set is
// treated as an authenticated area (fail-secure for screens added later).
const PUBLIC_ROUTES = new Set<string>([
  'Carousel', 'Email', 'Password', 'Mobile', 'Notifications', 'DisplayName',
  'Identity', 'Address', 'HomeAddress', 'Verifying', 'ChildDetails', 'SafetyPool',
  'SelectAccount', 'WhoIsLoggingIn', 'GetApp', 'ParentEmailLogin', 'ChildLogin',
  'ParentPasscode', 'BiometricLogin',
]);

const inAuthenticatedArea = (): boolean => {
  if (!navigationRef.isReady()) return false;
  const route = navigationRef.getCurrentRoute()?.name;
  return !!route && !PUBLIC_ROUTES.has(route);
};

/**
 * Centralised app-lock behaviour. Mount ONCE near the root (see AppLockOverlay):
 *  - stamps the time whenever the app is backgrounded during an authed session
 *  - on return, logs the user fully out if they were away >= INACTIVITY_TIMEOUT_MS
 *  - exposes `covered` so a privacy screen can hide content in the app switcher
 */
export function useAppLock() {
  const { autoLogout } = useApp();
  const [covered, setCovered] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  // In-memory copy of the background timestamp; the AsyncStorage copy is the
  // fallback for when the OS kills the process while backgrounded.
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    const resolveTimeout = async (): Promise<boolean> => {
      const stamp = backgroundedAt.current ?? (await cache.loadBackgroundedAt());
      backgroundedAt.current = null;
      await cache.clearBackgroundedAt();
      const expired = !!stamp && Date.now() - stamp >= INACTIVITY_TIMEOUT_MS;
      if (expired && inAuthenticatedArea()) {
        await autoLogout();
        return true;
      }
      return false;
    };

    // Cold start after a background-kill: honour a timer that outlived the
    // process, otherwise drop the stale stamp so it can't fire later.
    resolveTimeout();

    const handleChange = async (next: AppStateStatus) => {
      const prev = appState.current;
      appState.current = next;

      // A native biometric dialog (Face ID / Touch ID) that the app triggered
      // itself pushes iOS to 'inactive' — this is not the user leaving the app.
      // Skip the privacy cover AND the background-timestamp tracking so a
      // legitimate in-app auth prompt never trips the app lock.
      if (isBiometricPromptInProgress()) {
        setCovered(false);
        return;
      }

      // Privacy cover: hide content the instant the app is not active.
      setCovered(next !== 'active');

      const leftForeground =
        (next === 'background' || next === 'inactive') && prev === 'active';
      const returnedToForeground =
        next === 'active' && (prev === 'background' || prev === 'inactive');

      if (leftForeground) {
        if (inAuthenticatedArea()) {
          const now = Date.now();
          backgroundedAt.current = now;
          await cache.saveBackgroundedAt(now);
        }
        return;
      }

      if (returnedToForeground) {
        await resolveTimeout();
      }
    };

    const sub = AppState.addEventListener('change', handleChange);
    return () => sub.remove();
  }, [autoLogout]);

  return { covered };
}
