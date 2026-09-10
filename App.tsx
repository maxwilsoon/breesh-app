import { Platform } from 'react-native';
if (Platform.OS !== 'web') {
  require('react-native-gesture-handler');
}

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StripeProvider } from '@stripe/stripe-react-native';
import { AppProvider } from './src/context/AppContext';
import { AppNavigator } from './src/navigation';
import { AppLockOverlay } from './src/components/AppLockOverlay';

const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export default function App() {
  return (
    <SafeAreaProvider>
      <StripeProvider publishableKey={STRIPE_KEY} merchantIdentifier="merchant.app.breesh">
        <AppProvider>
          <AppLockOverlay>
            <AppNavigator />
          </AppLockOverlay>
        </AppProvider>
      </StripeProvider>
    </SafeAreaProvider>
  );
}
