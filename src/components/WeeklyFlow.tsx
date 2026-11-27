import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BabyLogEntry } from '../types';
import { COLORS } from '../theme/colors';
import { buildWeeklyCards, WeeklyCard } from '../utils/weeklyCards';

interface WeeklyFlowProps { logs: BabyLogEntry[]; }

const formatMonthDay = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

// 증감 표시입니다. 좋고 나쁨을 뜻하지 않도록 중립 색을 씁니다.
const Delta = ({ value, digits }: { value: number | null | undefined; digits: number }) => {
  if (value === null || value === undefined) return null;
  if (value > 0) return <Text style={[styles.delta, { color: COLORS.primary }]}>▲{value.toFixed(digits)}</Text>;
  if (value < 0) return <Text style={[styles.delta, { color: COLORS.secondary }]}>▼{Math.abs(value).toFixed(digits)}</Text>;
  return <Text style={[styles.delta, { color: COLORS.textMuted }]}>±0</Text>;
};

const Row = ({ emoji, label, children }: { emoji: string; label: string; children: React.ReactNode }) => (
  <View style={styles.row}>
    <Text style={styles.rowEmoji}>{emoji}</Text>
    <View style={styles.rowBody}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValues}>{children}</View>
    </View>
  </View>
);

const Value = ({ value, unit, delta, digits }: { value: number | null; unit: string; delta: number | null | undefined; digits: number }) => (
  <View style={styles.valueGroup}>
    {value === null
      ? <Text style={styles.valueMuted}>기록 없음</Text>
      : <Text style={styles.value}>{value.toFixed(digits)}<Text style={styles.unit}> {unit}</Text></Text>}
    <Delta value={delta} digits={digits} />
  </View>
);

const WeekCard = ({ card }: { card: WeeklyCard }) => (
  <View style={styles.card}>
    <View style={styles.cardHeader}>
      <Text style={styles.cardLabel}>{card.label}</Text>
      {card.isLatest && <View style={styles.badge}><Text style={styles.badgeText}>최근 1주</Text></View>}
    </View>
    <Text style={styles.cardSub}>완료된 {card.coveredDays}일 평균</Text>
    <Row emoji="🍼" label="하루 수유량">
      <Value value={card.formulaPerDay} unit="ml" delta={card.delta?.formulaPerDay} digits={0} />
      {card.formulaPerDay !== null && <Value value={card.feedsPerDay} unit="회" delta={card.delta?.feedsPerDay} digits={1} />}
    </Row>
    <Row emoji="🌙" label="하루 수면">
      <Value value={card.sleepHoursPerDay} unit="시간" delta={card.delta?.sleepHoursPerDay} digits={1} />
    </Row>
    <Row emoji="🧷" label="하루 기저귀">
      <Value value={card.diapersPerDay} unit="회" delta={card.delta?.diapersPerDay} digits={1} />
    </Row>
    <Row emoji="⚖️" label="체중">
      {card.weightKg === null
        ? <Text style={styles.valueMuted}>이 주 측정 없음</Text>
        : <Value value={card.weightKg} unit="kg" delta={card.weightDeltaKg} digits={2} />}
    </Row>
  </View>
);

