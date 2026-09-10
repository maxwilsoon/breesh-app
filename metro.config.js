// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// @stripe/stripe-react-native is native-only (it pulls in
// codegenNativeComponent for the native Apple/Google Pay button), which
// breaks the web bundle entirely. Redirect it to a no-op web shim so `expo
// start --web` / npm run web keep working — see src/lib/stripeWebShim.tsx.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform, ...rest) => {
  if (platform === 'web' && moduleName === '@stripe/stripe-react-native') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'src/lib/stripeWebShim.tsx'),
    };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform, ...rest)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
