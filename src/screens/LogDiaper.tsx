import React, { useState } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  TextInput, 
  ScrollView, 
  KeyboardAvoidingView, 
  Platform 
} from 'react-native';
import { COLORS } from '../theme/colors';
import { StoolAmount, StoolColor, StoolConsistency, UrineColor, UrineWetness } from '../types';

interface LogDiaperProps {
  onAddLog: (log: any) => Promise<any>;
  onNavigate: (screen: 'dashboard') => void;
}

export const LogDiaper: React.FC<LogDiaperProps> = ({ onAddLog, onNavigate }) => {
  const [activeTab, setActiveTab] = useState<'stool' | 'urine'>('stool');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Stool States
  const [stoolColor, setStoolColor] = useState<StoolColor>('yellow');
  const [stoolConsistency, setStoolConsistency] = useState<StoolConsistency>('soft');
  const [stoolAmount, setStoolAmount] = useState<StoolAmount>('medium');

  // Urine States
  const [urineWetness, setUrineWetness] = useState<UrineWetness>('medium');
  const [urineColor, setUrineColor] = useState<UrineColor>('normal');

  const poopColorGuides: Record<StoolColor, { name: string; description: string; isWarning: boolean }> = {
    yellow: {
      name: '황금색/노란색',
      description: '건강한 모유 또는 분유 수유아의 가장 전형적이고 정상적인 변 색깔입니다. 안심하세요! 👍',
      isWarning: false,
    },
    green: {
      name: '녹색/황록색',
      description: '담즙이 빠르게 통과하거나 시금치, 철분 등의 섭취로 생길 수 있는 정상 범주의 변 색깔입니다. 😊',
      isWarning: false,
    },
    brown: {
      name: '갈색/황갈색',
      description: '이유식을 먹거나 시간이 흐르며 장내 유산균 변화로 생기는 정상적인 변 색깔입니다. 👌',
      isWarning: false,
    },
    red: {
      name: '빨간색 (혈변)',
      description: '항문 입구 상처나 장염, 알레르기 등으로 피가 섞여 나왔을 수 있습니다. 지속될 경우 소아과 진료를 권장합니다. ⚠️',
      isWarning: true,
    },
    black: {
      name: '검은색 (흑변)',
      description: '생후 수일 내 태변이 아닌데 검은 변이 지속되면 위나 십이지장 등 상부 소화기관 출혈일 수 있으니 의사와 상담하세요. 🚨',
      isWarning: true,
    },
    grey: {
      name: '회색/흰색 (담도 폐쇄 의심)',
      description: '담즙이 십이지장으로 분비되지 못해 생기는 현상(담도폐쇄증 등)일 수 있습니다. 꼭 기저귀를 지참하여 병원을 가세요. 🚨',
      isWarning: true,
    },
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (activeTab === 'stool') {
        await onAddLog({
          type: 'stool',
          color: stoolColor,
          consistency: stoolConsistency,
          amount: stoolAmount,
          timestamp: Date.now(),
          notes: notes.trim() ? notes.trim() : undefined,
        });
      } else {
        await onAddLog({
          type: 'urine',
          wetness: urineWetness,
          color: urineColor,
          timestamp: Date.now(),
          notes: notes.trim() ? notes.trim() : undefined,
        });
      }
      
      // Reset
      setNotes('');
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
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        {/* Header Title */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton}>
            <Text style={styles.backButtonText}>← 뒤로</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>기저귀 기록</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Segmented Tab */}
        <View style={styles.tabContainer}>
          <TouchableOpacity 
            style={[styles.tabButton, activeTab === 'stool' && styles.tabButtonActive]}
            onPress={() => { setActiveTab('stool'); setNotes(''); }}
          >
            <Text style={[styles.tabButtonText, activeTab === 'stool' && styles.tabButtonTextActive]}>
              💩 대변
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tabButton, activeTab === 'urine' && styles.tabButtonActive]}
            onPress={() => { setActiveTab('urine'); setNotes(''); }}
          >
            <Text style={[styles.tabButtonText, activeTab === 'urine' && styles.tabButtonTextActive]}>
              💧 소변
            </Text>
          </TouchableOpacity>
        </View>

        {activeTab === 'stool' ? (
          /* Stool (Poop) Section */
          <View>
            {/* Color Swatch Picker */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>대변 색상 가이드 (선택)</Text>
              <View style={styles.colorPaletteGrid}>
                {(Object.keys(poopColorGuides) as StoolColor[]).map((color) => {
                  const isSelected = stoolColor === color;
                  const hex = COLORS.stool[color];
                  return (
                    <TouchableOpacity
                      key={color}
                      style={[
                        styles.colorSwatchContainer,
                        isSelected && styles.colorSwatchSelected
                      ]}
                      onPress={() => setStoolColor(color)}
                    >
                      <View style={[styles.colorSwatchCircle, { backgroundColor: hex }]} />
                      <Text style={styles.colorSwatchLabel}>
                        {color === 'yellow' ? '황금' : color === 'green' ? '녹색' : color === 'brown' ? '갈색' : color === 'red' ? '적색' : color === 'black' ? '흑색' : '회색'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Color Advice Box */}
              <View style={[
                styles.adviceBox, 
                poopColorGuides[stoolColor].isWarning ? styles.adviceBoxWarning : styles.adviceBoxNormal
              ]}>
                <Text style={[
                  styles.adviceTitle, 
                  poopColorGuides[stoolColor].isWarning ? styles.adviceTitleWarning : styles.adviceTitleNormal
                ]}>
                  {poopColorGuides[stoolColor].name}
                </Text>
                <Text style={styles.adviceDesc}>
                  {poopColorGuides[stoolColor].description}
                </Text>
              </View>
            </View>

            {/* Consistency Picker */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>대변 형태</Text>
              <View style={styles.optionsRow}>
                {(['soft', 'watery', 'hard'] as StoolConsistency[]).map((cons) => {
                  const label = cons === 'soft' ? '보통/황금 😊' : cons === 'watery' ? '묽음/설사 💧' : '단단함/변비 🪵';
                  const isSelected = stoolConsistency === cons;
                  return (
                    <TouchableOpacity
                      key={cons}
                      style={[styles.optionButton, isSelected && styles.optionButtonActive]}
                      onPress={() => setStoolConsistency(cons)}
                    >
                      <Text style={[styles.optionText, isSelected && styles.optionTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Amount Picker */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>대변 양</Text>
              <View style={styles.optionsRow}>
                {(['small', 'medium', 'large'] as StoolAmount[]).map((amt) => {
                  const label = amt === 'small' ? '적음 🤏' : amt === 'medium' ? '보통 👍' : '많음 🙌';
                  const isSelected = stoolAmount === amt;
                  return (
                    <TouchableOpacity
                      key={amt}
                      style={[styles.optionButton, isSelected && styles.optionButtonActive]}
                      onPress={() => setStoolAmount(amt)}
                    >
                      <Text style={[styles.optionText, isSelected && styles.optionTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
        ) : (
          /* Urine (Pee) Section */
          <View style={styles.section}>
            <View style={styles.simpleUrineCard}>
              <Text style={styles.simpleUrineEmoji}>💧</Text>
              <Text style={styles.simpleUrineTitle}>소변 기저귀 교체</Text>
              <Text style={styles.simpleUrineDesc}>
                기저귀에 소변을 확인하고 단순 기저귀 교체 기록을 저장합니다.
              </Text>
            </View>
          </View>
        )}

        {/* Memo Input */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>메모</Text>
          <TextInput
            style={styles.notesInput}
            placeholder={activeTab === 'stool' ? '대변 냄새나 기타 증상이 있다면 적어주세요.' : '소변 특이사항을 기록해보세요.'}
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
    marginBottom: 20,
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
    width: 60,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: 14,
    padding: 4,
    marginBottom: 20,
  },
  tabButton: {
    flex: 0.5,
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
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  tabButtonTextActive: {
    color: COLORS.text,
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
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 14,
  },
  colorPaletteGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  colorSwatchContainer: {
    width: '31%',
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
    marginBottom: 8,
  },
  colorSwatchSelected: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.lightPink,
  },
  colorSwatchCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginBottom: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
    elevation: 1,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
  },
  colorSwatchLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.text,
  },
  adviceBox: {
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
  },
  adviceBoxNormal: {
    backgroundColor: '#F7FCF7',
    borderColor: '#D2ECD2',
  },
  adviceBoxWarning: {
    backgroundColor: '#FFF5F5',
    borderColor: '#FED7D7',
  },
  adviceTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  adviceTitleNormal: {
    color: COLORS.success,
  },
  adviceTitleWarning: {
    color: COLORS.danger,
  },
  adviceDesc: {
    fontSize: 11,
    color: COLORS.text,
    lineHeight: 16,
  },
  optionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  optionButton: {
    flex: 0.31,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    alignItems: 'center',
    backgroundColor: COLORS.card,
  },
  optionButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.lightPink,
  },
  optionText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  optionTextActive: {
    color: COLORS.primary,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: COLORS.text,
    height: 80,
    textAlignVertical: 'top',
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
  simpleUrineCard: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  simpleUrineEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  simpleUrineTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 8,
  },
  simpleUrineDesc: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 20,
  },
});
