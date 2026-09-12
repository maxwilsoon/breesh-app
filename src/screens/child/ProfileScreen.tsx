import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Image, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { navigationRef } from '../../navigation';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../../theme/colors';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';
import { clearChildSession } from '../../lib/childSession';
import { deregisterCurrentPushToken } from '../../lib/notifications';

interface MenuItemProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  last?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onPress, destructive, last }) => (
  <TouchableOpacity
    style={[styles.menuRow, !last && styles.menuRowBorder]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Ionicons name={icon} size={22} color={destructive ? colors.error : colors.text} style={styles.menuIcon} />
    <Text style={[styles.menuLabel, destructive && { color: colors.error }]}>{label}</Text>
    <Ionicons name="chevron-forward" size={18} color={colors.textLight} />
  </TouchableOpacity>
);

export const ProfileScreen: React.FC = () => {
  const { child, childId, childSessionToken, setChildSessionToken } = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Back button */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Header row — name left, avatar right */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.name}>{child.displayName}</Text>
            <Text style={styles.username}>@{child.username}</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('AvatarPicker')}>
            {child.profileImageUrl ? (
              <View style={styles.avatarWrap}>
                <Image source={{ uri: child.profileImageUrl }} style={styles.avatarPhoto} resizeMode="cover" />
              </View>
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarEmoji}>{child.avatarEmoji}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Settings — solo */}
        <View style={styles.menuGroup}>
          <MenuItem icon="settings-outline" label="Settings" onPress={() => navigation.navigate('ChildSettings')} last />
        </View>

        {/* Help, Rate, Privacy — grouped */}
        <View style={styles.menuGroup}>
          <MenuItem icon="help-circle-outline" label="Help Centre" onPress={() => {}} />
          <MenuItem icon="star-outline" label="Rate Breesh" onPress={() => navigation.navigate('RateBreesh')} />
          <MenuItem icon="shield-outline" label="Privacy Policy" onPress={() => {}} last />
        </View>

        {/* Log Out — solo */}
        <View style={styles.menuGroup}>
          <MenuItem
            icon="log-out-outline"
            label="Log Out"
            last
            onPress={() => {
              const doLogout = async () => {
                // Deregister this device's push token BEFORE the session is revoked —
                // deregister_child_device_token requires a still-valid child session.
                // Without this, the device_tokens row stays active=true under this
                // child, and the NEXT child to log in on this device gets rejected
                // with token_owned_by_another_user when they try to register the
                // same Expo push token.
                await deregisterCurrentPushToken().catch(() => {});
                if (childSessionToken) {
                  db.revokeChildSession(childSessionToken).catch(() => {});
                  setChildSessionToken(null);
                }
                if (childId) clearChildSession(childId).catch(() => {});
                navigationRef.reset({ index: 0, routes: [{ name: 'WhoIsLoggingIn' }] });
              };
              if (Platform.OS === 'web') {
                if (window.confirm('Are you sure you want to log out?')) {
                  setTimeout(doLogout, 0);
                }
              } else {
                Alert.alert('Log out', 'Are you sure?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Log out', style: 'destructive', onPress: doLogout },
                ]);
              }
            }}
          />
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#F0EFF8' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4 },
  backBtn:{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: 24, paddingTop: 16, gap: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerLeft: { flex: 1 },
  name: {
    fontSize: 32,
    fontWeight: '800',
    color: '#1A1A3E',
    letterSpacing: -0.5,
  },
  username: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: 2,
  },
  avatarWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
  },
  avatarPhoto: {
    width: 64,
    height: 64,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEmoji: {
    fontSize: 32,
  },
  menuGroup: {
    backgroundColor: colors.white,
    borderRadius: 16,
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  menuRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.surface,
  },
  menuIcon: {
    marginRight: 16,
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A3E',
  },
});
