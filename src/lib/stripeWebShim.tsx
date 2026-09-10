// Web-only stand-in for @stripe/stripe-react-native.
//
// That package is native-only — it imports codegenNativeComponent (for the
// native Apple/Google Pay button), which Metro cannot resolve when bundling
// for the web platform. Since Apple Pay / Google Pay sheets can't render in
// a browser anyway, this shim keeps the web bundle buildable: StripeProvider
// becomes a no-op passthrough and useStripe's payment functions resolve with
// a clear error instead of crashing the whole app at import time.
//
// Wired in via metro.config.js, which redirects imports of
// '@stripe/stripe-react-native' to this file only when platform === 'web'.
import React from 'react';

export const StripeProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <>{children}</>
);

const unsupportedError = {
  code: 'web_unsupported',
  message: 'Stripe payments are not available on web — please use the iOS or Android app.',
};

export function useStripe() {
  return {
    initPaymentSheet: async () => ({ error: unsupportedError }),
    presentPaymentSheet: async () => ({ error: unsupportedError }),
  };
}
