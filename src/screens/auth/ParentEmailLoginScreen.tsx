import React, { useState } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { cache } from '../../lib/cache';
import { navigateToParentDash } from '../../lib/parentAccessGuard';
import { setLastParentForPasscode, getDeviceId } from '../../lib/biometrics';
import { registerPushToken } from '../../lib/notifications';

const GREEN = '#C8E8CB';
const GREEN_DARK = '#3D7A45';
const BG = '#F2F2F7';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ParentEmailLogin'> };

export const ParentEmailLoginScreen: React.FC<Props> = ({ navigation }) => {
  const { setParent, setChild, setIsChildLoggedIn, setUserId, setChildId } = useApp();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passFocused, setPassFocused]   = useState(false);
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  const canContinue = email.trim().length > 0 && password.length > 0;

  const login = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await db.loginParent(email.trim().toLowerCase(), password);
      if (!result) {
        setError('Email or password is incorrect.');
        return;
      }
      const { userId, parent: par, child: ch } = result;

      setUserId(userId);
      await cache.saveUserId(userId);
      setLastParentForPasscode(userId).catch(() => {});

      setParent(prev => ({
        ...prev,
        firstName:       par.first_name ?? '',
        lastName:        par.last_name ?? '',
        displayName:     par.display_name || par.first_name || '',
        mobile:          par.mobile ?? '',
        address:         par.address ?? '',
        safetyPoolLimit:     par.safety_pool_limit ?? 0,
        safetyPoolUsed:      par.safety_pool_used ?? 0,
        weeklyAllowance:     par.weekly_allowance ?? 0,
        allowanceFrequency:  par.allowance_frequency ?? 'weekly',
        allowanceNextPayment: par.allowance_next_payment ?? '',
        allowanceActive:     par.allowance_active ?? false,
        passcode:               '',
        passcodeCreated:        par.passcode_created ?? false,
        marketingNotifications: par.marketing_notifications ?? false,
        profileImageUrl:        par.profile_image_url ?? undefined,
        email:                  email.trim().toLowerCase(),
      }));

      if (ch) {
        setChildId(ch.id);
        setChild(prev => ({
          ...prev,
          displayName:   ch.display_name,
          username:      ch.username,
          avatarEmoji:   ch.avatar_emoji,
          profileImageUrl: ch.profile_image_url ?? undefined,
          trustScore:    ch.trust_score,
          balance:       ch.wallet_balance,
          loanedOut:     ch.loaned_out,
          borrowed:      ch.borrowed,
          streak:        ch.streak,
          repaid:        ch.repaid,
          missed:        ch.missed,
          totalBorrowed: ch.total_borrowed,
          totalLent:     ch.total_lent,
          points:        ch.points,
          age:           ch.age,
          mobile:        ch.mobile ?? '',
        }));
      }

      // Register parent device for push notifications (best-effort).
      // deviceId lets register_parent_device_token reclaim a stale token left
      // behind on this physical device by a different parent test account
      // (M070) — fetched here rather than blocking login on it.
      getDeviceId()
        .then(deviceId => registerPushToken(userId, 'parent', undefined, deviceId))
        .catch(() => {});

      // Email + password is full authentication.
      // First-time parents (no passcode yet) must create their PIN.
      // All paths then run through the central Safety Pool guard before entering the dashboard.
      if (!par.passcode_created) {
        navigation.navigate('ParentPasscode', { mode: 'create', onSuccess: 'ParentTabs' });
      } else {
        await navigateToParentDash(navigation, userId);
      }
    } catch (err) {
      Alert.alert('Login failed', 'Please check your email and password.');
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
        <Ionicons name="chevron-back" size={26} color="#1C1C1E" />
      </TouchableOpacity>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.sub}>Sign in with your parent account email and password.</Text>

          <View style={[styles.inputWrap, emailFocused && styles.inputFocused]}>
            <TextInput
              style={styles.input}
              placeholder="Email address"
              placeholderTextColor="#AEAEB2"
              value={email}
              onChangeText={t => { setEmail(t); setError(''); }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onFocus={() => setEmailFocused(true)}
              onBlur={() => setEmailFocused(false)}
            />
          </View>

          <View style={[styles.inputWrap, styles.inputWrapRow, passFocused && styles.inputFocused]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Password"
              placeholderTextColor="#AEAEB2"
              value={password}
              onChangeText={t => { setPassword(t); setError(''); }}
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

          {!!error && <Text style={styles.errorText}>{error}</Text>}
        </View>

        <View style={{ flex: 1, minHeight: 8 }} />

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.btn, (!canContinue || loading) && styles.btnDisabled]}
            onPress={login}
            disabled={!canContinue || loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#1F2937" />
              : <Text style={styles.btnText}>Sign in</Text>
            }
          </TouchableOpacity>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  back:    { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  content: { paddingHorizontal: 24, paddingTop: 16 },

  title: { fontSize: 28, fontWeight: '800', color: '#1C1C1E', marginBottom: 10 },
  sub:   { fontSize: 16, color: '#3C3C43', lineHeight: 24, marginBottom: 32 },

  inputWrap: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#D1D1D6',
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 16,
  },
  inputWrapRow: { flexDirection: 'row', alignItems: 'center' },
  inputFocused: { borderColor: GREEN },

  input: { fontSize: 17, color: '#1C1C1E', padding: 0 },

  errorText: { color: '#FF3B30', fontSize: 13, marginTop: -8 },

  footer: { paddingHorizontal: 24, paddingBottom: 16, paddingTop: 8, backgroundColor: BG },
  btn: {
    backgroundColor: GREEN,
    borderRadius: 50,
    paddingVertical: 18,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  btnText:     { color: '#1F2937', fontSize: 17, fontWeight: '700' },
});
