import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { WeightLog } from '../types';

interface LogWeightProps {
  onAddLog: (log: Omit<WeightLog, 'id'>) => Promise<unknown>;
  onNavigate: (screen: 'dashboard') => void;
}

export const LogWeight: React.FC<LogWeightProps> = ({ onAddLog, onNavigate }) => {
  const [weight, setWeight] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const weightKg = Number(weight.replace(',', '.'));
    if (!Number.isFinite(weightKg) || weightKg < 0.5 || weightKg > 50) {
      Alert.alert('체중 확인', '0.5~50kg 사이의 체중을 입력해 주세요.');
      return;
    }
    setIsSaving(true);
    try {
      const saved = await onAddLog({ type: 'weight', weightKg, timestamp: Date.now(), notes: notes.trim() || undefined });
      if (saved) onNavigate('dashboard');
      else Alert.alert('저장 실패', '체중 기록을 저장하지 못했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton}><Text style={styles.backText}>‹</Text></TouchableOpacity>
          <Text style={styles.title}>체중 기록</Text><View style={styles.backButton} />
        </View>
        <View style={styles.card}>
          <Text style={styles.emoji}>⚖️</Text>
          <Text style={styles.label}>현재 체중 (kg)</Text>
          <View style={styles.weightRow}>
            <TextInput style={styles.weightInput} value={weight} onChangeText={value => setWeight(value.replace(/[^0-9.,]/g, ''))} placeholder="예: 5.4" placeholderTextColor={COLORS.textMuted} keyboardType="decimal-pad" autoFocus />
            <Text style={styles.unit}>kg</Text>
          </View>
          <Text style={styles.label}>메모 (선택)</Text>
          <TextInput style={styles.notes} value={notes} onChangeText={setNotes} placeholder="측정 상황 등을 적어두세요." placeholderTextColor={COLORS.textMuted} multiline />
        </View>
        <TouchableOpacity style={[styles.saveButton, isSaving && styles.disabled]} onPress={handleSave} disabled={isSaving}>
          <Text style={styles.saveText}>{isSaving ? '저장 중...' : '체중 기록 저장하기'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  backButton: { width: 44, height: 44, justifyContent: 'center' },
  backText: { fontSize: 36, color: COLORS.text },
  title: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  card: { backgroundColor: COLORS.card, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: COLORS.border, marginBottom: 20 },
  emoji: { fontSize: 42, textAlign: 'center', marginBottom: 18 },
  label: { fontSize: 13, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  weightRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  weightInput: { flex: 1, minHeight: 54, borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 14, paddingHorizontal: 16, fontSize: 22, fontWeight: 'bold', color: COLORS.text, backgroundColor: COLORS.background },
  unit: { marginLeft: 10, fontSize: 16, fontWeight: 'bold', color: COLORS.textMuted },
  notes: { minHeight: 90, borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 14, padding: 14, color: COLORS.text, backgroundColor: COLORS.background, textAlignVertical: 'top' },
  saveButton: { minHeight: 56, borderRadius: 18, backgroundColor: '#7C9CBF', alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
