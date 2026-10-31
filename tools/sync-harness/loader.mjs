import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HARNESS_DIR, '../..');
const projectRequire = createRequire(path.join(PROJECT_DIR, 'noop.js'));
const ts = projectRequire('typescript');

const STUBS = {
  'expo-crypto': path.join(HARNESS_DIR, 'stubs/expo-crypto.mjs'),
  '@react-native-async-storage/async-storage': path.join(HARNESS_DIR, 'stubs/async-storage.mjs'),
  'react-native': path.join(HARNESS_DIR, 'stubs/react-native.mjs'),
  'expo-notifications': path.join(HARNESS_DIR, 'stubs/expo-notifications.mjs'),
};

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

// 07 설계 5.1: firestoreImport.ts와 firebase.ts에서 온 firebase/* import만 가짜 Firestore(stubs/fake-firestore.mjs)로 보냅니다.
// 그래서 이 두 파일의 실제 코드가 그대로 돌고, 다른 파일(기존 가짜 Worker 모드, compat, full)은 영향을 받지 않습니다.
// 실제 서버 모드(HARNESS_REAL_WORKER=1)와 HARNESS_FAKE_FIRESTORE=1에서만 켜집니다. 실제 Firebase에는 접속하지 않습니다.
const FAKE_FIRESTORE_ON = process.env.HARNESS_FAKE_FIRESTORE === '1' || process.env.HARNESS_REAL_WORKER === '1';
const FAKE_FIRESTORE_SPECIFIERS = new Set(['firebase/firestore', 'firebase/auth', 'firebase/app']);
const FAKE_FIRESTORE_PARENT = /\/src\/database\/(firestoreImport|firebase)\.ts$/;
// 이 두 모듈이 평가된 시각을 기기 프로세스가 기록하게 합니다(동적 import 판정, 불변 조건 5·6).
const TRACKED_MODULE = /\/src\/database\/(firestoreImport|firebase)\.ts$/;

export async function resolve(specifier, context, nextResolve) {
  if (process.env.HARNESS_FAKE_CLOUD === '1'
    && (specifier.endsWith('fake-cloud.mjs') || specifier === 'firebase/firestore' || specifier === 'firebase/auth' || specifier === './firebase')) {
    return { url: pathToFileURL(path.join(HARNESS_DIR, 'stubs/fake-worker.mjs')).href, shortCircuit: true };
  }
  if (FAKE_FIRESTORE_ON && FAKE_FIRESTORE_SPECIFIERS.has(specifier) && FAKE_FIRESTORE_PARENT.test(context.parentURL ?? '')) {
    return { url: pathToFileURL(path.join(HARNESS_DIR, 'stubs/fake-firestore.mjs')).href, shortCircuit: true };
  }
  if (STUBS[specifier]) return { url: pathToFileURL(STUBS[specifier]).href, shortCircuit: true };

  // legacySync 는 외부 구서버 호출이라 검증에서 제외합니다.
  if (specifier.endsWith('./legacySync')) {
    return { url: pathToFileURL(path.join(HARNESS_DIR, 'stubs/legacy-sync.mjs')).href, shortCircuit: true };
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (!path.extname(base)) {
      for (const ext of EXTENSIONS) {
        if (existsSync(base + ext)) return { url: pathToFileURL(base + ext).href, shortCircuit: true };
      }
    }
  }

  // 프로젝트 밖에서 실행되는 하네스도 프로젝트의 node_modules 를 쓰게 합니다.
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) throw error;
    // 하네스 파일은 프로젝트 밖에 있지만, 앱 코드와 반드시 같은 모듈 인스턴스를
    // 써야 하므로 프로젝트 기준으로 다시 해석합니다.
    return nextResolve(specifier, {
      ...context,
      parentURL: pathToFileURL(path.join(PROJECT_DIR, 'noop.js')).href,
    });
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: fileURLToPath(url),
    });
    const tracked = FAKE_FIRESTORE_ON && TRACKED_MODULE.exec(url);
    const marker = tracked
      ? `(globalThis.__harnessModuleLoads ||= []).push({ module: ${JSON.stringify(`${tracked[1]}.ts`)}, at: Date.now(), monotonicMs: Math.round(performance.now()) });\n`
      : '';
    return { format: 'module', source: marker + outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
