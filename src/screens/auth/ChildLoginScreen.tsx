import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  TextInput, TouchableOpacity, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { cache } from '../../lib/cache';
import { registerPushToken } from '../../lib/notifications';
import {
  getDeviceId, isBiometricAvailable,
  saveBiometricForChild, hasBiometricForChild, isBiometricDeclined, clearBiometricDeclined,
  setLastChildForBiometric, setLastParentForPasscode,
} from '../../lib/biometrics';
import { saveChildSession } from '../../lib/childSession';

const GREEN = '#C8E8CB';
const GREEN_DARK = '#3D7A45';
const BG = '#E8F5E9';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ChildLogin'>;
  route: { params?: { sessionExpired?: boolean } };
};

export const ChildLoginScreen: React.FC<Props> = ({ navigation, route }) => {
  const { child, setChild, childId, setChildId, setParent, setUserId, setIsChildLoggedIn, setCircle, setPendingRequests, setBiometricEnabled, setFrozenAccount, setParentDebt, setChildSessionToken } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass]  = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [userFocused, setUserFocused] = useState(false);
  const [passFocused, setPassFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const sessionExpired = route.params?.sessionExpired === true;
  // True when this device has a record that the cached child previously
  // declined Face ID setup — used to show the opt-in link.
  const [showBioSetupLink, setShowBioSetupLink] = useState(false);

  // Check declined state for the cached child on mount so we can show
  // the "Set up Face ID" link without waiting for a login attempt.
  useEffect(() => {
    if (Platform.OS === 'web' || !childId) return;
    isBiometricAvailable().then(async available => {
      if (!available) return;
      const declined = await isBiometricDeclined(childId);
      setShowBioSetupLink(declined);
    }).catch(() => {});
  }, [childId]);

  const canContinue = username.trim().length > 0 && password.length > 0;

  const login = async () => {
    const u = username.trim().toLowerCase();
    const p = password;

    // Always authenticate via Supabase so the DB can verify parent ownership.
    // Never use cached credentials — stale state from a previous session could
    // grant access to a different family's child account.
    setLoading(true);
    setLoginError('');
    if (__DEV__) console.log('[ChildLogin] platform:', Platform.OS, '— Continue pressed');
    try {
      const deviceId = await getDeviceId();
      if (__DEV__) console.log('[ChildLogin] deviceId present:', !!deviceId, 'length:', deviceId.length);
      const result = await db.loginChild(u, p, deviceId);
      if (__DEV__) console.log('[ChildLogin] RPC result:', result ? 'ok' : 'null/invalid credentials');
      if (!result) {
        setUsernameError('Username or password incorrect.');
        setPasswordError(' ');
        return;
      }
      const { child: row, parent: par, session_token, session_expires_at } = result;
      if (__DEV__) console.log('[ChildLogin] session_token present:', !!session_token);
      setChild(c => ({
        ...c,
        displayName:   row.display_name,
        username:      row.username,
        avatarEmoji:     row.avatar_emoji,
        profileImageUrl: row.profile_image_url ?? undefined,
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
      setFrozenAccount(row.account_frozen ?? false);
      setParentDebt(row.parent_debt ?? 0);
      if (par) {
        setParent(prev => ({
          ...prev,
          firstName:       par.first_name ?? '',
          lastName:        par.last_name ?? '',
          displayName:     par.display_name || par.first_name || '',
          // mobile and address are not returned from child login (migration 015).
          // Preserve any value already in context/cache rather than overwriting with ''.
          mobile:          par.mobile  ?? prev.mobile,
          address:         par.address ?? prev.address,
          safetyPoolLimit:     par.safety_pool_limit ?? 0,
          safetyPoolUsed:      par.safety_pool_used ?? 0,
          weeklyAllowance:     par.weekly_allowance ?? 0,
          allowanceFrequency:  par.allowance_frequency ?? 'weekly',
          allowanceNextPayment: par.allowance_next_payment ?? '',
          allowanceActive:     par.allowance_active ?? false,
          passcodeCreated: par.passcode_created ?? prev.passcodeCreated,
          marketingNotifications: par.marketing_notifications ?? false,
          profileImageUrl:        par.profile_image_url ?? undefined,
        }));
      }
      setChildId(row.id);
      // Save session token to secure storage and context.
      // Native: iOS Keychain / Android Keychain via SecureStore.
      // Web: sessionStorage (cleared when tab closes). Never logged.
      if (session_token) {
        await saveChildSession(row.id, session_token, session_expires_at ?? '');
        setChildSessionToken(session_token);
        if (__DEV__) console.log('[ChildLogin] session storage succeeded');
      }
      await cache.saveChild({ username: row.username, childId: row.id });
      // Persist childId in SecureStore so WhoIsLoggingInScreen can offer Face ID
      // on the next visit even after logout clears the AsyncStorage cache.
      setLastChildForBiometric(row.id).catch(() => {});
      // Set the parent's userId from the login response so PasscodeScreen can
      // identify the parent for PIN verification even without a prior parent email
      // login in this session. Also persist to cache and SecureStore so the
      // value survives a fresh app restart.
      if (par?.id) {
        setUserId(par.id);
        cache.saveUserId(par.id).catch(() => {});
        setLastParentForPasscode(par.id).catch(() => {});
      }

      // Register device for push notifications (best-effort, won't block login)
      registerPushToken(row.id, 'child', session_token, deviceId).catch(() => {});

      // Load circle + pending requests — each independently so one failure can't block another
      db.getCircle(row.id, session_token, deviceId).then(members => {
        setCircle(members.map(m => ({
          id: m.id, displayName: m.display_name,
          username: m.username, avatarEmoji: m.avatar_emoji, trustScore: m.trust_score,
          profileImageUrl: m.avatar_url ?? undefined,
        })));
      }).catch(() => {});

      db.getPendingRequests(row.id, session_token, deviceId).then(requests => {
        setPendingRequests(requests.map(r => ({
          requestId: r.request_id, id: r.id, displayName: r.display_name,
          username: r.username, avatarEmoji: r.avatar_emoji,
          trustScore: r.trust_score, createdAt: r.created_at,
          profileImageUrl: r.avatar_url ?? undefined,
        })));
      }).catch(() => {});


      setIsChildLoggedIn(true);
      if (__DEV__) console.log('[ChildLogin] AppContext updated, isChildLoggedIn=true');

      // Decide whether to offer Face ID setup or go straight to the dashboard.
      // All biometric checks are best-effort — any failure falls back to ChildTabs.
      let destination: 'BiometricSetup' | 'ChildTabs' = 'ChildTabs';
      if (Platform.OS !== 'web') {
        try {
          const biometricsAvailable = await isBiometricAvailable();
          if (biometricsAvailable) {
            // Treat the child as already opted-in if the DB has biometric enabled
            // OR a token for this child still exists in SecureStore on this device.
            // (Don't require last_device_id to match — enableBiometric below rewrites
            // it, and requiring a match forced a redundant "set up Face ID again"
            // screen after a session expiry or device-id refresh.)
            const enrolledLocally = await hasBiometricForChild(row.id);
            if (row.biometric_enabled || enrolledLocally) {
              // Re-generate the CSPRNG token, update the DB hash, and refresh
              // SecureStore — silently. No setup screen, straight to the dashboard.
              const { tokenHash } = await saveBiometricForChild(row.id);
              await db.enableBiometric(row.id, deviceId, tokenHash, session_token);
              setBiometricEnabled(true);
            } else {
              // Not yet set up (new account or new device).
              // Only show the setup prompt if the child hasn't already declined.
              const declined = await isBiometricDeclined(row.id);
              if (!declined) destination = 'BiometricSetup';
            }
          }
        } catch {
          // Native module unavailable (Expo Go) — skip silently
        }
      }

      if (__DEV__) console.log('[ChildLogin] navigating to:', destination);
      navigation.navigate(destination);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (__DEV__) console.error('[ChildLogin] error:', msg);
      // Alert.alert is a no-op on React Native Web — show an inline error instead.
      if (msg.includes('not_authorized')) {
        setLoginError(
          "This account isn't linked to the parent signed in on this device. " +
          'Ask a parent to sign out first, or use the child’s own device.'
        );
      } else if (msg.includes('rate_limit_exceeded')) {
        setLoginError('Too many failed attempts. Please wait a few minutes before trying again.');
      } else if (msg.includes('invalid_credentials') || msg.includes('incorrect')) {
        setUsernameError('Username or password incorrect.');
        setPasswordError(' ');
      } else if (msg.includes('network') || msg.includes('fetch')) {
        setLoginError('Network error — check your connection and try again.');
      } else if (msg.includes('RPC') || msg.includes('not found')) {
        setLoginError('Service unavailable — please try again.');
      } else {
        setLoginError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <TouchableOpacity
        style={styles.back}
        onPress={() => navigation.goBack()}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="chevron-back" size={26} color="#1A1A3E" />
      </TouchableOpacity>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {sessionExpired && (
            <View style={styles.sessionBanner}>
              <Text style={styles.sessionBannerText}>Your session expired. Please sign in again.</Text>
            </View>
          )}
          <Text style={styles.title}>Hi 👋 let's log in</Text>
          <Text style={styles.sub}>
            Ask your parent or guardian for your login details.{' '}
            <Text
              style={styles.link}
              onPress={() => Alert.alert('Login details', 'Ask your parent to open the Breesh app and go to your profile to find your login details.')}
            >
              How do I get my login details?
            </Text>
          </Text>

          <View style={[styles.inputWrap, userFocused && styles.inputFocused, !!usernameError && styles.inputError]}>
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor="#AEAEB2"
              value={username}
              onChangeText={t => { setUsername(t); setUsernameError(''); setPasswordError(''); setLoginError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onFocus={() => setUserFocused(true)}
              onBlur={() => setUserFocused(false)}
            />
          </View>
          {usernameError
            ? <Text style={styles.errorText}>{usernameError}</Text>
            : (
              <TouchableOpacity onPress={() => Alert.alert('Forgot username?', 'Ask your parent to check the app for your username.')}>
                <Text style={styles.forgotLink}>Forgot username?</Text>
              </TouchableOpacity>
            )
          }

          <View style={[styles.inputWrap, styles.inputWrapRow, passFocused && styles.inputFocused, !!passwordError && styles.inputError]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Password"
              placeholderTextColor="#AEAEB2"
              value={password}
              onChangeText={t => { setPassword(t); setPasswordError(''); setUsernameError(''); setLoginError(''); }}
              secureTextEntry={!showPass}
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={() => setPassFocused(true)}
              onBlur={() => setPassFocused(false)}
            />
            <TouchableOpacity onPress={() => setShowPass(v => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={22} color="#AEAEB2" />
            </TouchableOpacity>
          </View>
          {passwordError
            ? <Text style={styles.errorText}>{passwordError}</Text>
            : (
              <TouchableOpacity onPress={() => Alert.alert('Forgot password?', 'Ask your parent to reset your password in the Breesh app.')}>
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </TouchableOpacity>
            )
          }

          <View style={{ flex: 1, minHeight: 24 }} />

          <View style={styles.footer}>
            {!!loginError && (
              <View style={styles.loginErrorBanner}>
                <Text style={styles.loginErrorText}>{loginError}</Text>
              </View>
            )}
            <TouchableOpacity
              style={[styles.btn, (!canContinue || loading) && styles.btnDisabled]}
              onPress={login}
              disabled={!canContinue || loading}
              activeOpacity={0.85}
            >
              {loading
                ? <ActivityIndicator color="#1F2937" />
                : <Text style={styles.btnText}>Continue</Text>
              }
            </TouchableOpacity>

            {/* Shown only after the cached child has previously declined Face ID —
                lets them opt in later without being prompted automatically. */}
            {showBioSetupLink && (
              <TouchableOpacity
                style={styles.bioSetupLink}
                onPress={async () => {
                  if (childId) await clearBiometricDeclined(childId);
                  setShowBioSetupLink(false);
                  Alert.alert(
                    'Face ID',
                    "You'll be asked to set up Face ID after you sign in.",
                    [{ text: 'OK' }],
                  );
                }}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons name="face-recognition" size={16} color={GREEN_DARK} style={{ marginRight: 6 }} />
                <Text style={styles.bioSetupLinkText}>Set up Face ID</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: BG },
  back:   { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16 },

  sessionBanner: { backgroundColor: '#FFF3CD', borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#FBBF24' },
  sessionBannerText: { color: '#92400E', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  title: { fontSize: 28, fontWeight: '800', color: '#1A1A3E', marginBottom: 10 },
  sub:   { fontSize: 16, color: '#3C3C43', lineHeight: 24, marginBottom: 32 },
  link:  { color: GREEN_DARK, fontWeight: '600' },

  inputWrap: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#D1D1D6',
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 8,
  },
  inputWrapRow:  { flexDirection: 'row', alignItems: 'center' },
  inputFocused:  { borderColor: GREEN },
  inputError:    { borderColor: '#FF3B30' },

  input: { fontSize: 17, color: '#1A1A3E', padding: 0 },

  forgotLink: { color: GREEN_DARK, fontSize: 14, fontWeight: '600', marginBottom: 24 },
  errorText:  { color: '#FF3B30', fontSize: 13, marginBottom: 20 },

  footer: { paddingBottom: 16, paddingTop: 8 },
  btn: {
    backgroundColor: GREEN,
    borderRadius: 50,
    paddingVertical: 18,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  btnText:     { color: '#1F2937', fontSize: 17, fontWeight: '700' },

  bioSetupLink: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', paddingVertical: 12, marginTop: 4,
  },
  bioSetupLinkText: { color: GREEN_DARK, fontSize: 14, fontWeight: '600' },

  loginErrorBanner: {
    backgroundColor: '#FFF0F0',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FF3B30',
    padding: 12,
    marginBottom: 12,
  },
  loginErrorText: { color: '#C0392B', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
