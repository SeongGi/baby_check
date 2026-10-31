import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import * as FirebaseAuth from 'firebase/auth';
import { Firestore, getFirestore, initializeFirestore, terminate } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDv9vA5GQmBy7WGvINkFcqt1nS7yurw3xk',
  authDomain: 'babycheck-sync.firebaseapp.com',
  projectId: 'babycheck-sync',
  storageBucket: 'babycheck-sync.firebasestorage.app',
  messagingSenderId: '446080458953',
  appId: '1:446080458953:web:f0bfb5907a70b90e606d18',
};

// 1.8.0부터 이 모듈은 불러올 때 아무것도 만들지 않습니다. 앱, 로그인, Firestore 인스턴스는
// 아래 함수를 처음 부를 때 만들고, 이 파일은 firestoreImport.ts가 동적 import()로만 불러옵니다
// (혼자 쓰는 기기와 1.8.0 신규 가족은 Firebase를 불러오지 않습니다, 07 2.3.1).
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

/** 기본 앱만 씁니다. 이름 붙인 앱은 인증 저장 키가 달라 1.7.9의 익명 uid를 잃으므로 만들지 않습니다. */
export const getFirebaseApp = () => (getApps().length ? getApp() : initializeApp(firebaseConfig));

export const getFirebaseAuth = (): Auth => {
  if (authInstance) return authInstance;
  const app = getFirebaseApp();
  try {
    if (Platform.OS === 'web') {
      authInstance = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      });
    } else {
      // 이 함수는 @firebase/auth 의 react-native 빌드에만 있습니다. 없다는 것은
      // 번들러가 react-native 조건을 놓쳤다는 뜻이라, 조용히 넘어가면 안 됩니다.
      const getRNPersistence = (FirebaseAuth as any).getReactNativePersistence;
      if (typeof getRNPersistence !== 'function') {
        throw new Error(
          'getReactNativePersistence를 찾을 수 없습니다. Metro가 @firebase/auth의 "react-native" export 조건을 적용하지 못했습니다.',
        );
      }
      authInstance = initializeAuth(app, { persistence: getRNPersistence(AsyncStorage) });
    }
  } catch (error) {
    // 여기로 오면 로그인 상태가 메모리에만 남습니다. 앱을 다시 켤 때마다 익명
    // 사용자 ID가 새로 발급되어 가족 구성원 문서가 계속 쌓이므로 눈에 띄게 남깁니다.
    console.error(
      '[Firebase] 로그인 상태 저장 설정에 실패해 메모리 전용으로 동작합니다. 앱 재시작마다 익명 ID가 바뀝니다.',
      error,
    );
    authInstance = getAuth(app);
  }
  return authInstance;
};

export const getFirestoreDb = (): Firestore => {
  if (dbInstance) return dbInstance;
  const app = getFirebaseApp();
  try {
    dbInstance = initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      // 2023년부터 기본값이 true 이지만, 나중에 누가 바꾸지 않도록 명시해 둡니다.
      experimentalAutoDetectLongPolling: true,
    });
  } catch (error) {
    console.warn(
      '[Firebase] initializeFirestore 실패 — 위 설정이 적용되지 않은 기본 인스턴스를 사용합니다.',
      error,
    );
    dbInstance = getFirestore(app);
  }
  return dbInstance;
};

/**
 * 지금 Firestore 인스턴스를 닫고 비웁니다. 다음 getFirestoreDb()가 같은 기본 앱으로 새로
 * 만듭니다(firebase 12.17.1에서 terminate 뒤 재생성이 되는 것을 확인했습니다).
 * 상한에 걸려 멈춘 호출이 인스턴스를 붙잡고 있을 때 쓰므로, 닫기 실패는 던지지 않습니다.
 */
export const resetFirestoreDb = async (): Promise<void> => {
  const current = dbInstance;
  dbInstance = null;
  if (!current) return;
  try {
    await terminate(current);
  } catch (error) {
    console.warn('[Firebase] Firestore 인스턴스를 닫지 못했습니다.', error);
  }
};
