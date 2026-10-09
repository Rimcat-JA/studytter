const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');
// Web: tslib's ESM wrapper breaks under Metro ("tslib.default is undefined").
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'tslib') {
    return context.resolveRequest(context, 'tslib/tslib.es6.js', platform);
  }
  if (platform === 'web' && moduleName === 'expo-file-system') {
    return { type: 'sourceFile', filePath: require('path').join(__dirname, 'web-shims/file-system.js') };
  }
  if (platform === 'web' && moduleName === 'expo-secure-store') {
    return { type: 'sourceFile', filePath: require('path').join(__dirname, 'web-shims/secure-store.js') };
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};
module.exports = config;
