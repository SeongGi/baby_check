// partnerPush.ts가 쓰는 실제 의존성(저장소, 알림, 해시, 서버 호출)을 만듭니다.
// 이 파일은 react-native와 expo 모듈을 가져오므로 node 단위 테스트에서는 쓰지 않습니다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import appConfig from '../../app.json';
import { registerPushDevice, unregisterPushDevice } from '../database/cloudClient';
import type { PartnerPushDeps } from './partnerPush';

// EAS 프로젝트 번호는 app.json의 extra.eas.projectId에서 읽습니다.
const EAS_PROJECT_ID: string = (appConfig as any).expo?.extra?.eas?.projectId ?? '';

const createPartnerPushDeps = (): PartnerPushDeps => ({
  storage: {
    getItem: key => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: key => AsyncStorage.removeItem(key),
  },
  getPermissionsAsync: () => Notifications.getPermissionsAsync(),
  setNotificationChannelAsync: (channelId, spec) =>
    Notifications.setNotificationChannelAsync(channelId, {
      name: spec.name,
      importance:
        spec.importance === 'high' ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.LOW,
      sound: spec.sound ? 'default' : null,
      enableVibrate: spec.vibrate,
      ...(spec.vibrate ? { vibrationPattern: [0, 250, 150, 250] } : {}),
    }),
  getExpoPushTokenAsync: options => Notifications.getExpoPushTokenAsync(options),
  sha256Hex: text => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
  registerPushDevice,
  unregisterPushDevice,
  platformOS: Platform.OS,
  getTimezoneOffset: () => new Date().getTimezoneOffset(),
  projectId: EAS_PROJECT_ID,
});

let singleton: PartnerPushDeps | null = null;

// 앱은 반드시 이 함수로 얻은 하나의 객체만 써야 합니다. reconcile의 직렬화 상태와 서버 거절 기록이 deps 객체마다 따로 있어서,
// 호출할 때마다 새로 만들면 동시에 도는 호출을 막지 못하고 거절 기록도 사라집니다.
export const getPartnerPushDeps = (): PartnerPushDeps => {
  if (!singleton) singleton = createPartnerPushDeps();
  return singleton;
};
