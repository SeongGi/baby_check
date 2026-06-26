import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { BabyLogEntry, FormulaLog } from '../types';
import { COLORS } from '../theme/colors';

interface StatisticsProps {
  logs: BabyLogEntry[];
}

export const Statistics: React.FC<StatisticsProps> = ({ logs }) => {
  // Generate last 7 days date objects
  const getLast7Days = () => {
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dates.push(d);
    }
    return dates;
  };

  const last7Days = getLast7Days();

  // Aggregate data for each day
  const dailyData = last7Days.map(date => {
    const startOfDay = date.getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    const dayLogs = logs.filter(log => log.timestamp >= startOfDay && log.timestamp < endOfDay);

    const formulaAmount = dayLogs
      .filter((log): log is FormulaLog => log.type === 'formula')
      .reduce((sum, log) => sum + log.amount, 0);

    const stools = dayLogs.filter(log => log.type === 'stool').length;
    const urines = dayLogs.filter(log => log.type === 'urine').length;

    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    const dayName = ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];

    return {
      dateStr: label,
      dayName,
      formulaAmount,
      stools,
      urines,
      totalDiapers: stools + urines,
    };
  });

  // Calculate averages
  const formulaDaysWithIntake = dailyData.filter(d => d.formulaAmount > 0);
  const avgFormula = formulaDaysWithIntake.length > 0 
    ? Math.round(formulaDaysWithIntake.reduce((sum, d) => sum + d.formulaAmount, 0) / formulaDaysWithIntake.length)
    : 0;

  const totalStools = dailyData.reduce((sum, d) => sum + d.stools, 0);
  const totalUrines = dailyData.reduce((sum, d) => sum + d.urines, 0);
  const avgStools = (totalStools / 7).toFixed(1);
  const avgUrines = (totalUrines / 7).toFixed(1);

  // Math max for scaling charts
  const maxFormulaAmount = Math.max(1000, ...dailyData.map(d => d.formulaAmount));
  const maxDiapers = Math.max(8, ...dailyData.map(d => d.totalDiapers));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <Text style={styles.screenTitle}>통계 & 분석</Text>
      <Text style={styles.subtitle}>최근 7일간 기록된 평균 활동 수치입니다.</Text>

      {/* Averages Card */}
      <View style={styles.avgCard}>
        <Text style={styles.cardHeader}>일일 평균 수치</Text>
        
        <View style={styles.avgRow}>
          <View style={styles.avgItem}>
            <Text style={styles.avgEmoji}>🍼</Text>
            <Text style={styles.avgLabel}>수유량</Text>
            <Text style={styles.avgValue}>{avgFormula} <Text style={styles.avgUnit}>ml</Text></Text>
          </View>
          
          <View style={styles.divider} />
          
          <View style={styles.avgItem}>
            <Text style={styles.avgEmoji}>💩</Text>
            <Text style={styles.avgLabel}>대변</Text>
            <Text style={styles.avgValue}>{avgStools} <Text style={styles.avgUnit}>회</Text></Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.avgItem}>
            <Text style={styles.avgEmoji}>💧</Text>
            <Text style={styles.avgLabel}>소변</Text>
            <Text style={styles.avgValue}>{avgUrines} <Text style={styles.avgUnit}>회</Text></Text>
          </View>
        </View>
      </View>

      {/* Formula Intake Chart */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>일일 분유 수유량 (ml)</Text>
        
        <View style={styles.barChartContainer}>
          {dailyData.map((d, idx) => {
            const barHeight = (d.formulaAmount / maxFormulaAmount) * 120;
            const isTodayVal = idx === 6; // last item is today
            return (
              <View key={idx} style={styles.barCol}>
                <Text style={styles.barValText}>{d.formulaAmount > 0 ? d.formulaAmount : ''}</Text>
                <View style={styles.barTrack}>
                  <View 
                    style={[
                      styles.barFill, 
                      { 
                        height: barHeight,
                        backgroundColor: isTodayVal ? COLORS.primary : COLORS.secondary
                      }
                    ]} 
                  />
                </View>
                <Text style={styles.barLabel}>{d.dateStr}</Text>
                <Text style={styles.barSubLabel}>({d.dayName})</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Diaper Frequency Chart */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>기저귀 교체 횟수 (회)</Text>
        
        <View style={styles.barChartContainer}>
          {dailyData.map((d, idx) => {
            const stoolHeight = (d.stools / maxDiapers) * 120;
            const urineHeight = (d.urines / maxDiapers) * 120;
            return (
              <View key={idx} style={styles.barCol}>
                <Text style={styles.barValText}>{d.totalDiapers > 0 ? d.totalDiapers : ''}</Text>
                <View style={styles.barTrack}>
                  <View 
                    style={[
                      styles.barFillSegment, 
                      { 
                        height: urineHeight,
                        backgroundColor: COLORS.secondary,
                        borderBottomLeftRadius: 6,
                        borderBottomRightRadius: 6,
                      }
                    ]} 
                  />
                  <View 
                    style={[
                      styles.barFillSegment, 
                      { 
                        height: stoolHeight,
                        backgroundColor: COLORS.accent,
                        borderTopLeftRadius: stoolHeight > 0 ? 6 : 0,
                        borderTopRightRadius: stoolHeight > 0 ? 6 : 0,
                      }
                    ]} 
                  />
                </View>
                <Text style={styles.barLabel}>{d.dateStr}</Text>
                <Text style={styles.barSubLabel}>({d.dayName})</Text>
              </View>
            );
          })}
        </View>
        
        <View style={styles.legendContainer}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.accent }]} />
            <Text style={styles.legendText}>대변 💩</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.secondary }]} />
            <Text style={styles.legendText}>소변 💧</Text>
          </View>
        </View>
      </View>
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
  avgCard: {
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
  cardHeader: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 15,
  },
  avgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  avgItem: {
    alignItems: 'center',
  },
  avgEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  avgLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginBottom: 2,
  },
  avgValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  avgUnit: {
    fontSize: 12,
    fontWeight: 'normal',
    color: COLORS.textMuted,
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: COLORS.border,
  },
  chartCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 20,
  },
  barChartContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 170,
    paddingHorizontal: 8,
  },
  barCol: {
    alignItems: 'center',
    flex: 1,
  },
  barValText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: COLORS.textMuted,
    marginBottom: 4,
    height: 12,
  },
  barTrack: {
    width: 14,
    height: 120,
    backgroundColor: 'rgba(0, 0, 0, 0.03)',
    borderRadius: 6,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    marginBottom: 8,
  },
  barFill: {
    width: '100%',
    borderRadius: 6,
  },
  barFillSegment: {
    width: '100%',
  },
  barLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  barSubLabel: {
    fontSize: 8,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  legendContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 15,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  legendText: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
});
