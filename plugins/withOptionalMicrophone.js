const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = config => withAndroidManifest(config, modConfig => {
  const manifest = modConfig.modResults.manifest;
  const features = manifest['uses-feature'] || [];
  const microphone = features.find(feature => feature.$?.['android:name'] === 'android.hardware.microphone');
  if (microphone) {
    microphone.$['android:required'] = 'false';
  } else {
    features.push({ $: { 'android:name': 'android.hardware.microphone', 'android:required': 'false' } });
  }
  manifest['uses-feature'] = features;
  return modConfig;
});
