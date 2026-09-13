import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { useApp } from '../../context/AppContext';
import { db } from '../../lib/database';

type BlockedUser = { id: string; display_name: string; username: string; avatar_emoji: string };

const AVATAR_COLORS = ['#C8E8CB', '#3B82F6', '#10B981', '#EF4444', '#F59E0B', '#EC4899', '#06B6D4'];
const colorFor = (id: string) => AVATAR_COLORS[id.charCodeAt(0) % AVATAR_COLORS.length];

export const BlockedUsersScreen: React.FC = () => {
  const navigation = useNavigation();
  const { childId, childSessionToken, childDeviceId } = useApp();
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!childId || !childSessionToken || !childDeviceId) {
      setError('Your session has expired. Please log out and log in again.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await db.getBlockedUsers(childId, childSessionToken, childDeviceId);
      setBlocked(rows);
    } catch (e: any) {
      setError('Could not load blocked users. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [childId, childSessionToken, childDeviceId]);

  useEffect(() => { load(); }, [load]);

  const doUnblock = async (user: BlockedUser) => {
    if (!childId || !childSessionToken || !childDeviceId) return;
    setUnblockingId(user.id);
    try {
      await db.unblockUser(childId, childSessionToken, childDeviceId, user.id);
      setBlocked(prev => prev.filter(u => u.id !== user.id));
    } catch (e: any) {
      Alert.alert('Error', 'Could not unblock this user. Please try again.');
    } finally {
      setUnblockingId(null);
    }
  };

  const handleUnblock = (user: BlockedUser) => {
    if (Platform.OS === 'web') {
      if (window.confirm(`Unblock ${user.display_name}? They'll be able to send you friend and money requests again.`)) {
        doUnblock(user);
      }
    } else {
      Alert.alert(
        `Unblock ${user.display_name}?`,
        "They'll be able to send you friend and money requests again, and will appear in search results.",
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Unblock', style: 'default', onPress: () => doUnblock(user) },
        ],
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={26} color="#1A1A3E" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Blocked Users</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : error ? (
          <View style={styles.centerState}>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : blocked.length === 0 ? (
          <View style={styles.centerState}>
            <Text style={styles.emptyEmoji}>🚫</Text>
            <Text style={styles.emptyText}>You haven't blocked anyone</Text>
          </View>
        ) : (
          blocked.map((user, idx) => (
            <View key={user.id} style={[styles.userRow, idx < blocked.length - 1 && styles.userRowDivider]}>
              <View style={[styles.avatar, { backgroundColor: colorFor(user.id) }]}>
                <Text style={styles.avatarEmoji}>{user.avatar_emoji}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName} numberOfLines={1}>{user.display_name}</Text>
                <Text style={styles.userHandle} numberOfLines={1}>@{user.username}</Text>
              </View>
              <TouchableOpacity
                style={styles.unblockBtn}
                onPress={() => handleUnblock(user)}
                disabled={unblockingId === user.id}
                activeOpacity={0.8}
              >
                {unblockingId === user.id
                  ? <ActivityIndicator size="small" color="#374151" />
                  : <Text style={styles.unblockBtnText}>Unblock</Text>}
              </TouchableOpacity>
            </View>
          ))
        )}
        <View style={{ height: 32 }} />
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
  scroll: { paddingBottom: 40, flexGrow: 1 },

  centerState: { alignItems: 'center', paddingVertical: 64, gap: 10 },
  emptyEmoji: { fontSize: 40 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center', paddingHorizontal: 32 },

  userRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 12, backgroundColor: '#fff',
  },
  userRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0' },

  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  avatarEmoji: { fontSize: 23 },

  userInfo: { flex: 1, minWidth: 0 },
  userName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  userHandle: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },

  unblockBtn: {
    backgroundColor: '#F3F4F6', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 7, minWidth: 76, alignItems: 'center',
  },
  unblockBtnText: { fontSize: 13, fontWeight: '600', color: '#374151' },
});
