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
import { Firestore, getFirestore, initializeFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDv9vA5GQmBy7WGvINkFcqt1nS7yurw3xk',
  authDomain: 'babycheck-sync.firebaseapp.com',
  projectId: 'babycheck-sync',
  storageBucket: 'babycheck-sync.firebasestorage.app',
  messagingSenderId: '446080458953',
  appId: '1:446080458953:web:f0bfb5907a70b90e606d18',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let auth: Auth;
try {
  if (Platform.OS === 'web') {
    auth = initializeAuth(app, {
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
    auth = initializeAuth(app, { persistence: getRNPersistence(AsyncStorage) });
  }
} catch (error) {
  // 여기로 오면 로그인 상태가 메모리에만 남습니다. 앱을 다시 켤 때마다 익명
  // 사용자 ID가 새로 발급되어 가족 구성원 문서가 계속 쌓이므로 눈에 띄게 남깁니다.
  console.error(
    '[Firebase] 로그인 상태 저장 설정에 실패해 메모리 전용으로 동작합니다. 앱 재시작마다 익명 ID가 바뀝니다.',
    error,
  );
  auth = getAuth(app);
}

let db: Firestore;
try {
  db = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    // 2023년부터 기본값이 true 이지만, 나중에 누가 바꾸지 않도록 명시해 둡니다.
    experimentalAutoDetectLongPolling: true,
  });
} catch (error) {
  console.warn(
    '[Firebase] initializeFirestore 실패 — 위 설정이 적용되지 않은 기본 인스턴스를 사용합니다.',
    error,
  );
  db = getFirestore(app);
}

export { app, auth, db };
