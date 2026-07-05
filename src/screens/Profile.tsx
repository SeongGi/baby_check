import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TextInput, 
  TouchableOpacity, 
  ScrollView, 
  Alert,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { checkForAppUpdate, downloadAndInstallApk } from '../utils/appUpdater';
import { BabyProfile, BabyLogEntry } from '../types';
import { COLORS } from '../theme/colors';
import { getLogs } from '../database/storage';

interface ProfileProps {
  profile: BabyProfile;
  onSaveProfile: (profile: BabyProfile) => Promise<boolean>;
  onImportData: (profile: BabyProfile, logs: BabyLogEntry[]) => Promise<void>;
  onSync: (syncKey: string) => Promise<{ success: boolean; merged: boolean; error?: string }>;
}

export const Profile: React.FC<ProfileProps> = ({ profile, onSaveProfile, onImportData, onSync }) => {
  const [name, setName] = useState(profile.name);
  const [birthDate, setBirthDate] = useState(profile.birthDate);
  const [birthWeight, setBirthWeight] = useState(profile.birthWeight);
  const [targetFormula, setTargetFormula] = useState(profile.targetFormula.toString());

  // Sync inputs if profile values update from parent (e.g. edited from dashboard)
  useEffect(() => {
    setName(profile.name);
    setBirthDate(profile.birthDate);
    setBirthWeight(profile.birthWeight);
    setTargetFormula(profile.targetFormula.toString());
  }, [profile]);
  const [isSaving, setIsSaving] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [syncKey, setSyncKey] = useState(profile.syncKey || '');
  const [isSyncing, setIsSyncing] = useState(false);

  const [showImportInput, setShowImportInput] = useState(false);
  const [importText, setImportText] = useState('');

  const handleSyncSetup = async () => {
    setIsSyncing(true);
    try {
      const updatedProfile: BabyProfile = {
        name: name.trim(),
        birthDate,
        birthWeight,
        targetFormula: parseInt(targetFormula) || 800,
        syncKey: syncKey.trim(),
      };
      
      const saved = await onSaveProfile(updatedProfile);
      
      if (saved && syncKey.trim()) {
        const result = await onSync(syncKey.trim());
        if (result.success) {
          Alert.alert(
            '동기화 완료', 
            result.merged 
              ? '원격 서버의 최신 데이터를 가져와 병합을 완료했습니다!'
              : '동기화 완료! 현재 이미 최신 상태입니다.'
          );
        } else {
          Alert.alert(
            '동기화 실패', 
            `원격 서버에 연결하지 못했거나 그룹 키가 올바르지 않습니다.\n\n[상세 오류]: ${result.error || '알 수 없는 오류'}`
          );
        }
      } else if (saved) {
        Alert.alert('설정 저장 완료', '동기화가 비활성화되었습니다.');
      }
    } catch (e) {
      console.error(e);
      Alert.alert('오류', '동기화 설정 중 오류가 발생했습니다.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCheckUpdates = async () => {
    // GitHub Releases 기반 자체 업데이트 – 디버그/릴리즈 모드 모두 작동
    setIsCheckingUpdates(true);
    try {
      const info = await checkForAppUpdate();

      if (!info.hasUpdate) {
        Alert.alert('최신 버전', `현재 최신 버전(${info.currentVersion})을 사용하고 있습니다.`);
        return;
      }

      if (!info.apkDownloadUrl) {
        Alert.alert(
          '업데이트 안내',
          `새 버전(${info.latestVersion})이 있지만 APK 파일을 찾을 수 없습니다.\nGitHub에서 직접 다운로드해 주세요.`
        );
        return;
      }

      Alert.alert(
        `새 버전 발견: ${info.latestVersion}`,
        `현재 버전: ${info.currentVersion}\n\n${info.releaseNotes ? info.releaseNotes.slice(0, 200) : '새 업데이트가 준비되었습니다.'}\n\nAPK를 다운로드하고 설치하시겠습니까?`,
        [
          { text: '나중에', style: 'cancel' },
          {
            text: '지금 업데이트',
            onPress: async () => {
              setIsCheckingUpdates(true);
              try {
                await downloadAndInstallApk(
                  info.apkDownloadUrl!,
                  (pct) => console.log(`다운로드 중: ${pct}%`)
                );
              } catch (err) {
                Alert.alert(
                  '설치 실패',
                  '업데이트 설치 중 오류가 발생했습니다: ' +
                    (err instanceof Error ? err.message : String(err))
                );
              } finally {
                setIsCheckingUpdates(false);
              }
            },
          },
        ]
      );
    } catch (e) {
      console.error(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      Alert.alert(
        '업데이트 확인 실패',
        `GitHub에서 업데이트 정보를 가져오지 못했습니다.\n\n[상세 오류]: ${errMsg}`
      );
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleExport = async () => {
    try {
      const allLogs = await getLogs();
      const backupData = {
        version: 1,
        backupDate: Date.now(),
        profile,
        logs: allLogs,
      };
      const jsonString = JSON.stringify(backupData);
      await Clipboard.setStringAsync(jsonString);
      Alert.alert('내보내기 성공', '데이터가 클립보드에 안전하게 복사되었습니다. 카카오톡이나 메모장에 붙여넣기 하여 백업해 두세요!');
    } catch (e) {
      console.error(e);
      Alert.alert('내보내기 실패', '데이터를 백업하는 중 오류가 발생했습니다.');
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      Alert.alert('복원 오류', '복원할 텍스트 데이터를 붙여넣어 주세요.');
      return;
    }

    try {
      const parsedData = JSON.parse(importText.trim());
      if (!parsedData.profile || !Array.isArray(parsedData.logs)) {
        Alert.alert('복원 실패', '올바르지 않은 백업 데이터 포맷입니다.');
        return;
      }

      Alert.alert(
        '데이터 복원 확인',
        '기존 기기의 모든 아기 일지와 설정 정보가 삭제되고 백업된 데이터로 복원됩니다. 정말 진행하시겠습니까?',
        [
          { text: '취소', style: 'cancel' },
          { 
            text: '복원하기', 
            style: 'destructive',
            onPress: async () => {
              try {
                await onImportData(parsedData.profile, parsedData.logs);
                Alert.alert('복원 성공', '우리아기 기록이 성공적으로 복원되었습니다.');
                setShowImportInput(false);
                setImportText('');
              } catch (e) {
                console.error(e);
                Alert.alert('오류', '데이터 저장 중 문제가 발생했습니다.');
              }
            }
          }
        ]
      );
    } catch (e) {
      Alert.alert('복원 실패', '텍스트를 데이터 객체로 변환하는 중 오류가 발생했습니다. 정상적인 텍스트인지 다시 확인해 주세요.');
    }
  };

  const handleSave = async () => {
    // Basic validations
    if (!name.trim()) {
      Alert.alert('입력 확인', '아기 이름을 입력해 주세요.');
      return;
    }
    
    // YYYY-MM-DD regex check
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(birthDate)) {
      Alert.alert('입력 확인', '생년월일을 YYYY-MM-DD 형식으로 입력해 주세요. (예: 2026-06-25)');
      return;
    }

    const weightNum = parseFloat(birthWeight);
    if (isNaN(weightNum) || weightNum <= 0) {
      Alert.alert('입력 확인', '출생 체중을 올바른 숫자로 입력해 주세요.');
      return;
    }

    const goalNum = parseInt(targetFormula);
    if (isNaN(goalNum) || goalNum <= 0) {
      Alert.alert('입력 확인', '하루 권장 분유 목표량을 숫자로 입력해 주세요.');
      return;
    }

    setIsSaving(true);
    try {
      const updatedProfile: BabyProfile = {
        name: name.trim(),
        birthDate,
        birthWeight: weightNum.toString(),
        targetFormula: goalNum,
      };

      const success = await onSaveProfile(updatedProfile);
      if (success) {
        Alert.alert('저장 완료', '아기 프로필이 안전하게 저장되었습니다.');
      } else {
        Alert.alert('오류', '프로필 저장 중 오류가 발생했습니다.');
      }
    } catch (e) {
      console.error(e);
      Alert.alert('오류', '프로필 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      style={styles.keyboardView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <Text style={styles.screenTitle}>아기 프로필 설정</Text>
        <Text style={styles.subtitle}>우리아기의 소중한 정보를 설정하고 관리합니다. ❤️</Text>

        <View style={styles.formCard}>
          {/* Baby Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>아기 이름 / 태명</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="예: 꼬꼬마"
              placeholderTextColor={COLORS.textMuted}
            />
          </View>

          {/* Birth Date */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>태어난 날짜 (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={birthDate}
              onChangeText={setBirthDate}
              placeholder="예: 2026-06-25"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
            />
          </View>

          {/* Birth Weight */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>출생 체중 (kg)</Text>
            <TextInput
              style={styles.input}
              value={birthWeight}
              onChangeText={setBirthWeight}
              placeholder="예: 3.2"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="decimal-pad"
            />
          </View>

          {/* Target Formula ml */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>하루 권장 수유 목표량 (ml)</Text>
            <TextInput
              style={styles.input}
              value={targetFormula}
              onChangeText={setTargetFormula}
              placeholder="예: 800"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
            />
          </View>
        </View>

        {/* Save Button */}
        <TouchableOpacity 
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={isSaving}
        >
          <Text style={styles.saveButtonText}>
            {isSaving ? '저장 중...' : '프로필 수정 완료'}
          </Text>
        </TouchableOpacity>

        {/* Real-time Cloud Sync Card */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>🔗 부부 실시간 데이터 동기화</Text>
          <Text style={styles.backupDesc}>
            동일한 그룹 키를 입력하면 아내와 남편의 핸드폰 간에 실시간으로 수유 및 기저귀 데이터를 동기화합니다. (영문/숫자 조합 입력 권장)
          </Text>
          
          <View style={[styles.inputGroup, { marginBottom: 12 }]}>
            <Text style={styles.label}>동기화 그룹 키 (예: heesung2026)</Text>
            <TextInput
              style={styles.input}
              value={syncKey}
              onChangeText={setSyncKey}
              placeholder="동기화할 그룹 비밀번호 입력"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          
          <TouchableOpacity 
            style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]} 
            onPress={handleSyncSetup}
            disabled={isSyncing}
          >
            <Text style={styles.syncButtonText}>
              {isSyncing ? '동기화 처리 중...' : profile.syncKey ? '동기화 설정 업데이트 & 지금 동기화 🔄' : '동기화 시작하기 🚀'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Data Backup & Restore Card */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>📂 데이터 백업 및 복원</Text>
          <Text style={styles.backupDesc}>우리아기 일지를 복사해서 다른 기기로 옮기거나 안전하게 백업해 둘 수 있습니다.</Text>
          
          <View style={styles.backupButtonsRow}>
            <TouchableOpacity style={styles.backupButton} onPress={handleExport}>
              <Text style={styles.backupButtonText}>데이터 내보내기 📤</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.backupButton, { backgroundColor: COLORS.secondary }]} 
              onPress={() => setShowImportInput(!showImportInput)}
            >
              <Text style={styles.backupButtonText}>데이터 가져오기 📥</Text>
            </TouchableOpacity>
          </View>

          {showImportInput && (
            <View style={styles.importInputContainer}>
              <TextInput
                style={styles.importInput}
                placeholder="내보내기 한 백업 텍스트를 여기에 붙여넣어 주세요."
                placeholderTextColor={COLORS.textMuted}
                value={importText}
                onChangeText={setImportText}
                multiline
                numberOfLines={4}
              />
              <TouchableOpacity style={styles.runImportButton} onPress={handleImport}>
                <Text style={styles.runImportButtonText}>데이터 복원 실행 ⚡</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* App Updates Card */}
        <View style={styles.backupCard}>
          <Text style={styles.backupTitle}>⚡ 앱 업데이트 확인</Text>
          <Text style={styles.backupDesc}>새로운 기능이나 버그 수정사항이 배포되면 앱을 무선(OTA)으로 최신 상태로 업데이트합니다.</Text>
          <TouchableOpacity 
            style={[styles.updateButton, isCheckingUpdates && styles.updateButtonDisabled]} 
            onPress={handleCheckUpdates}
            disabled={isCheckingUpdates}
          >
            <Text style={styles.updateButtonText}>
              {isCheckingUpdates ? '업데이트 확인 중...' : '앱 자동 업데이트 확인 🔄'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Info Box */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>💡 신생아 상식 꿀팁!</Text>
          <Text style={styles.infoText}>
            • 생후 1개월 신생아의 하루 총 분유 수유량은 약 600~900ml가 표준입니다.
          </Text>
          <Text style={styles.infoText}>
            • 아기가 한 번에 너무 많이 먹으면 게워내기 쉬우니 D-day 기준 몸무게를 고려해 조금씩 나눠 수유해 주세요.
          </Text>
          <Text style={styles.infoText}>
            • 대소변 색상이나 횟수가 평소와 확연히 다를 땐 타임라인의 메모 기능을 활용하여 소아과 상담 시 지참하세요.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  keyboardView: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginBottom: 20,
  },
  formCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: COLORS.text,
    backgroundColor: COLORS.background,
  },
  saveButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
    marginBottom: 20,
  },
  saveButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  infoCard: {
    backgroundColor: COLORS.lightYellow,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.accent + '30',
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#B37D00',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 12,
    color: '#666666',
    lineHeight: 18,
    marginBottom: 6,
  },
  backupCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  backupTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 6,
  },
  backupDesc: {
    fontSize: 12,
    color: COLORS.textMuted,
    lineHeight: 18,
    marginBottom: 16,
  },
  backupButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backupButton: {
    flex: 0.485,
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  backupButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  importInputContainer: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 16,
  },
  importInput: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    fontSize: 12,
    color: COLORS.text,
    backgroundColor: COLORS.background,
    height: 100,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  runImportButton: {
    backgroundColor: '#34D399',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  runImportButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  updateButton: {
    backgroundColor: COLORS.secondary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
    marginTop: 8,
  },
  updateButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  updateButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  syncButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
    marginTop: 4,
  },
  syncButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  syncButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
});
