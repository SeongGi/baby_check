/**
 * appUpdater.ts
 *
 * 디버그/릴리즈 모드 모두에서 작동하는 자체 APK 업데이트 시스템.
 * GitHub Releases API를 통해 최신 버전을 확인하고, 새 버전이 있으면
 * APK를 다운로드하여 설치합니다.
 *
 * expo-updates 불필요 – 일반 fetch만 사용합니다.
 */

import * as LegacyFS from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

const GITHUB_OWNER = 'SeongGi';
const GITHUB_REPO = 'baby_check';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// 현재 앱 버전 (app.json과 동기화 유지)
export const CURRENT_APP_VERSION = '1.0.4';

export interface UpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
  apkDownloadUrl: string | null;
  releaseNotes: string;
}

/** 버전 문자열을 숫자 배열로 파싱: "1.0.3" → [1, 0, 3] */
function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * GitHub Releases API에서 최신 버전을 확인합니다.
 * 디버그/릴리즈 모드 구분 없이 항상 작동합니다.
 */
export async function checkForAppUpdate(): Promise<UpdateInfo> {
  const currentVersion = CURRENT_APP_VERSION;

  const res = await fetch(GITHUB_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'Cache-Control': 'no-cache',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API 응답 오류 (${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  const latestVersion: string = (data.tag_name as string) ?? '0.0.0';
  const releaseNotes: string = (data.body as string) ?? '';

  // APK asset URL 추출 (*.apk 파일)
  const assets: Array<{ name: string; browser_download_url: string }> =
    (data.assets as Array<{ name: string; browser_download_url: string }>) ?? [];
  const apkAsset = assets.find(a => a.name.endsWith('.apk'));
  const apkDownloadUrl = apkAsset?.browser_download_url ?? null;

  return {
    hasUpdate: isNewerVersion(latestVersion, currentVersion),
    latestVersion,
    currentVersion,
    apkDownloadUrl,
    releaseNotes,
  };
}

/**
 * APK를 다운로드하고 설치를 시작합니다 (Android 전용).
 */
export async function downloadAndInstallApk(
  apkUrl: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('APK 설치는 Android 기기에서만 가능합니다.');
  }

  const cacheDir = (LegacyFS.cacheDirectory ?? '') + 'apk_downloads/';

  const dirInfo = await LegacyFS.getInfoAsync(cacheDir);
  if (!dirInfo.exists) {
    await LegacyFS.makeDirectoryAsync(cacheDir, { intermediates: true });
  }

  const apkPath = cacheDir + 'update.apk';

  // 이전에 다운로드된 파일이 있으면 삭제
  const existing = await LegacyFS.getInfoAsync(apkPath);
  if (existing.exists) {
    await LegacyFS.deleteAsync(apkPath, { idempotent: true });
  }

  const downloadResumable = LegacyFS.createDownloadResumable(
    apkUrl,
    apkPath,
    {},
    downloadProgress => {
      const progress =
        downloadProgress.totalBytesExpectedToWrite > 0
          ? downloadProgress.totalBytesWritten /
            downloadProgress.totalBytesExpectedToWrite
          : 0;
      onProgress?.(Math.round(progress * 100));
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) {
    throw new Error('APK 다운로드에 실패했습니다.');
  }

  // expo-intent-launcher로 APK 설치 트리거
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: result.uri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}
