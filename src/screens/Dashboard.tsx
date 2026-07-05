import React, { useState } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  TouchableOpacity, 
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  RefreshControl
} from 'react-native';
import { BabyLogEntry, BabyProfile, FormulaLog, StoolLog, UrineLog, MilkTemperature, FeedingType, StoolColor, StoolConsistency, StoolAmount } from '../types';
import { COLORS } from '../theme/colors';
import { getDDay, formatTime, getRelativeDateString, formatDateTime } from '../utils/date';
import { BottleSlider } from '../components/BottleSlider';

interface DashboardProps {
  logs: BabyLogEntry[];
  profile: BabyProfile;
  onDeleteLog: (id: string) => Promise<void>;
  onUpdateLog: (log: BabyLogEntry) => Promise<void>;
  onNavigate: (screen: 'dashboard' | 'formula' | 'diaper' | 'statistics' | 'profile') => void;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ 
  logs, 
  profile, 
  onDeleteLog, 
  onUpdateLog, 
  onNavigate,
  refreshing,
  onRefresh
}) => {
  const dday = getDDay(profile.birthDate);

  // Filter logs for today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTimestamp = todayStart.getTime();

  const todayLogs = logs.filter(log => log.timestamp >= todayTimestamp);

  // Compute today's statistics
  const totalFormulaMl = todayLogs
    .filter((log): log is FormulaLog => log.type === 'formula')
    .reduce((sum, log) => sum + log.amount, 0);

  const totalStools = todayLogs.filter(log => log.type === 'stool').length;
  const totalUrines = todayLogs.filter(log => log.type === 'urine').length;

  const formulaProgress = Math.min(1, totalFormulaMl / profile.targetFormula);

  // Edit Modal States
  const [editingLog, setEditingLog] = useState<BabyLogEntry | null>(null);
  const [editTimestamp, setEditTimestamp] = useState<number>(0);
  const [editNotes, setEditNotes] = useState('');
  
  // Formula edit states
  const [editFeedingType, setEditFeedingType] = useState<FeedingType>('formula');
  const [editAmount, setEditAmount] = useState<number>(120);
  const [editFormulaAmount, setEditFormulaAmount] = useState('60');
  const [editBreastAmount, setEditBreastAmount] = useState('60');
  const [editTemperature, setEditTemperature] = useState<MilkTemperature>('warm');
  
  // Stool edit states
  const [editStoolColor, setEditStoolColor] = useState<StoolColor>('yellow');
  const [editStoolConsistency, setEditStoolConsistency] = useState<StoolConsistency>('soft');
  const [editStoolAmount, setEditStoolAmount] = useState<StoolAmount>('medium');

  // Time state inputs
  const [editHour, setEditHour] = useState('0');
  const [editMin, setEditMin] = useState('0');

  const handleEditPress = (log: BabyLogEntry) => {
    setEditingLog(log);
    setEditTimestamp(log.timestamp);
    setEditNotes(log.notes || '');
    
    const dateObj = new Date(log.timestamp);
    setEditHour(dateObj.getHours().toString());
    setEditMin(dateObj.getMinutes().toString().padStart(2, '0'));

    if (log.type === 'formula') {
      setEditFeedingType(log.feedingType || 'formula');
      setEditAmount(log.amount);
      setEditFormulaAmount(log.formulaAmount?.toString() || '60');
      setEditBreastAmount(log.breastAmount?.toString() || '60');
      setEditTemperature(log.temperature || 'warm');
    } else if (log.type === 'stool') {
      setEditStoolColor(log.color);
      setEditStoolConsistency(log.consistency);
      setEditStoolAmount(log.amount);
    }
  };

  const handleOffsetTime = (minutesOffset: number) => {
    const newTs = editTimestamp + minutesOffset * 60 * 1000;
    setEditTimestamp(newTs);
    const dateObj = new Date(newTs);
    setEditHour(dateObj.getHours().toString());
    setEditMin(dateObj.getMinutes().toString().padStart(2, '0'));
  };

  const handleTimeHourChange = (text: string) => {
    const filtered = text.replace(/[^0-9]/g, '');
    setEditHour(filtered);
    if (filtered !== '') {
      const h = Math.min(23, Math.max(0, parseInt(filtered) || 0));
      const dateObj = new Date(editTimestamp);
      dateObj.setHours(h);
      setEditTimestamp(dateObj.getTime());
    }
  };

  const handleTimeMinChange = (text: string) => {
    const filtered = text.replace(/[^0-9]/g, '');
    setEditMin(filtered);
    if (filtered !== '') {
      const m = Math.min(59, Math.max(0, parseInt(filtered) || 0));
      const dateObj = new Date(editTimestamp);
      dateObj.setMinutes(m);
      setEditTimestamp(dateObj.getTime());
    }
  };

  const handleSaveEdit = async () => {
    if (!editingLog) return;
    
    let updatedLog: BabyLogEntry = { ...editingLog };
    updatedLog.timestamp = editTimestamp;
    updatedLog.notes = editNotes.trim() ? editNotes.trim() : undefined;
    
    if (editingLog.type === 'formula') {
      let finalAmount = editAmount;
      let mixedFormulaAmount: number | undefined = undefined;
      let mixedBreastAmount: number | undefined = undefined;
      
      if (editFeedingType === 'mixed') {
        const fAmt = parseInt(editFormulaAmount) || 0;
        const bAmt = parseInt(editBreastAmount) || 0;
        finalAmount = fAmt + bAmt;
        mixedFormulaAmount = fAmt;
        mixedBreastAmount = bAmt;
      }
      
      updatedLog = {
        ...updatedLog,
        feedingType: editFeedingType,
        amount: finalAmount,
        formulaAmount: mixedFormulaAmount,
        breastAmount: mixedBreastAmount,
        temperature: editFeedingType === 'breast' ? undefined : editTemperature,
      } as FormulaLog;
    } else if (editingLog.type === 'stool') {
      updatedLog = {
        ...updatedLog,
        color: editStoolColor,
        consistency: editStoolConsistency,
        amount: editStoolAmount,
      } as StoolLog;
    }
    
    await onUpdateLog(updatedLog);
    setEditingLog(null);
  };

  const handleDeletePress = (id: string, logType: string) => {
    const typeKorean = logType === 'formula' ? '수유' : logType === 'stool' ? '대변' : '소변';
    Alert.alert(
      '기록 삭제',
      `이 ${typeKorean} 기록을 삭제하시겠습니까?`,
      [
        { text: '취소', style: 'cancel' },
        { 
          text: '삭제', 
          style: 'destructive', 
          onPress: () => onDeleteLog(id) 
        }
      ]
    );
  };

  // Helper to render timeline description
  const renderLogDesc = (log: BabyLogEntry) => {
    switch (log.type) {
      case 'formula':
        const typeKo = log.feedingType === 'breast' ? '모유🤱' : log.feedingType === 'mixed' ? '혼합🥛' : '분유🍼';
        const tempKo = log.temperature ? (log.temperature === 'warm' ? '따뜻하게' : log.temperature === 'room' ? '실온' : '차가움') : '';
        return (
          <View>
            <Text style={styles.logDescTitle}>
              {typeKo} <Text style={styles.logHighlight}>{log.amount} ml</Text>
            </Text>
            {log.feedingType === 'mixed' ? (
              <Text style={styles.logDescSub}>분유: {log.formulaAmount} | 모유: {log.breastAmount} {tempKo ? `(${tempKo})` : ''}</Text>
            ) : (
              tempKo ? <Text style={styles.logDescSub}>온도: {tempKo}</Text> : null
            )}
          </View>
        );
      case 'stool':
        const stoolColorKo = {
          yellow: '황색 🟡',
          green: '녹색 🟢',
          brown: '갈색 🟤',
          red: '적색(혈변) 🔴',
          black: '흑색 ⚫',
          grey: '회색 ⚪'
        }[log.color];
        const stoolConsistencyKo = {
          soft: '보통',
          watery: '묽음',
          hard: '단단함'
        }[log.consistency];
        const stoolAmountKo = {
          small: '적음',
          medium: '보통',
          large: '많음'
        }[log.amount];
        return (
          <View>
            <Text style={styles.logDescTitle}>
              대변 💩 <Text style={[styles.logHighlight, { color: COLORS.stool[log.color] || COLORS.text }]}>{stoolColorKo}</Text>
            </Text>
            <Text style={styles.logDescSub}>
              형태: {stoolConsistencyKo} | 양: {stoolAmountKo}
            </Text>
          </View>
        );
      case 'urine':
        return (
          <View>
            <Text style={styles.logDescTitle}>
              소변 💧 <Text style={[styles.logHighlight, { color: COLORS.secondary }]}>교체완료</Text>
            </Text>
            <Text style={styles.logDescSub}>기저귀 교체함</Text>
          </View>
        );
    }
  };

  // Helper to get log color circle
  const getLogDotColor = (type: string) => {
    if (type === 'formula') return COLORS.primary;
    if (type === 'stool') return COLORS.accent;
    return COLORS.secondary;
  };

  // Group all logs by day
  const groupedLogs: { [key: string]: BabyLogEntry[] } = {};
  logs.forEach(log => {
    const dayStr = getRelativeDateString(log.timestamp);
    if (!groupedLogs[dayStr]) {
      groupedLogs[dayStr] = [];
    }
    groupedLogs[dayStr].push(log);
  });

  const poopColorGuides: Record<StoolColor, string> = {
    yellow: '황금',
    green: '녹색',
    brown: '갈색',
    red: '적색',
    black: '흑색',
    grey: '회색',
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView 
        style={styles.container} 
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing || false}
              onRefresh={onRefresh}
              colors={[COLORS.primary]}
              tintColor={COLORS.primary}
            />
          ) : undefined
        }
      >
        {/* Baby Greeting Card (Clickable to edit Profile) */}
        <TouchableOpacity 
          style={styles.babyCard} 
          onPress={() => onNavigate('profile')}
          activeOpacity={0.8}
        >
          <View style={styles.babyCardHeader}>
            <Text style={styles.babyName}>{profile.name}</Text>
            <View style={styles.ddayBadge}>
              <Text style={styles.ddayText}>D+{dday}</Text>
            </View>
          </View>
          <Text style={styles.babyInfo}>
            생일: {profile.birthDate} | 출생 체중: {profile.birthWeight}kg
          </Text>
          <Text style={styles.babyQuote}>
            {dday <= 30 ? '새근새근 세상에 적응 중이에요 🍼' : '오늘 하루도 쑥쑥 건강하게 자라고 있어요! ❤️'}
          </Text>
          <Text style={styles.editIndicator}>✏️ 터치하여 수정하기</Text>
        </TouchableOpacity>

        {/* Summary Cards */}
        <View style={styles.summaryContainer}>
          {/* Formula summary */}
          <TouchableOpacity 
            style={styles.summaryCard}
            onPress={() => onNavigate('statistics')}
          >
            <Text style={styles.summaryTitle}>🍼 오늘 수유</Text>
            <Text style={styles.summaryValue}>
              {totalFormulaMl} <Text style={styles.summaryUnit}>/ {profile.targetFormula}ml</Text>
            </Text>
            {/* Custom progress bar */}
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${formulaProgress * 100}%` }]} />
            </View>
          </TouchableOpacity>

          {/* Diaper summary */}
          <View style={styles.doubleCardRow}>
            <TouchableOpacity 
              style={[styles.summaryCard, styles.halfCard, { backgroundColor: COLORS.lightYellow }]}
              onPress={() => onNavigate('statistics')}
            >
              <Text style={styles.summaryTitle}>💩 대변</Text>
              <Text style={styles.summaryValue}>{totalStools} <Text style={styles.summaryUnit}>회</Text></Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.summaryCard, styles.halfCard, { backgroundColor: COLORS.lightBlue }]}
              onPress={() => onNavigate('statistics')}
            >
              <Text style={styles.summaryTitle}>💧 소변</Text>
              <Text style={styles.summaryValue}>{totalUrines} <Text style={styles.summaryUnit}>회</Text></Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Quick Action Logging Buttons */}
        <Text style={styles.sectionHeader}>빠른 기록</Text>
        <View style={styles.quickActionsContainer}>
          <TouchableOpacity 
            style={[styles.quickButton, { backgroundColor: COLORS.primary }]}
            onPress={() => onNavigate('formula')}
          >
            <Text style={styles.quickButtonIcon}>🍼</Text>
            <Text style={styles.quickButtonText}>수유 기록</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.quickButton, { backgroundColor: COLORS.accent }]}
            onPress={() => onNavigate('diaper')}
          >
            <Text style={styles.quickButtonIcon}>💩/💧</Text>
            <Text style={styles.quickButtonText}>기저귀 기록</Text>
          </TouchableOpacity>
        </View>

        {/* Chronological History Timeline */}
        <Text style={styles.sectionHeader}>활동 타임라인</Text>
        {logs.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>👶</Text>
            <Text style={styles.emptyText}>아직 기록된 활동이 없습니다.</Text>
            <Text style={styles.emptySubText}>분유 수유나 대소변을 먼저 기록해보세요!</Text>
          </View>
        ) : (
          <View style={styles.timelineContainer}>
            {Object.keys(groupedLogs).map(day => (
              <View key={day} style={styles.dayGroup}>
                <Text style={styles.dayHeader}>{day}</Text>
                
                {groupedLogs[day].map((log) => (
                  <View key={log.id} style={styles.timelineItem}>
                    {/* Timeline connectors */}
                    <View style={styles.timelineLeft}>
                      <Text style={styles.logTime}>{formatTime(log.timestamp)}</Text>
                      <View style={[styles.logDot, { backgroundColor: getLogDotColor(log.type) }]} />
                      <View style={styles.timelineLine} />
                    </View>

                    {/* Log Content Card */}
                    <View style={styles.logCard}>
                      <View style={styles.logContent}>
                        {renderLogDesc(log)}
                        {log.notes ? (
                          <Text style={styles.logNotes}>📝 {log.notes}</Text>
                        ) : null}
                      </View>

                      <View style={styles.logActionButtons}>
                        <TouchableOpacity 
                          style={styles.actionButton}
                          onPress={() => handleEditPress(log)}
                        >
                          <Text style={styles.actionButtonText}>✏️</Text>
                        </TouchableOpacity>
                        <TouchableOpacity 
                          style={styles.actionButton}
                          onPress={() => handleDeletePress(log.id, log.type)}
                        >
                          <Text style={[styles.actionButtonText, { color: '#FF5252' }]}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Interactive Edit Modal */}
      {editingLog && (
        <Modal
          visible={!!editingLog}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setEditingLog(null)}
        >
          <KeyboardAvoidingView 
            style={styles.modalOverlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.modalContent}>
              {/* Modal Header */}
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>기록 수정 ({editingLog.type === 'formula' ? '수유' : editingLog.type === 'stool' ? '대변' : '소변'})</Text>
                <TouchableOpacity onPress={() => setEditingLog(null)} style={styles.modalCloseButton}>
                  <Text style={styles.modalCloseText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.modalScrollView} showsVerticalScrollIndicator={false}>
                {/* 1. Time edit section */}
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>⏰ 시간 설정</Text>
                  <Text style={styles.timeDisplay}>{formatDateTime(editTimestamp)}</Text>
                  
                  {/* Offset Buttons */}
                  <View style={styles.timeOffsetRow}>
                    <TouchableOpacity style={styles.offsetButton} onPress={() => handleOffsetTime(-30)}>
                      <Text style={styles.offsetButtonText}>-30분</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.offsetButton} onPress={() => handleOffsetTime(-10)}>
                      <Text style={styles.offsetButtonText}>-10분</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.offsetButton} onPress={() => handleOffsetTime(10)}>
                      <Text style={styles.offsetButtonText}>+10분</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.offsetButton} onPress={() => handleOffsetTime(30)}>
                      <Text style={styles.offsetButtonText}>+30분</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Hour:Min Direct Inputs */}
                  <View style={styles.timeInputRow}>
                    <TextInput
                      style={styles.timeInput}
                      value={editHour}
                      onChangeText={handleTimeHourChange}
                      keyboardType="number-pad"
                      maxLength={2}
                    />
                    <Text style={styles.timeSeparator}>:</Text>
                    <TextInput
                      style={styles.timeInput}
                      value={editMin}
                      onChangeText={handleTimeMinChange}
                      keyboardType="number-pad"
                      maxLength={2}
                    />
                  </View>
                </View>

                {/* 2. Values edit section (Dynamic based on LogType) */}
                {editingLog.type === 'formula' && (
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>🍼 수유 상세 내용</Text>
                    
                    {/* Feeding Type Selector */}
                    <View style={styles.modalTabContainer}>
                      {(['formula', 'breast', 'mixed'] as FeedingType[]).map((type) => {
                        const isSelected = editFeedingType === type;
                        return (
                          <TouchableOpacity
                            key={type}
                            style={[styles.modalTabButton, isSelected && styles.modalTabButtonActive]}
                            onPress={() => setEditFeedingType(type)}
                          >
                            <Text style={[styles.modalTabButtonText, isSelected && styles.modalTabButtonTextActive]}>
                              {type === 'formula' ? '분유' : type === 'breast' ? '모유' : '혼합'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {editFeedingType === 'mixed' ? (
                      /* Mixed amounts */
                      <View style={styles.modalMixedContainer}>
                        <View style={styles.modalMixedRow}>
                          <View style={styles.modalMixedCol}>
                            <Text style={styles.mixedInputLabel}>분유량 (ml)</Text>
                            <TextInput
                              style={styles.mixedInput}
                              value={editFormulaAmount}
                              onChangeText={val => setEditFormulaAmount(val.replace(/[^0-9]/g, ''))}
                              keyboardType="number-pad"
                              maxLength={3}
                            />
                          </View>
                          <Text style={styles.mixedPlus}>+</Text>
                          <View style={styles.modalMixedCol}>
                            <Text style={styles.mixedInputLabel}>모유량 (ml)</Text>
                            <TextInput
                              style={styles.mixedInput}
                              value={editBreastAmount}
                              onChangeText={val => setEditBreastAmount(val.replace(/[^0-9]/g, ''))}
                              keyboardType="number-pad"
                              maxLength={3}
                            />
                          </View>
                        </View>
                        <Text style={styles.modalMixedSumText}>
                          총 합계: {(parseInt(editFormulaAmount) || 0) + (parseInt(editBreastAmount) || 0)} ml
                        </Text>
                      </View>
                    ) : (
                      /* Single slider */
                      <View style={styles.modalSliderContainer}>
                        <BottleSlider
                          value={editAmount}
                          onChange={setEditAmount}
                        />
                      </View>
                    )}

                    {/* Temperature Picker (Only for Formula or Mixed) */}
                    {editFeedingType !== 'breast' && (
                      <View style={{ marginTop: 12 }}>
                        <Text style={styles.mixedInputLabel}>온도</Text>
                        <View style={styles.modalTempContainer}>
                          {(['warm', 'room', 'cold'] as MilkTemperature[]).map((t) => {
                            const isSelected = editTemperature === t;
                            return (
                              <TouchableOpacity
                                key={t}
                                style={[styles.modalTempButton, isSelected && styles.modalTempButtonActive]}
                                onPress={() => setEditTemperature(t)}
                              >
                                <Text style={[styles.modalTempButtonText, isSelected && styles.modalTempButtonTextActive]}>
                                  {t === 'warm' ? '따뜻' : t === 'room' ? '실온' : '차감'}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    )}
                  </View>
                )}

                {editingLog.type === 'stool' && (
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>💩 대변 상세 내용</Text>
                    
                    {/* Color Swatch Selector */}
                    <Text style={styles.modalSubLabel}>대변 색상</Text>
                    <View style={styles.modalColorsGrid}>
                      {(Object.keys(poopColorGuides) as StoolColor[]).map((c) => {
                        const isSelected = editStoolColor === c;
                        return (
                          <TouchableOpacity
                            key={c}
                            style={[styles.modalColorItem, isSelected && styles.modalColorItemActive]}
                            onPress={() => setEditStoolColor(c)}
                          >
                            <View style={[styles.modalColorDot, { backgroundColor: COLORS.stool[c] }]} />
                            <Text style={styles.modalColorLabel}>{poopColorGuides[c]}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* Consistency picker */}
                    <Text style={[styles.modalSubLabel, { marginTop: 10 }]}>대변 형태</Text>
                    <View style={styles.modalSelectorRow}>
                      {(['soft', 'watery', 'hard'] as StoolConsistency[]).map((cons) => {
                        const isSelected = editStoolConsistency === cons;
                        return (
                          <TouchableOpacity
                            key={cons}
                            style={[styles.modalSelectorBtn, isSelected && styles.modalSelectorBtnActive]}
                            onPress={() => setEditStoolConsistency(cons)}
                          >
                            <Text style={[styles.modalSelectorBtnText, isSelected && styles.modalSelectorBtnTextActive]}>
                              {cons === 'soft' ? '보통' : cons === 'watery' ? '묽음' : '단단'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* Amount picker */}
                    <Text style={[styles.modalSubLabel, { marginTop: 10 }]}>대변 양</Text>
                    <View style={styles.modalSelectorRow}>
                      {(['small', 'medium', 'large'] as StoolAmount[]).map((amt) => {
                        const isSelected = editStoolAmount === amt;
                        return (
                          <TouchableOpacity
                            key={amt}
                            style={[styles.modalSelectorBtn, isSelected && styles.modalSelectorBtnActive]}
                            onPress={() => setEditStoolAmount(amt)}
                          >
                            <Text style={[styles.modalSelectorBtnText, isSelected && styles.modalSelectorBtnTextActive]}>
                              {amt === 'small' ? '적음' : amt === 'medium' ? '보통' : '많음'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* 3. Notes edit section */}
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>📝 메모 수정</Text>
                  <TextInput
                    style={styles.modalNotesInput}
                    placeholder="특이사항 메모를 입력해주세요."
                    placeholderTextColor={COLORS.textMuted}
                    value={editNotes}
                    onChangeText={setEditNotes}
                    multiline
                  />
                </View>
              </ScrollView>

              {/* Action buttons */}
              <View style={styles.modalFooter}>
                <TouchableOpacity 
                  style={[styles.modalButton, styles.modalCancelBtn]} 
                  onPress={() => setEditingLog(null)}
                >
                  <Text style={styles.modalCancelBtnText}>취소</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.modalButton, styles.modalSaveBtn]} 
                  onPress={handleSaveEdit}
                >
                  <Text style={styles.modalSaveBtnText}>수정 완료</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  babyCard: {
    backgroundColor: COLORS.card,
    borderRadius: 24,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  babyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  babyName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  ddayBadge: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  ddayText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  babyInfo: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginBottom: 10,
  },
  babyQuote: {
    fontSize: 13,
    color: COLORS.primary,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  editIndicator: {
    fontSize: 10,
    color: COLORS.textMuted,
    textAlign: 'right',
    marginTop: 4,
    fontWeight: '600',
  },
  summaryContainer: {
    marginBottom: 20,
  },
  summaryCard: {
    backgroundColor: COLORS.lightPink,
    borderRadius: 20,
    padding: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 5,
    elevation: 1,
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  summaryUnit: {
    fontSize: 14,
    fontWeight: 'normal',
    color: COLORS.textMuted,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 4,
    marginTop: 10,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: 4,
  },
  doubleCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  halfCard: {
    flex: 0.485,
    marginBottom: 0,
  },
  sectionHeader: {
    fontSize: 17,
    fontWeight: 'bold',
    color: COLORS.text,
    marginTop: 15,
    marginBottom: 12,
  },
  quickActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  quickButton: {
    flex: 0.485,
    borderRadius: 18,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  quickButtonIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  quickButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  emptyContainer: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 30,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 4,
  },
  emptySubText: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  timelineContainer: {
    paddingLeft: 10,
  },
  dayGroup: {
    marginBottom: 20,
  },
  dayHeader: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginBottom: 10,
    backgroundColor: COLORS.background,
    alignSelf: 'flex-start',
    paddingRight: 10,
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: 12,
    position: 'relative',
  },
  timelineLeft: {
    width: 60,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 12,
  },
  logTime: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '600',
    textAlign: 'center',
  },
  logDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2.5,
    borderColor: COLORS.card,
    marginTop: 6,
    zIndex: 2,
  },
  timelineLine: {
    position: 'absolute',
    top: 24,
    bottom: -16,
    width: 2,
    backgroundColor: COLORS.border,
    zIndex: 1,
  },
  logCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
    elevation: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logContent: {
    flex: 1,
  },
  logDescTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  logHighlight: {
    fontWeight: '900',
    color: COLORS.primary,
  },
  logDescSub: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  logNotes: {
    fontSize: 12,
    color: '#666666',
    marginTop: 6,
    fontStyle: 'italic',
  },
  logActionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    padding: 10,
    marginLeft: 4,
  },
  actionButtonText: {
    fontSize: 16,
    color: '#D1CFC7',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: COLORS.card,
    borderRadius: 24,
    width: '100%',
    maxHeight: '92%',
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingBottom: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  modalCloseButton: {
    padding: 6,
  },
  modalCloseText: {
    fontSize: 18,
    color: COLORS.textMuted,
    fontWeight: 'bold',
  },
  modalScrollView: {
    marginBottom: 12,
  },
  modalSection: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingBottom: 16,
  },
  modalSectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 8,
  },
  timeDisplay: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.primary,
    textAlign: 'center',
    marginVertical: 4,
  },
  timeOffsetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 8,
  },
  offsetButton: {
    flex: 0.23,
    backgroundColor: COLORS.lightPink,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primary + '15',
  },
  offsetButtonText: {
    color: COLORS.primary,
    fontSize: 11,
    fontWeight: 'bold',
  },
  timeInputRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  timeInput: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 8,
    width: 60,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text,
    backgroundColor: COLORS.background,
  },
  timeSeparator: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginHorizontal: 8,
  },
  modalTabContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  modalTabButton: {
    flex: 0.33,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  modalTabButtonActive: {
    backgroundColor: COLORS.card,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  modalTabButtonText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  modalTabButtonTextActive: {
    color: COLORS.text,
  },
  modalSliderContainer: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  modalMixedContainer: {
    backgroundColor: COLORS.background,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalMixedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  modalMixedCol: {
    flex: 0.44,
  },
  mixedInputLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textMuted,
    marginBottom: 6,
    textAlign: 'center',
  },
  mixedInput: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 8,
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.primary,
    backgroundColor: COLORS.card,
    textAlign: 'center',
  },
  mixedPlus: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginTop: 15,
  },
  modalMixedSumText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginTop: 12,
  },
  modalTempContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  modalTempButton: {
    flex: 0.31,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    alignItems: 'center',
    backgroundColor: COLORS.card,
  },
  modalTempButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.lightPink,
  },
  modalTempButtonText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  modalTempButtonTextActive: {
    color: COLORS.primary,
  },
  modalSubLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  modalColorsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  modalColorItem: {
    width: '31%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
    backgroundColor: COLORS.card,
  },
  modalColorItemActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.lightPink,
  },
  modalColorDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginRight: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.1)',
  },
  modalColorLabel: {
    fontSize: 11,
    color: COLORS.text,
    fontWeight: '600',
  },
  modalSelectorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalSelectorBtn: {
    flex: 0.31,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    alignItems: 'center',
    backgroundColor: COLORS.card,
  },
  modalSelectorBtnActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.lightPink,
  },
  modalSelectorBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: COLORS.textMuted,
  },
  modalSelectorBtnTextActive: {
    color: COLORS.primary,
  },
  modalNotesInput: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    fontSize: 13,
    color: COLORS.text,
    backgroundColor: COLORS.background,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 14,
  },
  modalButton: {
    flex: 0.485,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelBtn: {
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  modalCancelBtnText: {
    color: COLORS.text,
    fontWeight: 'bold',
    fontSize: 14,
  },
  modalSaveBtn: {
    backgroundColor: COLORS.primary,
  },
  modalSaveBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
});
