import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { registerPushToken } from '../../lib/notifications';
import {
  getDeviceId,
  hasBiometricForChild,
  getBiometricTokenForChild,
  promptBiometric,
  clearBiometricForChild,
  setLastChildForBiometric,
  setLastParentForPasscode,
} from '../../lib/biometrics';
import { saveChildSession } from '../../lib/childSession';
import { cache } from '../../lib/cache';

const GREEN = '#C8E8CB';
const GREEN_DARK = '#3D7A45';
const BG = '#E8F5E9';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'BiometricLogin'> };

type Status = 'idle' | 'authenticating' | 'success' | 'failed';

export const BiometricLoginScreen: React.FC<Props> = ({ navigation }) => {
  const {
    setChild, setChildId, childId, setParent, setIsChildLoggedIn,
    setCircle, setPendingRequests, setUserId, setBiometricEnabled,
    setChildSessionToken,
  } = useApp();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const applyLoginResult = useCallback(async (result: { child: Record<string, any>; parent: Record<string, any> }, sessionToken: string, deviceId: string) => {
    const { child: row, parent: par } = result;
    setChild(c => ({
      ...c,
      displayName:   row.display_name,
      username:      row.username,
      avatarEmoji:   row.avatar_emoji,
      avatarUrl:     row.avatar_url ?? undefined,
      trustScore:    row.trust_score,
      balance:       row.wallet_balance,
      loanedOut:     row.loaned_out,
      borrowed:      row.borrowed,
      streak:        row.streak,
      repaid:        row.repaid,
      missed:        row.missed,
      totalBorrowed: row.total_borrowed,
      totalLent:     row.total_lent,
      timesBorrowed: row.times_borrowed ?? 0,
      timesLent:     row.times_lent ?? 0,
      points:        row.points,
      age:           row.age,
      mobile:        row.mobile ?? '',
    }));
    if (par) {
      setUserId(par.id);
      cache.saveUserId(par.id).catch(() => {});
      setLastParentForPasscode(par.id).catch(() => {});
      setParent(prev => ({
        ...prev,
        firstName:       par.first_name ?? '',
        lastName:        par.last_name ?? '',
        displayName:     par.first_name ?? '',
        // mobile and address are not returned from child login (migration 015).
        mobile:          par.mobile  ?? prev.mobile,
        address:         par.address ?? prev.address,
        safetyPoolLimit:        par.safety_pool_limit ?? 50,
        weeklyAllowance:        par.weekly_allowance ?? 10,
        passcodeCreated:        par.passcode_created ?? false,
        marketingNotifications: par.marketing_notifications ?? null,
        profileImageUrl:        par.profile_image_url ?? undefined,
      }));
    }
    setChildId(row.id);
    setBiometricEnabled(true);
    setLastChildForBiometric(row.id).catch(() => {});
    registerPushToken(row.id, 'child', sessionToken, deviceId).catch(() => {});
    db.getCircle(row.id, sessionToken, deviceId).then(members => {
      setCircle(members.map(m => ({
        id: m.id, displayName: m.display_name,
        username: m.username, avatarEmoji: m.avatar_emoji, trustScore: m.trust_score,
      })));
    }).catch(() => {});
    db.getPendingRequests(row.id, sessionToken, deviceId).then(requests => {
      setPendingRequests(requests.map(r => ({
        requestId: r.request_id, id: r.id, displayName: r.display_name,
        username: r.username, avatarEmoji: r.avatar_emoji,
        trustScore: r.trust_score, createdAt: r.created_at,
      })));
    }).catch(() => {});
    setIsChildLoggedIn(true);
  }, [setChild, setChildId, setParent, setIsChildLoggedIn, setCircle, setPendingRequests, setUserId, setBiometricEnabled]);

  const authenticate = useCallback(async () => {
    setStatus('authenticating');
    setErrorMsg('');
    try {
      // Use the childId already in context — it was validated by WhoIsLoggingInScreen
      // (hasBiometricForChild check) before navigating here, so we know the token
      // exists for this specific child on this device.
      if (__DEV__) console.log('[BiometricLogin] authenticate: childId=', childId?.slice(0,8) ?? 'null');
      if (!childId) {
        setStatus('failed');
        setErrorMsg('No saved login found on this device.');
        return;
      }
      // Double-check the child-scoped token still exists (guards against
      // reinstall or explicit disable between WhoIsLoggingIn and this screen).
      const hasBio = await hasBiometricForChild(childId);
      if (__DEV__) console.log('[BiometricLogin] hasBiometricForChild=', hasBio);
      if (!hasBio) {
        setStatus('failed');
        setErrorMsg('Face ID is no longer set up. Please sign in with your password.');
        return;
      }
      const success = await promptBiometric('Unlock your BREESH account');
      if (__DEV__) console.log('[BiometricLogin] promptBiometric success=', success);
      if (!success) {
        setStatus('failed');
        setErrorMsg('Biometric authentication was cancelled or failed.');
        return;
      }
      const deviceId = await getDeviceId();
      if (__DEV__) console.log('[BiometricLogin] calling biometric_login_child RPC');
      const biometricToken = await getBiometricTokenForChild(childId);
      if (!biometricToken) {
        // No credential in SecureStore — biometric was never enrolled or was cleared.
        // Keep LAST_CHILD_KEY so the login flow still knows which child to re-enrol
        // after a password sign-in.
        await clearBiometricForChild(childId, { keepLastChild: true });
        setStatus('failed');
        setErrorMsg('Face ID is no longer set up. Please sign in with your password.');
        return;
      }
      const result = await db.biometricLoginChild(childId, deviceId, biometricToken);
      if (__DEV__) console.log('[BiometricLogin] biometric_login_child result:', result ? 'ok' : 'null (rejected)');
      if (!result) {
        // DB rejected — biometric_token_hash mismatch, disabled, or device changed.
        // Could be a legacy enrollment with no hash — requires re-enrolment.
        // Keep LAST_CHILD_KEY so the password fallback can re-enrol this child.
        await clearBiometricForChild(childId, { keepLastChild: true });
        setStatus('failed');
        setErrorMsg('Face ID login is no longer active. Please sign in with your password.');
        return;
      }
      const { session_token, session_expires_at } = result as any;
      if (session_token) {
        await saveChildSession(childId, session_token, session_expires_at ?? '');
        setChildSessionToken(session_token);
      }
      if (!session_token) {
        await clearBiometricForChild(childId);
        setStatus('failed');
        setErrorMsg('Login succeeded but no session was issued. Please sign in with your password.');
        return;
      }
      setStatus('success');
      await applyLoginResult(result, session_token, deviceId);
      navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'ChildTabs' }] }));
    } catch (e) {
      if (__DEV__) console.warn('[BiometricLogin] authenticate error:', String(e));
      setStatus('failed');
      const eMsg = String((e as any)?.message ?? '');
      if (eMsg.includes('not_authorized')) {
        setErrorMsg(
          "This account isn't linked to the parent signed in on this device. " +
          'Ask a parent to sign out first, or use the child’s own device.'
        );
      } else if (eMsg.includes('rate_limit_exceeded')) {
        setErrorMsg('Too many login attempts. Please wait before trying again.');
      } else {
        setErrorMsg('Something went wrong. Please try again.');
      }
    }
  }, [childId, applyLoginResult, navigation]);

  useEffect(() => {
    authenticate();
  }, []);

  const usePassword = () => {
    navigation.dispatch(
      CommonActions.reset({ index: 0, routes: [{ name: 'WhoIsLoggingIn' }] })
    );
    // Small delay to avoid navigate during reset
    setTimeout(() => navigation.navigate('ChildLogin'), 50);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, status === 'failed' && styles.iconCircleFailed]}>
          {status === 'authenticating'
            ? <ActivityIndicator size="large" color={GREEN_DARK} />
            : status === 'success'
              ? <Ionicons name="checkmark-circle" size={56} color="#34C759" />
              : status === 'failed'
                ? <Ionicons name="alert-circle" size={56} color="#FF3B30" />
                : <MaterialCommunityIcons name="face-recognition" size={56} color={GREEN_DARK} />
          }
        </View>

        <Text style={styles.title}>Unlock with{'\n'}Face ID</Text>

        {status === 'failed' && errorMsg ? (
          <Text style={styles.errorText}>{errorMsg}</Text>
        ) : (
          <Text style={styles.body}>
            {status === 'authenticating'
              ? 'Authenticating…'
              : status === 'success'
                ? 'Success! Signing you in…'
                : 'Authenticate to sign in to your BREESH account.'}
          </Text>
        )}
      </View>

      <View style={styles.footer}>
        {status === 'failed' && (
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={authenticate}
            activeOpacity={0.85}
          >
            <Ionicons name="refresh" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.passwordBtn} onPress={usePassword} activeOpacity={0.7}>
          <Text style={styles.passwordBtnText}>Use Password Instead</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 36,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  iconCircleFailed: { backgroundColor: '#FFF0F0' },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#1A1A3E',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 38,
  },
  body: {
    fontSize: 16,
    color: '#3C3C43',
    textAlign: 'center',
    lineHeight: 24,
  },
  errorText: {
    fontSize: 15,
    color: '#FF3B30',
    textAlign: 'center',
    lineHeight: 22,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 12,
  },
  retryBtn: {
    backgroundColor: GREEN,
    borderRadius: 50,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { color: '#1F2937', fontSize: 17, fontWeight: '700' },
  passwordBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  passwordBtnText: { color: GREEN_DARK, fontSize: 16, fontWeight: '600' },
});
