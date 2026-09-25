const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins');

const RECEIVER_NAME = '.BabyStatusWidgetProvider';

const copyTree = (source, destination, packageName) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, destinationPath, packageName);
      continue;
    }
    const contents = fs.readFileSync(sourcePath, 'utf8').replaceAll('__PACKAGE__', packageName);
    fs.writeFileSync(destinationPath, contents);
  }
};

const withWidgetFiles = config => withDangerousMod(config, [
  'android',
  async modConfig => {
    const packageName = modConfig.android?.package;
    if (!packageName) throw new Error('android.package is required for BabyStatusWidget');
    const templateRoot = path.join(__dirname, 'android');
    const androidRoot = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main');
    copyTree(
      path.join(templateRoot, 'java'),
      path.join(androidRoot, 'java', ...packageName.split('.')),
      packageName,
    );
    copyTree(path.join(templateRoot, 'res'), path.join(androidRoot, 'res'), packageName);
    return modConfig;
  },
]);

const withWidgetPackage = config => withMainApplication(config, modConfig => {
  let contents = modConfig.modResults.contents;
  if (contents.includes('add(BabyWidgetPackage())')) return modConfig;
  const applyMarker = 'PackageList(this).packages.apply {';
  if (contents.includes(applyMarker)) {
    contents = contents.replace(applyMarker, `${applyMarker}\n          add(BabyWidgetPackage())`);
  } else {
    const marker = 'PackageList(this).packages';
    if (!contents.includes(marker)) throw new Error('Unable to register BabyWidgetPackage in MainApplication');
    contents = contents.replace(marker, `${marker}.apply { add(BabyWidgetPackage()) }`);
  }
  modConfig.modResults.contents = contents;
  return modConfig;
});

const withWidgetManifest = config => withAndroidManifest(config, modConfig => {
  const manifest = modConfig.modResults.manifest;
  manifest['uses-permission'] = (manifest['uses-permission'] || []).filter(
    permission => permission.$?.['android:name'] !== 'android.permission.SYSTEM_ALERT_WINDOW',
  );
  const application = manifest.application?.[0];
  if (!application) throw new Error('Android application manifest entry not found');
  application.receiver = application.receiver || [];
  if (!application.receiver.some(receiver => receiver.$?.['android:name'] === RECEIVER_NAME)) {
    application.receiver.push({
      $: {
        'android:name': RECEIVER_NAME,
        'android:exported': 'false',
      },
      'intent-filter': [{
        action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
      }],
      'meta-data': [{
        $: {
          'android:name': 'android.appwidget.provider',
          'android:resource': '@xml/baby_status_widget_info',
        },
      }],
    });
  }
  return modConfig;
});

module.exports = config => {
  config = withWidgetFiles(config);
  config = withWidgetPackage(config);
  config = withWidgetManifest(config);
  return config;
};
