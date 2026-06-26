import React, { useState } from 'react';
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
import { BabyProfile } from '../types';
import { COLORS } from '../theme/colors';

interface ProfileProps {
  profile: BabyProfile;
  onSaveProfile: (profile: BabyProfile) => Promise<boolean>;
}

export const Profile: React.FC<ProfileProps> = ({ profile, onSaveProfile }) => {
  const [name, setName] = useState(profile.name);
  const [birthDate, setBirthDate] = useState(profile.birthDate);
  const [birthWeight, setBirthWeight] = useState(profile.birthWeight);
  const [targetFormula, setTargetFormula] = useState(profile.targetFormula.toString());
  const [isSaving, setIsSaving] = useState(false);

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
});
