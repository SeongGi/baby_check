import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { KeyboardAwareScrollView } from '../components/KeyboardAwareScrollView';
import { TemperatureLog } from '../types';

interface LogTemperatureProps {
  onAddLog: (log: Omit<TemperatureLog, 'id'>) => Promise<unknown>;
  onNavigate: (screen: 'dashboard') => void;
}

export const LogTemperature: React.FC<LogTemperatureProps> = ({ onAddLog, onNavigate }) => {
  const [temperature, setTemperature] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const isFever = Number(temperature.replace(',', '.')) >= 38;

  const handleSave = async () => {
    const parsed = Number(temperature.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 34 || parsed > 42) {
      Alert.alert('체온 확인', '34~42℃ 사이의 체온을 입력해 주세요.');
      return;
    }
    const temperatureC = Math.round(parsed * 10) / 10; // 소수 첫째 자리로 반올림
    setIsSaving(true);
    try {
      const saved = await onAddLog({ type: 'temperature', temperatureC, timestamp: Date.now(), notes: notes.trim() || undefined });
      if (saved) onNavigate('dashboard');
      else Alert.alert('저장 실패', '체온 기록을 저장하지 못했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      containerStyle={styles.container}
      contentContainerStyle={styles.content} 
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton}><Text style={styles.backText}>‹</Text></TouchableOpacity>
          <Text style={styles.title}>체온 기록</Text><View style={styles.backButton} />
        </View>
        <View style={styles.card}>
          <Text style={styles.emoji}>🌡️</Text>
          <Text style={styles.label}>체온 (℃)</Text>
          <View style={styles.inputRow}>
            <TextInput style={styles.input} value={temperature} onChangeText={value => setTemperature(value.replace(/[^0-9.,]/g, ''))} placeholder="예: 36.8" placeholderTextColor={COLORS.textMuted} keyboardType="decimal-pad" autoFocus />
            <Text style={styles.unit}>℃</Text>
          </View>
          {isFever && <Text style={styles.feverHint}>38℃ 이상이에요. 아기 상태를 잘 살펴 주세요.</Text>}
          <Text style={styles.label}>메모 (선택)</Text>
          <TextInput style={styles.notes} value={notes} onChangeText={setNotes} placeholder="측정 상황 등을 적어두세요." placeholderTextColor={COLORS.textMuted} multiline />
        </View>
        <TouchableOpacity style={[styles.saveButton, isSaving && styles.disabled]} onPress={handleSave} disabled={isSaving}>
          <Text style={styles.saveText}>{isSaving ? '저장 중...' : '체온 기록 저장하기'}</Text>
        </TouchableOpacity>
    </KeyboardAwareScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 140 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  backButton: { width: 44, height: 44, justifyContent: 'center' },
  backText: { fontSize: 36, color: COLORS.text },
  title: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  card: { backgroundColor: COLORS.card, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: COLORS.border, marginBottom: 20 },
  emoji: { fontSize: 42, textAlign: 'center', marginBottom: 18 },
  label: { fontSize: 13, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  feverHint: { color: COLORS.danger, fontSize: 13, fontWeight: 'bold', marginTop: -12, marginBottom: 22 },
  input: { flex: 1, minHeight: 54, borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 14, paddingHorizontal: 16, fontSize: 22, fontWeight: 'bold', color: COLORS.text, backgroundColor: COLORS.background },
  unit: { marginLeft: 10, fontSize: 16, fontWeight: 'bold', color: COLORS.textMuted },
  notes: { minHeight: 90, borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 14, padding: 14, color: COLORS.text, backgroundColor: COLORS.background, textAlignVertical: 'top' },
  saveButton: { minHeight: 56, borderRadius: 18, backgroundColor: '#E07A5F', alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
