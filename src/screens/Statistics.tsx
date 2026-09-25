import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BabyLogEntry, FormulaLog, SleepLog, TummyTimeLog, PlayLog, WeightLog } from '../types';
import { COLORS } from '../theme/colors';

interface StatisticsProps { logs: BabyLogEntry[]; }
type Range = 'week' | 'all';

const DAY = 24 * 60 * 60 * 1000;
const formatDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
};
type TimedLog = SleepLog | TummyTimeLog | PlayLog;
const getActivityMinutes = (activity: TimedLog) => Math.max(0, Math.floor(((activity.endedAt ?? Date.now()) - activity.timestamp) / 60_000));
const getActivityMinutesForDay = (activity: TimedLog, day: Date) => {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const overlapStart = Math.max(activity.timestamp, dayStart.getTime());
  const overlapEnd = Math.min(activity.endedAt ?? Date.now(), dayEnd.getTime());
  return Math.max(0, Math.floor((overlapEnd - overlapStart) / 60_000));
};
const getNapMinutesForDay = (sleep: SleepLog, day: Date) => {
  const napStart = new Date(day);
  napStart.setHours(9, 0, 0, 0);
  const napEnd = new Date(day);
  napEnd.setHours(19, 0, 0, 0);
  const overlapStart = Math.max(sleep.timestamp, napStart.getTime());
  const overlapEnd = Math.min(sleep.endedAt ?? Date.now(), napEnd.getTime());
  return Math.max(0, Math.floor((overlapEnd - overlapStart) / 60_000));
};
const getNapMinutes = (sleep: SleepLog) => {
  const end = sleep.endedAt ?? Date.now();
  if (end <= sleep.timestamp) return 0;
  const day = new Date(sleep.timestamp);
  day.setHours(0, 0, 0, 0);
  let total = 0;
  while (day.getTime() <= end) {
    total += getNapMinutesForDay(sleep, day);
    day.setDate(day.getDate() + 1);
  }
  return total;
};
const formatDuration = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return hours > 0 ? `${hours}시간${restMinutes > 0 ? ` ${restMinutes}분` : ''}` : `${restMinutes}분`;
};