export const WeeklyFlow: React.FC<WeeklyFlowProps> = ({ logs }) => {
  const cards = useMemo(() => buildWeeklyCards(logs), [logs]);
  // 선택 상태는 인덱스가 아니라 카드의 start로 들고 있어 카드 목록이 바뀌어도 보던 주를 유지합니다.
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [pageWidth, setPageWidth] = useState(0);
  // 처음 위치를 맞추기 전에는 카드를 투명하게 둬 가장 오래된 주가 잠깐 보이지 않게 합니다.
  const [positioned, setPositioned] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const alignedKeyRef = useRef('');
  const previousCountRef = useRef(cards.length);

  const foundIndex = selectedStart === null ? -1 : cards.findIndex(card => card.start === selectedStart);
  const selectedIndex = foundIndex >= 0 ? foundIndex : cards.length - 1;
  const effectiveStart = cards[selectedIndex]?.start ?? null;

  const makeKey = (start: number | null) => `${pageWidth}|${cards.map(card => card.start).join(',')}|${start}`;

  // 선택 카드 위치로 맞춥니다. 키가 지난번과 같으면 아무것도 하지 않아 사용자가 넘긴 뒤에는 끌고 가지 않습니다.
  const alignPosition = () => {
    if (pageWidth <= 0 || cards.length === 0) return;
    const key = makeKey(effectiveStart);
    if (key === alignedKeyRef.current) return;
    alignedKeyRef.current = key;
    scrollRef.current?.scrollTo({ x: selectedIndex * pageWidth, animated: false });
    if (!positioned) setPositioned(true);
  };

  useEffect(() => {
    // 카드 장수가 달라지면 콘텐츠 크기가 바뀌어 onContentSizeChange가 오므로 그쪽에 맡깁니다.
    // 크기가 새로 잡히기 전에 맞추면 위치가 잘려 키만 소비되기 때문입니다.
    const sameCount = previousCountRef.current === cards.length;
    previousCountRef.current = cards.length;
    if (sameCount) alignPosition();
  }, [cards]);

  const goTo = (index: number) => {
    if (index < 0 || index >= cards.length || pageWidth <= 0) return;
    const start = cards[index].start;
    setSelectedStart(start);
    alignedKeyRef.current = makeKey(start);
    scrollRef.current?.scrollTo({ x: index * pageWidth, animated: true });
  };

  // 폭이 바뀌면 카드 폭도 바뀌어 onContentSizeChange가 따라오므로 위치 맞추기는 그쪽에 맡깁니다.
  const handleLayout = (event: LayoutChangeEvent) => {
    setPageWidth(event.nativeEvent.layout.width);
  };

  const handleMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0 || cards.length === 0) return;
    const index = Math.max(0, Math.min(cards.length - 1, Math.round(event.nativeEvent.contentOffset.x / pageWidth)));
    const start = cards[index].start;
    alignedKeyRef.current = makeKey(start);
    setSelectedStart(start);
  };

  if (logs.length === 0) return <Text style={styles.empty}>아직 저장된 기록이 없어요.</Text>;
  if (cards.length === 0) return <Text style={styles.empty}>하루가 지나면 첫 주 카드가 만들어져요.</Text>;

  const maxFormula = Math.max(1, ...cards.map(card => card.formulaPerDay ?? 0));

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        style={{ opacity: positioned ? 1 : 0 }}
        onLayout={handleLayout}
        onContentSizeChange={alignPosition}
        onMomentumScrollEnd={handleMomentumScrollEnd}
      >
        {pageWidth > 0 && cards.map(card => (
          <View key={card.start} style={[styles.page, { width: pageWidth }]}>
            <WeekCard card={card} />
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {cards.map((card, index) => <View key={card.start} style={[styles.dot, index === selectedIndex && styles.dotActive]} />)}
      </View>
      <View style={styles.navRow}>
        <TouchableOpacity style={[styles.navButton, selectedIndex <= 0 && styles.navButtonDisabled]} disabled={selectedIndex <= 0} onPress={() => goTo(selectedIndex - 1)} accessibilityRole="button" accessibilityState={{ disabled: selectedIndex <= 0 }}>
          <Text style={styles.navText}>‹ 지난주</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navButton, selectedIndex >= cards.length - 1 && styles.navButtonDisabled]} disabled={selectedIndex >= cards.length - 1} onPress={() => goTo(selectedIndex + 1)} accessibilityRole="button" accessibilityState={{ disabled: selectedIndex >= cards.length - 1 }}>
          <Text style={styles.navText}>다음 주 ›</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>주별 하루 수유량 (ml)</Text>
        <View style={styles.barChart}>
          {cards.map((card, index) => (
            <TouchableOpacity key={card.start} style={styles.barCol} onPress={() => goTo(index)} accessibilityRole="button" accessibilityLabel={`${card.label} 주로 이동`} accessibilityState={{ selected: index === selectedIndex }}>
              <Text style={styles.barValue}>{card.formulaPerDay ?? ''}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { height: `${((card.formulaPerDay ?? 0) / maxFormula) * 100}%`, backgroundColor: index === selectedIndex ? COLORS.primary : COLORS.secondary }]} />
              </View>
              <Text style={[styles.barLabel, index === selectedIndex && styles.barLabelActive]}>{formatMonthDay(card.start)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  empty: { textAlign: 'center', color: COLORS.textMuted, fontSize: 13, paddingVertical: 40 },
  // 카드 사이 간격은 바깥 margin 대신 안쪽 padding으로 만들어 카드 폭이 pageWidth와 정확히 같게 둡니다.
  page: { paddingHorizontal: 4 },
  card: { backgroundColor: COLORS.card, borderRadius: 22, padding: 18, borderWidth: 1, borderColor: COLORS.border, elevation: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
  badge: { backgroundColor: COLORS.lightPink, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: 'bold', color: COLORS.primary },
  cardSub: { fontSize: 12, color: COLORS.textMuted, marginTop: 4, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: COLORS.border },
  rowEmoji: { fontSize: 24, width: 38 },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 11, color: COLORS.textMuted, marginBottom: 3 },
  rowValues: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16 },
  valueGroup: { flexDirection: 'row', alignItems: 'baseline' },
  value: { fontSize: 17, fontWeight: 'bold', color: COLORS.text },
  unit: { fontSize: 11, fontWeight: 'normal', color: COLORS.textMuted },
  valueMuted: { fontSize: 13, color: COLORS.textMuted },
  delta: { fontSize: 12, fontWeight: 'bold', marginLeft: 6 },
  dots: { flexDirection: 'row', justifyContent: 'center', marginTop: 14 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.border, marginHorizontal: 3 },
  dotActive: { backgroundColor: COLORS.primary },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginBottom: 20 },
  navButton: { minHeight: 42, paddingHorizontal: 18, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  navButtonDisabled: { opacity: 0.35 },
  navText: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  chartCard: { backgroundColor: COLORS.card, borderRadius: 22, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: COLORS.border, elevation: 2 },
  chartTitle: { fontSize: 14, fontWeight: 'bold', color: COLORS.text, marginBottom: 18 },
  barChart: { flexDirection: 'row', alignItems: 'flex-end', height: 170 },
  barCol: { flex: 1, alignItems: 'center' },
  barValue: { height: 14, fontSize: 9, fontWeight: 'bold', color: COLORS.textMuted },
  barTrack: { width: 15, height: 120, backgroundColor: 'rgba(0,0,0,0.035)', borderRadius: 7, justifyContent: 'flex-end', overflow: 'hidden', marginBottom: 7 },
  barFill: { width: '100%', borderRadius: 7 },
  barLabel: { fontSize: 9, color: COLORS.textMuted },
  barLabelActive: { fontWeight: 'bold', color: COLORS.text },
});
