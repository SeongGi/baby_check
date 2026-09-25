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
};

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

export async function resolve(specifier, context, nextResolve) {
  if (process.env.HARNESS_FAKE_CLOUD === '1'
    && (specifier === 'firebase/firestore' || specifier === 'firebase/auth' || specifier === './firebase')) {
    return { url: pathToFileURL(path.join(HARNESS_DIR, 'stubs/fake-cloud.mjs')).href, shortCircuit: true };
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
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