export const Statistics: React.FC<StatisticsProps> = ({ logs }) => {
  const [range, setRange] = useState<Range>('week');
  const last7Days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    date.setHours(0, 0, 0, 0);
    return date;
  });
  const dailyData = last7Days.map(date => {
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const dayLogs = logs.filter(log => log.timestamp >= date.getTime() && log.timestamp < nextDate.getTime());
    const formulaAmount = dayLogs.filter((log): log is FormulaLog => log.type === 'formula').reduce((sum, log) => sum + log.amount, 0);
    const stools = dayLogs.filter(log => log.type === 'stool').length;
    const urines = dayLogs.filter(log => log.type === 'urine').length;
    const baths = dayLogs.filter(log => log.type === 'bath').length;
    const sleepMinutes = logs.filter((log): log is SleepLog => log.type === 'sleep').reduce((sum, log) => sum + getActivityMinutesForDay(log, date), 0);
    const napMinutes = logs.filter((log): log is SleepLog => log.type === 'sleep').reduce((sum, log) => sum + getNapMinutesForDay(log, date), 0);
    const tummyTimeMinutes = logs.filter((log): log is TummyTimeLog => log.type === 'tummyTime').reduce((sum, log) => sum + getActivityMinutesForDay(log, date), 0);
    const playMinutes = logs.filter((log): log is PlayLog => log.type === 'play').reduce((sum, log) => sum + getActivityMinutesForDay(log, date), 0);
    return {
      dateStr: `${date.getMonth() + 1}/${date.getDate()}`,
      dayName: ['일', '월', '화', '수', '목', '금', '토'][date.getDay()],
      formulaAmount, stools, urines, baths, sleepMinutes, napMinutes, tummyTimeMinutes, playMinutes, totalDiapers: stools + urines,
    };
  });

  const weekFormula = dailyData.reduce((sum, day) => sum + day.formulaAmount, 0);
  const weekStools = dailyData.reduce((sum, day) => sum + day.stools, 0);
  const weekUrines = dailyData.reduce((sum, day) => sum + day.urines, 0);
  const weekBaths = dailyData.reduce((sum, day) => sum + day.baths, 0);
  const weekSleepMinutes = dailyData.reduce((sum, day) => sum + day.sleepMinutes, 0);
  const weekNapMinutes = dailyData.reduce((sum, day) => sum + day.napMinutes, 0);
  const weekTummyTimeMinutes = dailyData.reduce((sum, day) => sum + day.tummyTimeMinutes, 0);
  const weekPlayMinutes = dailyData.reduce((sum, day) => sum + day.playMinutes, 0);
  const allFormula = logs.filter((log): log is FormulaLog => log.type === 'formula').reduce((sum, log) => sum + log.amount, 0);
  const allStools = logs.filter(log => log.type === 'stool').length;
  const allUrines = logs.filter(log => log.type === 'urine').length;
  const allBaths = logs.filter(log => log.type === 'bath').length;
  const allSleepMinutes = logs.filter((log): log is SleepLog => log.type === 'sleep').reduce((sum, log) => sum + getActivityMinutes(log), 0);
  const allNapMinutes = logs.filter((log): log is SleepLog => log.type === 'sleep').reduce((sum, log) => sum + getNapMinutes(log), 0);
  const allTummyTimeMinutes = logs.filter((log): log is TummyTimeLog => log.type === 'tummyTime').reduce((sum, log) => sum + getActivityMinutes(log), 0);
  const allPlayMinutes = logs.filter((log): log is PlayLog => log.type === 'play').reduce((sum, log) => sum + getActivityMinutes(log), 0);
  const weightLogs = logs.filter((log): log is WeightLog => log.type === 'weight').sort((a, b) => a.timestamp - b.timestamp);
  const latestWeight = weightLogs[weightLogs.length - 1];
  const firstWeight = weightLogs[0];
  const sortedTimestamps = logs.map(log => log.timestamp).sort((a, b) => a - b);
  const firstDay = sortedTimestamps[0];
  const lastDay = sortedTimestamps[sortedTimestamps.length - 1];
  const elapsedDays = firstDay ? Math.max(1, Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(firstDay).setHours(0, 0, 0, 0)) / DAY) + 1) : 1;
  const divisor = range === 'week' ? 7 : elapsedDays;
  const summary = range === 'week'
    ? { formula: Math.round(weekFormula / divisor), stools: (weekStools / divisor).toFixed(1), urines: (weekUrines / divisor).toFixed(1), baths: (weekBaths / divisor).toFixed(1), sleep: (weekSleepMinutes / divisor / 60).toFixed(1), nap: formatDuration(Math.round(weekNapMinutes / divisor)), tummyTime: formatDuration(Math.round(weekTummyTimeMinutes / divisor)), play: formatDuration(Math.round(weekPlayMinutes / divisor)) }
    : { formula: allFormula, stools: String(allStools), urines: String(allUrines), baths: String(allBaths), sleep: formatDuration(allSleepMinutes), nap: formatDuration(allNapMinutes), tummyTime: formatDuration(allTummyTimeMinutes), play: formatDuration(allPlayMinutes) };
  const maxFormula = Math.max(1000, ...dailyData.map(day => day.formulaAmount));
  const maxDiapers = Math.max(8, ...dailyData.map(day => day.totalDiapers));
  const maxBaths = Math.max(2, ...dailyData.map(day => day.baths));

  const Metric = ({ emoji, label, value, unit, tint }: { emoji: string; label: string; value: string | number; unit: string; tint: string }) => (
    <View style={[styles.metricItem, { backgroundColor: tint }]}>
      <Text style={styles.metricEmoji}>{emoji}</Text>
      <View>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricValue}>{value} <Text style={styles.metricUnit}>{unit}</Text></Text>
      </View>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <Text style={styles.screenTitle}>통계 & 분석</Text>
      <Text style={styles.subtitle}>{range === 'week' ? '최근 7일의 생활 패턴을 한눈에 확인해요.' : '처음 기록한 날부터 지금까지의 누적 통계예요.'}</Text>

      <View style={styles.rangeTabs}>
        {([['week', '최근 7일'], ['all', '전체']] as const).map(([value, label]) => (
          <TouchableOpacity key={value} style={[styles.rangeTab, range === value && styles.rangeTabActive]} onPress={() => setRange(value)} accessibilityRole="tab" accessibilityState={{ selected: range === value }}>
            <Text style={[styles.rangeTabText, range === value && styles.rangeTabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {range === 'all' && (
        <View style={styles.periodCard}>
          <Text style={styles.periodTitle}>총 {logs.length}개의 활동 기록</Text>
          <Text style={styles.periodText}>{firstDay ? `${formatDate(firstDay)} ~ ${formatDate(lastDay)} · ${elapsedDays}일간` : '아직 저장된 기록이 없어요.'}</Text>
        </View>
      )}

      <View style={styles.summaryCard}>
        <Text style={styles.cardHeader}>{range === 'week' ? '일일 평균' : '전체 누적'}</Text>
        <View style={styles.metricGrid}>
          <Metric emoji="🍼" label="수유량" value={summary.formula} unit="ml" tint={COLORS.lightPink} />
          <Metric emoji="💩" label="대변" value={summary.stools} unit="회" tint={COLORS.lightYellow} />
          <Metric emoji="💧" label="소변" value={summary.urines} unit="회" tint={COLORS.lightBlue} />
          <Metric emoji="🛁" label="목욕" value={summary.baths} unit="회" tint={COLORS.lightMint} />
          <Metric emoji="🌙" label={range === 'week' ? '평균 수면' : '수면 시간'} value={summary.sleep} unit={range === 'week' ? '시간' : ''} tint="#EDE9F8" />
          <Metric emoji="☀️" label={range === 'week' ? '평균 낮잠' : '낮잠 시간'} value={summary.nap} unit="" tint="#FFF3D6" />
          <Metric emoji="🤸" label={range === 'week' ? '평균 터미타임' : '터미타임'} value={summary.tummyTime} unit="" tint="#FDF1E4" />
          <Metric emoji="🎈" label={range === 'week' ? '평균 놀기시간' : '놀기시간'} value={summary.play} unit="" tint="#EDF7ED" />
          {latestWeight && <Metric emoji="⚖️" label="최근 체중" value={latestWeight.weightKg} unit="kg" tint="#EAF0F7" />}
        </View>
        {range === 'all' && logs.length > 0 && <Text style={styles.averageHint}>하루 평균 수유 {Math.round(allFormula / elapsedDays)}ml · 기저귀 {((allStools + allUrines) / elapsedDays).toFixed(1)}회</Text>}
      </View>

      {range === 'week' && (
        <>
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>일일 수유량 (ml)</Text>
            <View style={styles.barChartContainer}>
              {dailyData.map((day, index) => <Bar key={day.dateStr} value={day.formulaAmount} max={maxFormula} day={day} color={index === 6 ? COLORS.primary : COLORS.secondary} />)}
            </View>
          </View>
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>기저귀 교체 횟수 (회)</Text>
            <View style={styles.barChartContainer}>
              {dailyData.map(day => <DiaperBar key={day.dateStr} day={day} max={maxDiapers} />)}
            </View>
            <View style={styles.legendRow}>
              <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.secondary }]} /><Text style={styles.legendText}>소변</Text></View>
              <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.accent }]} /><Text style={styles.legendText}>대변</Text></View>
            </View>
          </View>
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>목욕 횟수 (회)</Text>
            <View style={styles.barChartContainer}>
              {dailyData.map(day => <Bar key={day.dateStr} value={day.baths} max={maxBaths} day={day} color={COLORS.bath} />)}
            </View>
          </View>
        </>
      )}
      {latestWeight && (
        <View style={styles.periodCard}>
          <Text style={styles.periodTitle}>⚖️ 성장 기록</Text>
          <Text style={styles.periodText}>최근 {latestWeight.weightKg}kg · {formatDate(latestWeight.timestamp)}{firstWeight && firstWeight.id !== latestWeight.id ? ` · 첫 기록보다 ${(latestWeight.weightKg - firstWeight.weightKg).toFixed(2)}kg` : ''}</Text>
        </View>
      )}
    </ScrollView>
  );
};

