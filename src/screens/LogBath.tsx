import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BathLog, BathType } from '../types';
import { COLORS } from '../theme/colors';

interface LogBathProps {
  onAddLog: (log: Omit<BathLog, 'id'>) => Promise<unknown>;
  onNavigate: (screen: 'dashboard') => void;
}

const DURATIONS = [5, 10, 15, 20];

export const LogBath: React.FC<LogBathProps> = ({ onAddLog, onNavigate }) => {
  const [bathType, setBathType] = useState<BathType>('full');
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await onAddLog({
        type: 'bath',
        bathType,
        durationMinutes,
        timestamp: Date.now(),
        notes: notes.trim() || undefined,
      });
      if (saved) {
        onNavigate('dashboard');
      } else {
        Alert.alert('저장 실패', '목욕 기록을 저장하지 못했습니다. 다시 시도해 주세요.');
      }
    } catch (error) {
      console.error(error);
      Alert.alert('저장 실패', '목욕 기록을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton} accessibilityLabel="홈으로 돌아가기">
            <Text style={styles.backButtonText}>← 뒤로</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>목욕 기록</Text>
          <View style={styles.placeholder} />
        </View>

        <View style={styles.introCard}>
          <Text style={styles.introEmoji}>🛁</Text>
          <View style={styles.introCopy}>
            <Text style={styles.introTitle}>오늘의 씻기 기록</Text>
            <Text style={styles.introText}>종류와 소요 시간을 선택하면 바로 기록돼요.</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>씻기 종류</Text>
          <View style={styles.optionRow}>
            {(['full', 'quick'] as BathType[]).map(type => {
              const selected = bathType === type;
              return (
                <TouchableOpacity key={type} style={[styles.typeButton, selected && styles.typeButtonSelected]} onPress={() => setBathType(type)}>
                  <Text style={styles.typeEmoji}>{type === 'full' ? '🛁' : '🧼'}</Text>
                  <Text style={[styles.typeText, selected && styles.selectedText]}>{type === 'full' ? '목욕' : '간단 씻기'}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>소요 시간</Text>
          <View style={styles.durationRow}>
            {DURATIONS.map(duration => {
              const selected = durationMinutes === duration;
              return (
                <TouchableOpacity key={duration} style={[styles.durationButton, selected && styles.durationButtonSelected]} onPress={() => setDurationMinutes(duration)}>
                  <Text style={[styles.durationText, selected && styles.selectedText]}>{duration}분</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>메모</Text>
          <TextInput style={styles.notesInput} value={notes} onChangeText={setNotes} placeholder="피부 상태나 사용한 제품 등을 기록해보세요." placeholderTextColor={COLORS.textMuted} multiline numberOfLines={3} />
        </View>

        <TouchableOpacity style={[styles.saveButton, isSaving && styles.saveButtonDisabled]} onPress={handleSave} disabled={isSaving} accessibilityRole="button">
          <Text style={styles.saveButtonText}>{isSaving ? '저장 중...' : '목욕 기록 저장하기'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  keyboardView: { flex: 1, backgroundColor: COLORS.background },
  container: { flex: 1 },
  contentContainer: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  backButton: { paddingVertical: 10, paddingHorizontal: 8, minHeight: 44, justifyContent: 'center' },
  backButtonText: { fontSize: 15, fontWeight: 'bold', color: COLORS.bath },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
  placeholder: { width: 60 },
  introCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.lightMint, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: '#D8EEE9', marginBottom: 24 },
  introEmoji: { fontSize: 38, marginRight: 14 },
  introCopy: { flex: 1 },
  introTitle: { color: COLORS.text, fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  introText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  section: { marginBottom: 24 },
  sectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: 'bold', marginBottom: 12 },
  optionRow: { flexDirection: 'row', gap: 10 },
  typeButton: { flex: 1, minHeight: 92, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  typeButtonSelected: { backgroundColor: COLORS.lightMint, borderColor: COLORS.bath, borderWidth: 2 },
  typeEmoji: { fontSize: 28, marginBottom: 6 },
  typeText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700' },
  selectedText: { color: COLORS.bath, fontWeight: 'bold' },
  durationRow: { flexDirection: 'row', gap: 8 },
  durationButton: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border },
  durationButtonSelected: { backgroundColor: COLORS.lightMint, borderColor: COLORS.bath, borderWidth: 2 },
  durationText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700' },
  notesInput: { minHeight: 100, backgroundColor: COLORS.card, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, padding: 14, color: COLORS.text, fontSize: 14, textAlignVertical: 'top' },
  saveButton: { minHeight: 56, borderRadius: 18, backgroundColor: COLORS.bath, alignItems: 'center', justifyContent: 'center', elevation: 2 },
  saveButtonDisabled: { opacity: 0.55 },
  saveButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold' },
});
