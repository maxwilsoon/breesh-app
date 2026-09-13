import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Switch, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import {
  isBiometricAvailable, promptBiometric, getDeviceId,
  saveBiometricForChild, clearBiometricForChild,
} from '../../lib/biometrics';

const Row: React.FC<{ label: string; value: string; isLast?: boolean }> = ({ label, value, isLast }) => (
  <View style={[styles.row, !isLast && styles.rowBorder]}>
    <Text style={styles.rowLabel}>{label}</Text>
    <Text style={styles.rowValue}>{value}</Text>
  </View>
);

export const ChildSettingsScreen: React.FC = () => {
  const navigation = useNavigation();
  const { child, childId, childSessionToken, biometricEnabled, setBiometricEnabled } = useApp();
  const initial = child.displayName.charAt(0).toUpperCase();
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      isBiometricAvailable().then(setBioAvailable);
    }
  }, []);

  const handleToggleBiometric = async (value: boolean) => {
    if (!childId) return;
    setBioLoading(true);
    try {
      if (value) {
        // Enable — require one biometric prompt to confirm
        const ok = await promptBiometric('Verify your identity to enable Face ID');
        if (!ok) { setBioLoading(false); return; }
        const deviceId = await getDeviceId();
        const { tokenHash } = await saveBiometricForChild(childId);
        if (!childSessionToken) throw new Error('No active session');
        await db.enableBiometric(childId, deviceId, tokenHash, childSessionToken);
        setBiometricEnabled(true);
      } else {
        // Disable — confirm then clear
        const confirm = () => new Promise<boolean>(resolve => {
          Alert.alert('Disable Face ID', 'Are you sure you want to disable Face ID login?', [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Disable', style: 'destructive', onPress: () => resolve(true) },
          ]);
        });
        const confirmed = await confirm();
        if (!confirmed) { setBioLoading(false); return; }
        await clearBiometricForChild(childId);
        const deviceId = await getDeviceId();
        if (!childSessionToken) throw new Error('No active session');
        await db.disableBiometric(childId, childSessionToken, deviceId);
        setBiometricEnabled(false);
      }
    } catch {
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      setBioLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color="#1A1A3E" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <View style={styles.avatarWrap}>
            {child.profileImageUrl ? (
              <View style={styles.avatarPhotoWrap}>
                <Image source={{ uri: child.profileImageUrl }} style={styles.avatarPhoto} resizeMode="cover" />
              </View>
            ) : (
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarEmoji}>{child.avatarEmoji || initial}</Text>
              </View>
            )}
            <TouchableOpacity style={styles.editBtn} onPress={() => navigation.navigate('AvatarPicker' as never)}>
              <Ionicons name="pencil" size={13} color="#555" />
            </TouchableOpacity>
          </View>
          <Text style={styles.name}>{child.displayName}</Text>
          <Text style={styles.ageLine}>Age {child.age}</Text>
        </View>

        {/* Contact details */}
        <View style={styles.section}>
          <Row label="Mobile number" value={child.mobile || 'Not set'} isLast />
        </View>

        {/* Login details */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>Your login details</Text>
          <Row label="Username" value={child.username} />
          <Row label="Password" value="••••••••" isLast={false} />
          <Row label="Date of birth" value={child.age ? `Age ${child.age}` : 'Not set'} isLast />
        </View>

        {/* Security — only on native with biometric hardware */}
        {bioAvailable && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>Security</Text>
            <View style={[styles.row, styles.rowBorder]}>
              <View style={styles.rowLeft}>
                <MaterialCommunityIcons name="face-recognition" size={22} color="#2E7D32" style={{ marginRight: 12 }} />
                <View>
                  <Text style={styles.rowLabel}>Face ID</Text>
                  <Text style={styles.rowSubLabel}>Sign in with biometrics</Text>
                </View>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={handleToggleBiometric}
                disabled={bioLoading}
                trackColor={{ false: '#E5E7EB', true: '#C8E8CB' }}
                thumbColor={biometricEnabled ? '#2E7D32' : '#fff'}
              />
            </View>
          </View>
        )}

        {/* Privacy & Safety */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>Privacy & Safety</Text>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            onPress={() => navigation.navigate('BlockedUsers' as never)}
            activeOpacity={0.7}
          >
            <View style={styles.rowLeft}>
              <Ionicons name="ban-outline" size={22} color="#DC2626" style={{ marginRight: 12 }} />
              <Text style={styles.rowLabel}>Blocked Users</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingVertical: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1A1A3E' },
  scroll: { paddingBottom: 40 },

  avatarSection: { alignItems: 'center', paddingTop: 24, paddingBottom: 32 },
  avatarWrap: { position: 'relative', marginBottom: 14 },
  avatarPhotoWrap: { width: 100, height: 100, borderRadius: 50, overflow: 'hidden' },
  avatarPhoto: { width: 100, height: 100 },
  avatarCircle: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#3D8B6E',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitial: { fontSize: 44, fontWeight: '700', color: '#fff' },
  avatarEmoji: { fontSize: 52 },
  editBtn: {
    position: 'absolute', bottom: 2, right: 2,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#F0F0F0',
    borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  name: { fontSize: 22, fontWeight: '800', color: '#1A1A3E', marginBottom: 4 },
  ageLine: { fontSize: 15, color: '#9CA3AF' },

  section: {
    borderTopWidth: 1, borderTopColor: '#E5E7EB',
  },
  sectionHeader: {
    fontSize: 15, fontWeight: '700', color: '#1A1A3E',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 18,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  rowLabel: { fontSize: 16, color: '#1A1A3E' },
  rowValue: { fontSize: 16, color: '#9CA3AF' },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowSubLabel: { fontSize: 13, color: '#9CA3AF', marginTop: 1 },
});
