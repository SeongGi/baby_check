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
import { MilkTemperature, FeedingType } from '../types';

interface LogFormulaProps {
  onAddLog: (log: {
    type: 'formula';
    feedingType: FeedingType;
    amount: number;
    formulaAmount?: number;
    breastAmount?: number;
    temperature?: MilkTemperature;
    timestamp: number;
    notes?: string;
  }) => Promise<any>;
  onNavigate: (screen: 'dashboard') => void;
}

export const LogFormula: React.FC<LogFormulaProps> = ({ onAddLog, onNavigate }) => {
  const [feedingType, setFeedingType] = useState<FeedingType>('formula');
  const [amount, setAmount] = useState<number>(120); // Default to 120ml for single types
  const [formulaAmount, setFormulaAmount] = useState<string>('60'); // Default formula for mixed
  const [breastAmount, setBreastAmount] = useState<string>('60'); // Default breast for mixed
  const [temperature, setTemperature] = useState<MilkTemperature>('warm');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [scrollEnabled, setScrollEnabled] = useState(true);

  const handleSave = async () => {
    let finalAmount = amount;
    let mixedFormulaAmount: number | undefined = undefined;
    let mixedBreastAmount: number | undefined = undefined;

    if (feedingType === 'mixed') {
      const fAmt = parseInt(formulaAmount) || 0;
      const bAmt = parseInt(breastAmount) || 0;
      finalAmount = fAmt + bAmt;
      mixedFormulaAmount = fAmt;
      mixedBreastAmount = bAmt;
    }

    if (finalAmount <= 0) {
      alert('수유 양을 10ml 이상 선택해주세요.');
      return;
    }

    setIsSaving(true);
    try {
      await onAddLog({
        type: 'formula',
        feedingType,
        amount: finalAmount,
        formulaAmount: mixedFormulaAmount,
        breastAmount: mixedBreastAmount,
        temperature: feedingType === 'breast' ? undefined : temperature,
        timestamp: Date.now(),
        notes: notes.trim() ? notes.trim() : undefined,
      });
      // Reset
      setAmount(120);
      setFormulaAmount('60');
      setBreastAmount('60');
      setTemperature('warm');
      setNotes('');
      // Navigate
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
          <Text style={styles.headerTitle}>수유 기록</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Feeding Type Tab Bar */}
        <View style={styles.tabContainer}>
          {(['formula', 'breast', 'mixed'] as FeedingType[]).map((type) => {
            const label = type === 'formula' ? '🍼 분유' : type === 'breast' ? '🤱 모유' : '🥛 혼합';
            const isSelected = feedingType === type;
            return (
              <TouchableOpacity
                key={type}
                style={[styles.tabButton, isSelected && styles.tabButtonActive]}
                onPress={() => setFeedingType(type)}
              >
                <Text style={[styles.tabButtonText, isSelected && styles.tabButtonTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Dynamic Amount Selector */}
        {feedingType === 'mixed' ? (
          /* Mixed feeding inputs */
          <View style={styles.mixedInputsCard}>
            <Text style={styles.mixedInputsTitle}>혼합 수유 비율 입력</Text>
            
            <View style={styles.mixedInputRow}>
              <View style={styles.mixedInputGroup}>
                <Text style={styles.mixedInputLabel}>분유량 (ml)</Text>
                <TextInput
                  style={styles.mixedInput}
                  value={formulaAmount}
                  onChangeText={(val) => setFormulaAmount(val.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="예: 60"
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
              
              <Text style={styles.mixedPlus}>+</Text>
              
              <View style={styles.mixedInputGroup}>
                <Text style={styles.mixedInputLabel}>모유량 (ml)</Text>
                <TextInput
                  style={styles.mixedInput}
                  value={breastAmount}
                  onChangeText={(val) => setBreastAmount(val.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="예: 60"
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
            </View>
            
            <View style={styles.mixedTotalRow}>
              <Text style={styles.mixedTotalLabel}>총 합계 수유량</Text>
              <Text style={styles.mixedTotalValue}>
                {(parseInt(formulaAmount) || 0) + (parseInt(breastAmount) || 0)} <Text style={styles.mixedTotalUnit}>ml</Text>
              </Text>
            </View>
          </View>
        ) : (
          /* Single type bottle slider */
          <BottleSlider 
            value={amount} 
            onChange={setAmount} 
            onDragStart={() => setScrollEnabled(false)}
            onDragEnd={() => setScrollEnabled(true)}
          />
        )}

        {/* Temperature Selector (Only for Formula or Mixed) */}
        {feedingType !== 'breast' && (
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
        )}

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
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: 14,
    padding: 4,
    marginBottom: 20,
  },
  tabButton: {
    flex: 0.33,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabButtonActive: {
    backgroundColor: COLORS.card,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  tabButtonText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  tabButtonTextActive: {
    color: COLORS.text,
  },
  mixedInputsCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 5,
    elevation: 1,
  },
  mixedInputsTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 16,
  },
  mixedInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 16,
  },
  mixedInputGroup: {
    flex: 0.44,
  },
  mixedInputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textMuted,
    marginBottom: 8,
    textAlign: 'center',
  },
  mixedInput: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.primary,
    backgroundColor: COLORS.background,
    textAlign: 'center',
  },
  mixedPlus: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginTop: 15,
  },
  mixedTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  mixedTotalLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  mixedTotalValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  mixedTotalUnit: {
    fontSize: 14,
    color: COLORS.textMuted,
    fontWeight: 'normal',
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
    // Dynamic styles
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
