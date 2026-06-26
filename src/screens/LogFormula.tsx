import React, { useState } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  TextInput, 
  KeyboardAvoidingView, 
  Platform, 
  ScrollView 
} from 'react-native';
import { COLORS } from '../theme/colors';
import { BottleSlider } from '../components/BottleSlider';
import { MilkTemperature } from '../types';

interface LogFormulaProps {
  onAddLog: (log: {
    type: 'formula';
    amount: number;
    temperature: MilkTemperature;
    timestamp: number;
    notes?: string;
  }) => Promise<any>;
  onNavigate: (screen: 'dashboard') => void;
}

export const LogFormula: React.FC<LogFormulaProps> = ({ onAddLog, onNavigate }) => {
  const [amount, setAmount] = useState<number>(120); // Default to 120ml
  const [temperature, setTemperature] = useState<MilkTemperature>('warm');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [scrollEnabled, setScrollEnabled] = useState(true);

  const handleSave = async () => {
    if (amount <= 0) {
      alert('분유 양을 10ml 이상 선택해주세요.');
      return;
    }

    setIsSaving(true);
    try {
      await onAddLog({
        type: 'formula',
        amount,
        temperature,
        timestamp: Date.now(),
        notes: notes.trim() ? notes.trim() : undefined,
      });
      // Clear states
      setAmount(120);
      setTemperature('warm');
      setNotes('');
      // Navigate back
      onNavigate('dashboard');
    } catch (error) {
      console.error(error);
      alert('기록 도중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      style={styles.keyboardView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView 
        style={styles.container} 
        contentContainerStyle={styles.contentContainer}
        scrollEnabled={scrollEnabled}
      >
        {/* Header Title */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton}>
            <Text style={styles.backButtonText}>← 뒤로</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>분유 수유 기록</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Custom Draggable Baby Bottle Slider */}
        <BottleSlider 
          value={amount} 
          onChange={setAmount} 
          onDragStart={() => setScrollEnabled(false)}
          onDragEnd={() => setScrollEnabled(true)}
        />

        {/* Temperature Selector */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>분유 온도</Text>
          <View style={styles.tempSelectorContainer}>
            {(['warm', 'room', 'cold'] as MilkTemperature[]).map((temp) => {
              const label = temp === 'warm' ? '따뜻하게 ☀️' : temp === 'room' ? '실온 🌡️' : '차가움 ❄️';
              const isSelected = temperature === temp;
              return (
                <TouchableOpacity
                  key={temp}
                  style={[
                    styles.tempButton,
                    isSelected && styles.tempButtonSelected,
                    isSelected && temp === 'warm' && { backgroundColor: COLORS.primary + '20', borderColor: COLORS.primary },
                    isSelected && temp === 'room' && { backgroundColor: COLORS.accent + '20', borderColor: COLORS.accent },
                    isSelected && temp === 'cold' && { backgroundColor: COLORS.secondary + '20', borderColor: COLORS.secondary },
                  ]}
                  onPress={() => setTemperature(temp)}
                >
                  <Text style={[
                    styles.tempButtonText,
                    isSelected && styles.tempButtonTextSelected,
                    isSelected && temp === 'warm' && { color: COLORS.primary },
                    isSelected && temp === 'room' && { color: '#B37D00' },
                    isSelected && temp === 'cold' && { color: '#3A82F6' },
                  ]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Notes input */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>메모</Text>
          <TextInput
            style={styles.notesInput}
            placeholder="특이사항이 있다면 적어주세요. (예: 게워냄, 다 먹지 않음 등)"
            placeholderTextColor={COLORS.textMuted}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
          />
        </View>

        {/* Save Button */}
        <TouchableOpacity 
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={isSaving}
        >
          <Text style={styles.saveButtonText}>
            {isSaving ? '저장 중...' : '기록 저장하기'}
          </Text>
        </TouchableOpacity>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  backButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  placeholder: {
    width: 60, // Balance the back button
  },
  section: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 5,
    elevation: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 12,
  },
  tempSelectorContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tempButton: {
    flex: 0.31,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    alignItems: 'center',
    backgroundColor: COLORS.card,
  },
  tempButtonSelected: {
    // Styling applied dynamically depending on temp type
  },
  tempButtonText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  tempButtonTextSelected: {
    fontWeight: 'bold',
  },
  notesInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: COLORS.text,
    height: 80,
    textAlignVertical: 'top', // align placeholder to top on Android
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
    marginTop: 10,
  },
  saveButtonDisabled: {
    backgroundColor: COLORS.textMuted,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
