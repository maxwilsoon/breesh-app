import React from 'react';
import { View, Image, StyleSheet, StatusBar } from 'react-native';
import { useAppLock } from '../hooks/useAppLock';

/**
 * Wraps the whole app. Runs the inactivity-logout logic (via useAppLock) and,
 * while the app is backgrounded / in the app switcher, paints an opaque brand
 * screen over the content so account details don't show in the OS task preview.
 *
 * This is a JS-level cover. Blocking screenshots outright (Android FLAG_SECURE /
 * iOS capture detection) needs expo-screen-capture and a native rebuild — a
 * separate follow-up.
 */
export const AppLockOverlay: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { covered } = useAppLock();

  return (
    <View style={styles.root}>
      {children}
      {covered && (
        <View style={styles.cover}>
          <StatusBar hidden />
          <Image
            source={require('../../assets/splash-icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F0C08A',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  logo: { width: '45%', height: '45%' },
});
