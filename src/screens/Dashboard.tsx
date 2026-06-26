import React from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  TouchableOpacity, 
  Alert 
} from 'react-native';
import { BabyLogEntry, BabyProfile, FormulaLog, StoolLog, UrineLog } from '../types';
import { COLORS } from '../theme/colors';
import { getDDay, formatTime, getRelativeDateString } from '../utils/date';

interface DashboardProps {
  logs: BabyLogEntry[];
  profile: BabyProfile;
  onDeleteLog: (id: string) => Promise<void>;
  onNavigate: (screen: 'dashboard' | 'formula' | 'diaper' | 'statistics' | 'profile') => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ logs, profile, onDeleteLog, onNavigate }) => {
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

  const handleDeletePress = (id: string, logType: string) => {
    const typeKorean = logType === 'formula' ? '분유' : logType === 'stool' ? '대변' : '소변';
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
        const tempKo = log.temperature === 'warm' ? '따뜻하게' : log.temperature === 'room' ? '실온' : '차가움';
        return (
          <View>
            <Text style={styles.logDescTitle}>
              분유수유 <Text style={styles.logHighlight}>{log.amount} ml</Text>
            </Text>
            <Text style={styles.logDescSub}>온도: {tempKo}</Text>
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
        const urineWetnessKo = {
          light: '조금',
          medium: '보통',
          large: '많음', // mapping to heavy
          heavy: '많음'
        }[log.wetness];
        return (
          <View>
            <Text style={styles.logDescTitle}>
              소변 💧 <Text style={[styles.logHighlight, { color: COLORS.secondary }]}>{urineWetnessKo}</Text>
            </Text>
            <Text style={styles.logDescSub}>
              색상: {log.color === 'clear' ? '투명함' : log.color === 'normal' ? '보통' : '진함'}
            </Text>
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
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
          <Text style={styles.quickButtonText}>분유 수유</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.quickButton, { backgroundColor: COLORS.accent }]}
          onPress={() => onNavigate('diaper')}
        >
          <Text style={styles.quickButtonIcon}>💩/💧</Text>
          <Text style={styles.quickButtonText}>대소변 기록</Text>
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

                    <TouchableOpacity 
                      style={styles.deleteButton}
                      onPress={() => handleDeletePress(log.id, log.type)}
                    >
                      <Text style={styles.deleteButtonText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
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
  deleteButton: {
    padding: 10,
  },
  deleteButtonText: {
    fontSize: 14,
    color: '#D1CFC7',
    fontWeight: '600',
  },
});
