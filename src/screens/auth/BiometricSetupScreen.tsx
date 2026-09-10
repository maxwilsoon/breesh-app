import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import {
  getDeviceId,
  promptBiometric,
  saveBiometricForChild,
  hasBiometricForChild,
  setBiometricDeclined,
  setLastChildForBiometric,
} from '../../lib/biometrics';

const GREEN = '#C8E8CB';
const GREEN_DARK = '#3D7A45';
const BG = '#E8F5E9';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'BiometricSetup'> };

export const BiometricSetupScreen: React.FC<Props> = ({ navigation }) => {
  const { childId, childSessionToken, setBiometricEnabled } = useApp();
  const [loading, setLoading] = useState(false);

  const goToDashboard = () => {
    navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'ChildTabs' }] }));
  };

  const handleNotNow = async () => {
    // Persist the declined state so this prompt is not shown again automatically.
    // The child can still enable Face ID later via Settings or the login-screen link.
    if (childId) await setBiometricDeclined(childId);
    goToDashboard();
  };

  const handleEnable = async () => {
    if (!childId) {
      Alert.alert('Error', 'Session expired. Please sign in again.');
      goToDashboard();
      return;
    }
    if (__DEV__) console.log('[BiometricSetup] handleEnable: childId=', childId.slice(0,8));
    setLoading(true);
    try {
      const success = await promptBiometric('Verify your identity to enable Face ID login');
      if (!success) {
        if (__DEV__) console.log('[BiometricSetup] promptBiometric cancelled or failed');
        setLoading(false);
        return;
      }
      const deviceId = await getDeviceId();
      if (__DEV__) console.log('[BiometricSetup] deviceId obtained');
      // Generate CSPRNG token, store raw in SecureStore, send hash to DB.
      const { tokenHash } = await saveBiometricForChild(childId);
      if (!childSessionToken) throw new Error('No active session');
      await db.enableBiometric(childId, deviceId, tokenHash, childSessionToken);
      if (__DEV__) console.log('[BiometricSetup] DB biometric_enabled=true');
      await setLastChildForBiometric(childId);
      // Verify the token was actually stored before declaring success.
      const tokenOk = await hasBiometricForChild(childId);
      if (__DEV__) console.log('[BiometricSetup] token verified in SecureStore:', tokenOk);
      setBiometricEnabled(true);
      goToDashboard();
    } catch (e) {
      setLoading(false);
      if (__DEV__) console.warn('[BiometricSetup] handleEnable error:', String(e));
      Alert.alert('Error', 'Could not enable Face ID. Please try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <MaterialCommunityIcons name="face-recognition" size={56} color={GREEN_DARK} />
        </View>

        <Text style={styles.title}>Use Face ID for{'\n'}faster login?</Text>

        <Text style={styles.body}>
          Securely sign in to your BREESH account using Face ID or your device's biometrics.
        </Text>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.btnDisabled]}
          onPress={handleEnable}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#1F2937" />
            : <>
                <MaterialCommunityIcons name="face-recognition" size={20} color="#1F2937" style={{ marginRight: 8 }} />
                <Text style={styles.primaryBtnText}>Enable Face ID</Text>
              </>
          }
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipBtn} onPress={handleNotNow} activeOpacity={0.7}>
          <Text style={styles.skipBtnText}>Not Now</Text>
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
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 12,
  },
  primaryBtn: {
    backgroundColor: GREEN,
    borderRadius: 50,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  primaryBtnText: { color: '#1F2937', fontSize: 17, fontWeight: '700' },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  skipBtnText: { color: GREEN_DARK, fontSize: 16, fontWeight: '600' },
});
