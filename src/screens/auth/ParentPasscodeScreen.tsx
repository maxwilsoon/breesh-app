import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Vibration, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { navigateToParentDash } from '../../lib/parentAccessGuard';
import { getLastParentForPasscode, getDeviceId } from '../../lib/biometrics';
import { supabase } from '../../lib/supabase';
import { getExpoPushToken } from '../../lib/notifications';

const GREEN_DARK = '#3D7A45';
const PAD = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
// Mirrors the server-side blocklist in supabase/20260803_034_bcrypt_passcode.sql —
// checked client-side too so a weak PIN is caught on the first entry, not after
// the parent has typed it twice and hit the set_parent_passcode RPC.
const WEAK_PINS = [
  '000000','111111','222222','333333','444444',
  '555555','666666','777777','888888','999999',
  '123456','654321','012345','543210',
];

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ParentPasscode'>;
  route: RouteProp<RootStackParamList, 'ParentPasscode'>;
};

export const ParentPasscodeScreen: React.FC<Props> = ({ navigation, route }) => {
  const { mode, pinToConfirm, onSuccess } = route.params;
  const { parent, setParent, savePasscodeToDb, userId, setUserId } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState(false);
  const [throttleMsg, setThrottleMsg] = useState('');

  // In 'enter' mode, ensure userId is available (needed for server-side PIN verification).
  // When userId is missing from context (e.g. after child logout + app restart),
  // fall back to the SecureStore key written at child/parent login time.
  useEffect(() => {
    if (mode !== 'enter') return;
    if (parent.passcodeCreated) return;
    (async () => {
      let effectiveUserId = userId;
      if (!effectiveUserId) {
        effectiveUserId = await getLastParentForPasscode();
        if (effectiveUserId) setUserId(effectiveUserId);
      }
      if (!effectiveUserId) {
        navigation.replace('ParentEmailLogin');
        return;
      }
      // Device-bound UUID found — proceed with PIN entry.
    // verify_parent_passcode returns false for null hash (passcode not yet configured)
    // identically to a wrong PIN; the "Sign in with email" footer link is the fallback.
    })();
  }, []);

  const firstName = (parent.displayName || 'there').split(' ')[0];

  const headings = {
    create:  { title: 'Create your PIN',  sub: 'Choose a 6-digit parent PIN' },
    confirm: { title: 'Confirm your PIN', sub: 'Re-enter your PIN to confirm' },
    enter:   { title: `Hi ${firstName}`,  sub: 'Enter your 6-digit parent PIN' },
  };
  const { title, sub } = headings[mode];

  const shake = (msg?: string) => {
    Vibration.vibrate(400);
    setError(true);
    if (msg) setThrottleMsg(msg);
    setTimeout(() => { setCode(''); setError(false); }, 700);
  };

  const press = async (key: string) => {
    setThrottleMsg('');
    if (key === '⌫') {
      setCode(c => c.slice(0, -1));
      setError(false);
      return;
    }
    if (key === '' || code.length >= 6) return;

    const next = code + key;
    setCode(next);
    if (next.length < 6) return;

    if (mode === 'create') {
      if (WEAK_PINS.includes(next)) {
        shake('That PIN is too simple. Please choose a less predictable 6-digit PIN.');
        return;
      }
      setTimeout(() => {
        navigation.push('ParentPasscode', { mode: 'confirm', pinToConfirm: next, onSuccess });
      }, 150);

    } else if (mode === 'confirm') {
      if (next === pinToConfirm) {
        // Send raw PIN to set_parent_passcode RPC; bcrypt is computed server-side.
        // Do NOT navigate or mark passcodeCreated until the DB write succeeds.
        try {
          await savePasscodeToDb(next);
          setParent(p => ({ ...p, passcodeCreated: true }));
          setTimeout(async () => {
            if (onSuccess === 'ParentTabs') {
              await navigateToParentDash(navigation, userId);
            } else {
              navigation.navigate('SafetyPool');
            }
          }, 150);
        } catch (e: any) {
          if (__DEV__) console.log('[Passcode] PIN save failed — code:', e?.code, 'msg:', e?.message);
          setCode('');
          const msg: string = e?.message ?? '';
          const code: string = e?.code ?? '';
          if (msg === 'no_user_id' || msg === 'no_session' || msg === 'unauthorized' || code === 'unauthorized' || code === '42501') {
            setThrottleMsg('Please sign in with your email again.');
            setTimeout(() => navigation.navigate('ParentEmailLogin'), 1800);
          } else if (msg.includes('rate_limit_exceeded') || code === 'rate_limit_exceeded') {
            setThrottleMsg('Too many attempts. Please wait 30 minutes before trying again.');
          } else if (msg.includes('invalid_pin_format') || code === 'invalid_pin_format') {
            setThrottleMsg('PIN must be exactly 6 digits.');
          } else if (msg.includes('weak_pin') || code === 'weak_pin') {
            setThrottleMsg('That PIN is too simple. Please choose a less predictable 6-digit PIN.');
          } else if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('connection')) {
            setThrottleMsg('Could not save PIN. Please check your connection and try again.');
          } else {
            setThrottleMsg('Could not save PIN. Please try again.');
          }
        }
      } else {
        shake();
      }

    } else {
      // Enter mode — verify PIN server-side; the hash never leaves the DB.
      try {
        // Call the Edge Function: verifies PIN and returns a real Supabase JWT.
        // This establishes a proper Auth session so Edge Functions (e.g. Stripe)
        // work without requiring an email+password login.
        const { data: pinData, error: pinFnErr } = await supabase.functions.invoke(
          'parent-pin-login',
          { body: { parent_id: userId, pin: next } },
        );

        if (pinFnErr || !pinData?.access_token) {
          const msg: string = pinData?.error ?? pinFnErr?.message ?? '';
          if (msg.includes('rate_limit_exceeded')) {
            setCode('');
            setThrottleMsg('Too many failed attempts. Please wait 5 minutes before trying again.');
          } else if (msg === 'invalid_credentials') {
            shake();
          } else {
            shake();
          }
          return;
        }

        // Establish the Supabase Auth session from the returned JWT.
        await supabase.auth.setSession({
          access_token:  pinData.access_token,
          refresh_token: pinData.refresh_token,
        });

        // Register push token (fire-and-forget).
        if (userId) {
          const pin = next;
          Promise.all([getExpoPushToken(), getDeviceId()])
            .then(([expoToken, deviceId]) => {
              if (expoToken) {
                return db.registerParentPushTokenWithPasscode(userId, pin, expoToken, deviceId, Platform.OS);
              }
            })
            .catch(() => {});
        }
        setTimeout(async () => { await navigateToParentDash(navigation, userId); }, 150);
      } catch (e: any) {
        if (String(e?.message).includes('rate_limit_exceeded')) {
          setCode('');
          setThrottleMsg('Too many failed attempts. Please wait 5 minutes before trying again.');
        } else {
          shake();
        }
      }
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Back button */}
      <TouchableOpacity
        style={styles.back}
        onPress={() => navigation.goBack()}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="chevron-back" size={28} color="#fff" />
      </TouchableOpacity>

      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>

        {/* 6 indicator dots */}
        <View style={styles.dots}>
          {[0,1,2,3,4,5].map(i => (
            <View
              key={i}
              style={[
                styles.dot,
                code.length > i && styles.dotFilled,
                error && styles.dotError,
              ]}
            />
          ))}
        </View>

        {!!throttleMsg && (
          <Text style={styles.throttleMsg}>{throttleMsg}</Text>
        )}

        {/* Number pad */}
        <View style={styles.pad}>
          {PAD.map((key, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.keyBtn, key === '' && styles.keyHidden]}
              onPress={() => press(key)}
              disabled={key === ''}
              activeOpacity={0.45}
            >
              {key === '⌫' ? (
                <Ionicons name="backspace-outline" size={28} color="#fff" />
              ) : (
                <Text style={styles.keyText}>{key}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          onPress={() => navigation.navigate('ParentEmailLogin')}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.footerLink}>Sign in with email</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate('WhoIsLoggingIn')}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.footerLink}>Switch account</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: GREEN_DARK },
  back:    { position: 'absolute', top: 56, left: 24, zIndex: 10 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },

  title: { fontSize: 36, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 10 },
  sub:   { fontSize: 16, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginBottom: 48 },

  dots: { flexDirection: 'row', gap: 20, marginBottom: 56 },
  dot: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#fff',
    backgroundColor: 'transparent',
  },
  dotFilled: { backgroundColor: '#fff' },
  dotError:  { backgroundColor: '#FF6B6B', borderColor: '#FF6B6B' },

  throttleMsg: {
    color: '#FF6B6B',
    fontSize: 13,
    textAlign: 'center',
    marginTop: -32,
    marginBottom: 20,
    paddingHorizontal: 24,
  },

  pad:    { flexDirection: 'row', flexWrap: 'wrap', width: '100%', maxWidth: 340 },
  keyBtn: { width: '33.33%', height: 88, alignItems: 'center', justifyContent: 'center' },
  keyHidden: { opacity: 0 },
  keyText:   { fontSize: 34, fontWeight: '600', color: '#fff' },

  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 36,
    paddingBottom: 20,
  },
  footerLink: { fontSize: 15, color: '#fff', fontWeight: '500' },
});
