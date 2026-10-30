import * as Application from 'expo-application';
import { Linking } from 'react-native';

const PLAY_PACKAGE = 'com.seonggi.babycheck';

/** Read the installed binary, not the current JavaScript or a hard-coded version. */
export const getInstalledAppVersion = (): string => {
  const version = Application.nativeApplicationVersion || '알 수 없음';
  const build = Application.nativeBuildVersion;
  return build ? `${version} (코드 ${build})` : version;
};

/**
 * 빌드할 때 넣은 배포 스토어입니다. 원스토어 빌드는
 * `EXPO_PUBLIC_DISTRIBUTION_STORE=onestore`로 번들을 만듭니다.
 */
export const DISTRIBUTION_STORE: 'play' | 'onestore' =
  process.env.EXPO_PUBLIC_DISTRIBUTION_STORE === 'onestore' ? 'onestore' : 'play';

/** Let Google Play decide whether this tester has an update available. */
export const openGooglePlayListing = async (): Promise<void> => {
  const marketUrl = `market://details?id=${PLAY_PACKAGE}`;
  const webUrl = `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}`;
  try {
    await Linking.openURL(marketUrl);
  } catch {
    await Linking.openURL(webUrl);
  }
};