const Bar = ({ value, max, day, color }: { value: number; max: number; day: { dateStr: string; dayName: string }; color: string }) => (
  <View style={styles.barCol}>
    <Text style={styles.barValue}>{value || ''}</Text>
    <View style={styles.barTrack}><View style={[styles.barFill, { height: `${(value / max) * 100}%`, backgroundColor: color }]} /></View>
    <Text style={styles.barLabel}>{day.dateStr}</Text>
    <Text style={styles.barSubLabel}>({day.dayName})</Text>
  </View>
);

const DiaperBar = ({ day, max }: { day: { dateStr: string; dayName: string; urines: number; stools: number; totalDiapers: number }; max: number }) => (
  <View style={styles.barCol}>
    <Text style={styles.barValue}>{day.totalDiapers || ''}</Text>
    <View style={styles.barTrack}>
      <View style={[styles.barSegment, { height: `${(day.stools / max) * 100}%`, backgroundColor: COLORS.accent }]} />
      <View style={[styles.barSegment, { height: `${(day.urines / max) * 100}%`, backgroundColor: COLORS.secondary }]} />
    </View>
    <Text style={styles.barLabel}>{day.dateStr}</Text>
    <Text style={styles.barSubLabel}>({day.dayName})</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  contentContainer: { padding: 20, paddingBottom: 40 },
  screenTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.text, marginBottom: 4 },
  subtitle: { fontSize: 13, color: COLORS.textMuted, marginBottom: 16 },
  rangeTabs: { flexDirection: 'row', backgroundColor: '#F1EEE8', padding: 4, borderRadius: 14, marginBottom: 18 },
  rangeTab: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 11 },
  rangeTabActive: { backgroundColor: COLORS.card, elevation: 2 },
  rangeTabText: { color: COLORS.textMuted, fontSize: 14, fontWeight: '700' },
  rangeTabTextActive: { color: COLORS.primary, fontWeight: 'bold' },
  periodCard: { backgroundColor: COLORS.lightMint, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#D8EEE9' },
  periodTitle: { color: COLORS.text, fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
  periodText: { color: COLORS.textMuted, fontSize: 12 },
  summaryCard: { backgroundColor: COLORS.card, borderRadius: 22, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: COLORS.border, elevation: 2 },
  cardHeader: { fontSize: 15, fontWeight: 'bold', color: COLORS.text, marginBottom: 12 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metricItem: { width: '48%', flexGrow: 1, minHeight: 86, borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center' },
  metricEmoji: { fontSize: 25, marginRight: 10 },
  metricLabel: { fontSize: 11, color: COLORS.textMuted, marginBottom: 3 },
  metricValue: { fontSize: 17, fontWeight: 'bold', color: COLORS.text },
  metricUnit: { fontSize: 11, fontWeight: 'normal', color: COLORS.textMuted },
  averageHint: { marginTop: 12, color: COLORS.textMuted, fontSize: 12, textAlign: 'center' },
  chartCard: { backgroundColor: COLORS.card, borderRadius: 22, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: COLORS.border, elevation: 2 },
  chartTitle: { fontSize: 14, fontWeight: 'bold', color: COLORS.text, marginBottom: 18 },
  barChartContainer: { flexDirection: 'row', alignItems: 'flex-end', height: 170, paddingHorizontal: 4 },
  barCol: { flex: 1, alignItems: 'center' },
  barValue: { height: 14, fontSize: 9, fontWeight: 'bold', color: COLORS.textMuted },
  barTrack: { width: 15, height: 120, backgroundColor: 'rgba(0,0,0,0.035)', borderRadius: 7, justifyContent: 'flex-end', overflow: 'hidden', marginBottom: 7 },
  barFill: { width: '100%', borderRadius: 7 },
  barSegment: { width: '100%' },
  barLabel: { fontSize: 10, fontWeight: 'bold', color: COLORS.text },
  barSubLabel: { fontSize: 8, color: COLORS.textMuted, marginTop: 1 },
  chartHint: { textAlign: 'center', color: COLORS.textMuted, fontSize: 11, marginTop: 12 },
  legendRow: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 9, height: 9, borderRadius: 5, marginRight: 6 },
  legendText: { color: COLORS.textMuted, fontSize: 11, fontWeight: '600' },
});
