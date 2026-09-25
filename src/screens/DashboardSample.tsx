import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';

interface DashboardSampleProps {
  onBackToCurrent: () => void;
}

export const DashboardSample: React.FC<DashboardSampleProps> = ({ onBackToCurrent }) => {
  const [activeFilter, setActiveFilter] = useState<'all' | 'feed' | 'diaper' | 'sleep'>('all');
  const [isSleeping, setIsSleeping] = useState(false);

  // 샘플 데이터
  const sampleTimeline = [
    {
      id: '1',
      type: 'formula',
      icon: '🍼',
      tag: '수유 완료',
      time: '13:40',
      relative: '10분 전',
      main: '140 ml',
      sub: '분유 (따뜻하게)',
      color: '#FF6F81',
      bgLight: '#FFF0F3',
    },
    {
      id: '2',
      type: 'diaper',
      icon: '💩',
      tag: '대변 기저귀',
      time: '12:15',
      relative: '1시간 전',
      main: '황금변 (보통/양호)',
      sub: '기저귀 교체 및 보습 완료',
      color: '#E5A038',
      bgLight: '#FFF8EC',
    },
    {
      id: '3',
      type: 'sleep',
      icon: '🌙',
      tag: '낮잠 2차',
      time: '10:00 ~ 11:35',
      relative: '2시간 전',
      main: '1시간 35분 수면',
      sub: '편안하게 잘 잤어요',
      color: '#8A70D6',
      bgLight: '#F3EFFF',
    },
    {
      id: '4',
      type: 'bath',
      icon: '🛁',
      tag: '목욕',
      time: '09:10',
      relative: '4시간 전',
      main: '통목욕 12분',
      sub: '물온도 38°C 적정',
      color: '#38A3A5',
      bgLight: '#E8F7F6',
    },
  ];

  return (
    <View style={styles.container}>
      {/* 샘플 안내 배너 */}
      <View style={styles.previewNoticeBar}>
        <View style={styles.noticeTextContainer}>
          <Text style={styles.noticeBadge}>DESIGN PREVIEW (샘플 모드)</Text>
          <Text style={styles.noticeTitle}>새로운 디자인 샘플 화면입니다</Text>
          <Text style={styles.noticeSub}>기존 데이터는 보존되며, 디자인만 체험할 수 있습니다.</Text>
        </View>
        <TouchableOpacity style={styles.backButton} onPress={onBackToCurrent}>
          <Text style={styles.backButtonText}>기존 화면 복귀</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 1. 아기 프로필 & 데일리 환영 카드 */}
        <View style={styles.babyHeroCard}>
          <View style={styles.babyAvatarCircle}>
            <Text style={styles.babyAvatarEmoji}>👶</Text>
          </View>
          <View style={styles.babyHeroInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.babyHeroName}>하은이</Text>
              <View style={styles.dDayPill}>
                <Text style={styles.dDayPillText}>D+42</Text>
              </View>
            </View>
            <Text style={styles.greetingQuote}>
              오늘도 엄마 아빠 사랑받고 쑥쑥 자라는 중 ✨
            </Text>
            <View style={styles.growthMetaRow}>
              <Text style={styles.growthMetaText}>몸무게 4.6kg (출생 3.2kg)</Text>
            </View>
          </View>
        </View>

        {/* 2. 다음 수유 카운트다운 위젯 (Hero Alert Widget) */}
        <View style={styles.nextFeedingHero}>
          <View style={styles.feedingLeft}>
            <View style={styles.feedingBadgeRow}>
              <View style={styles.pulseDot} />
              <Text style={styles.feedingBadgeLabel}>다음 수유 예정</Text>
            </View>
            <Text style={styles.feedingRemainingTime}>23분 남음</Text>
            <Text style={styles.feedingDetailTime}>오후 02:40 예정 · 수유 간격 3시간</Text>
          </View>
          <TouchableOpacity style={styles.feedingTimeEditChip} activeOpacity={0.8}>
            <Text style={styles.feedingTimeEditChipText}>시간 변경</Text>
          </TouchableOpacity>
        </View>

        {/* 3. 오늘 하루 핵심 요약 카드 (3분할 미니 대시보드) */}
        <View style={styles.statsSummaryRow}>
          <View style={[styles.statBox, { backgroundColor: '#FFF2F4' }]}>
            <Text style={styles.statBoxLabel}>🍼 총 수유</Text>
            <Text style={[styles.statBoxValue, { color: '#E8596D' }]}>420<Text style={styles.statBoxUnit}>ml</Text></Text>
            <View style={styles.statMiniProgress}>
              <View style={[styles.statMiniProgressFill, { width: '52%' }]} />
            </View>
            <Text style={styles.statTargetText}>목표 800ml</Text>
          </View>

          <View style={[styles.statBox, { backgroundColor: '#FFF9ED' }]}>
            <Text style={styles.statBoxLabel}>💩 배변</Text>
            <Text style={[styles.statBoxValue, { color: '#D48810' }]}>2<Text style={styles.statBoxUnit}>회</Text></Text>
            <Text style={styles.statSubInfo}>소변 4회 교체</Text>
          </View>

          <View style={[styles.statBox, { backgroundColor: '#F3EFFF' }]}>
            <Text style={styles.statBoxLabel}>🌙 총 수면</Text>
            <Text style={[styles.statBoxValue, { color: '#7454BF' }]}>5<Text style={styles.statBoxUnit}>h </Text>20<Text style={styles.statBoxUnit}>m</Text></Text>
            <Text style={styles.statSubInfo}>낮잠 2회 완료</Text>
          </View>
        </View>

        {/* 4. 빠른 기록 (한 손 터치에 최적화된 4열 그리드 + 수면 원터치) */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>빠른 기록</Text>
          <Text style={styles.sectionSubtitle}>원터치로 간편하게 기록해요</Text>
        </View>

        <View style={styles.quickActionGrid}>
          {/* 수유 */}
          <TouchableOpacity style={styles.quickActionItem} activeOpacity={0.7}>
            <View style={[styles.quickIconCircle, { backgroundColor: '#FFE6EB' }]}>
              <Text style={styles.quickIconEmoji}>🍼</Text>
            </View>
            <Text style={styles.quickActionTitle}>수유</Text>
            <Text style={styles.quickActionDesc}>분유 / 모유</Text>
          </TouchableOpacity>

          {/* 기저귀 */}
          <TouchableOpacity style={styles.quickActionItem} activeOpacity={0.7}>
            <View style={[styles.quickIconCircle, { backgroundColor: '#E2F8F4' }]}>
              <Text style={styles.quickIconEmoji}>🧷</Text>
            </View>
            <Text style={styles.quickActionTitle}>기저귀</Text>
            <Text style={styles.quickActionDesc}>대변 / 소변</Text>
          </TouchableOpacity>

          {/* 목욕 */}
          <TouchableOpacity style={styles.quickActionItem} activeOpacity={0.7}>
            <View style={[styles.quickIconCircle, { backgroundColor: '#E0F2FE' }]}>
              <Text style={styles.quickIconEmoji}>🛁</Text>
            </View>
            <Text style={styles.quickActionTitle}>목욕</Text>
            <Text style={styles.quickActionDesc}>샤워 / 통목욕</Text>
          </TouchableOpacity>

          {/* 체중 */}
          <TouchableOpacity style={styles.quickActionItem} activeOpacity={0.7}>
            <View style={[styles.quickIconCircle, { backgroundColor: '#FEF3C7' }]}>
              <Text style={styles.quickIconEmoji}>⚖️</Text>
            </View>
            <Text style={styles.quickActionTitle}>체중</Text>
            <Text style={styles.quickActionDesc}>성장 추이</Text>
          </TouchableOpacity>
        </View>

        {/* 원터치 수면 카드 버튼 */}
        <TouchableOpacity
          style={[styles.sleepInteractiveCard, isSleeping && styles.sleepInteractiveCardActive]}
          activeOpacity={0.8}
          onPress={() => setIsSleeping(!isSleeping)}
        >
          <View style={styles.sleepLeftGroup}>
            <Text style={styles.sleepCardIcon}>{isSleeping ? '😴' : '🌙'}</Text>
            <View>
              <Text style={[styles.sleepCardTitle, isSleeping && { color: '#FFFFFF' }]}>
                {isSleeping ? '하은이가 새근새근 잠자는 중이에요' : '수면 시작 / 종료'}
              </Text>
              <Text style={[styles.sleepCardSub, isSleeping && { color: '#D4CEEA' }]}>
                {isSleeping ? '1시간 12분째 수면 중 · 터치하여 깨우기' : '터치 한 번으로 수면 시간을 기록해요'}
              </Text>
            </View>
          </View>
          <View style={[styles.sleepActionTag, isSleeping && styles.sleepActionTagActive]}>
            <Text style={styles.sleepActionTagText}>
              {isSleeping ? '깨우기' : '잠자기'}
            </Text>
          </View>
        </TouchableOpacity>

        {/* 5. 활동 타임라인 (세련된 피드 스타일) */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>오늘의 활동 타임라인</Text>
          <Text style={styles.sectionBadge}>총 {sampleTimeline.length}건</Text>
        </View>

        {/* 타임라인 필터 칩 */}
        <View style={styles.filterChipRow}>
          {(['all', 'feed', 'diaper', 'sleep'] as const).map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, activeFilter === f && styles.filterChipActive]}
              onPress={() => setActiveFilter(f)}
            >
              <Text style={[styles.filterChipText, activeFilter === f && styles.filterChipTextActive]}>
                {f === 'all' ? '전체' : f === 'feed' ? '수유' : f === 'diaper' ? '기저귀' : '수면'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 타임라인 리스트 */}
        <View style={styles.timelineList}>
          {sampleTimeline.map((item, index) => (
            <View key={item.id} style={styles.timelineRow}>
              {/* 왼쪽 시각 & 세로선 */}
              <View style={styles.timelineSidebar}>
                <Text style={styles.timelineTimeText}>{item.time}</Text>
                <View style={[styles.timelineDot, { backgroundColor: item.color }]} />
                {index < sampleTimeline.length - 1 && <View style={styles.timelineVerticalLine} />}
              </View>

              {/* 오른쪽 콘텐츠 카드 */}
              <View style={styles.timelineContentCard}>
                <View style={styles.cardHeaderRow}>
                  <View style={[styles.typeTag, { backgroundColor: item.bgLight }]}>
                    <Text style={styles.typeTagIcon}>{item.icon}</Text>
                    <Text style={[styles.typeTagText, { color: item.color }]}>{item.tag}</Text>
                  </View>
                  <Text style={styles.relativeTimeText}>{item.relative}</Text>
                </View>

                <Text style={styles.cardMainText}>{item.main}</Text>
                <Text style={styles.cardSubText}>{item.sub}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAF7F2',
  },
  previewNoticeBar: {
    backgroundColor: '#2D3142',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  noticeTextContainer: {
    flex: 1,
    paddingRight: 10,
  },
  noticeBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: '#FFB5A7',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  noticeTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  noticeSub: {
    fontSize: 10,
    color: '#B0B5C0',
    marginTop: 2,
  },
  backButton: {
    backgroundColor: '#FF6F81',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 40,
  },
  babyHeroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#362E29',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
  },
  babyAvatarCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#FFE8EC',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
    borderWidth: 2,
    borderColor: '#FFD6DE',
  },
  babyAvatarEmoji: {
    fontSize: 26,
  },
  babyHeroInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  babyHeroName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#2B2B2B',
    marginRight: 8,
  },
  dDayPill: {
    backgroundColor: '#FF6F81',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  dDayPillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  greetingQuote: {
    fontSize: 12,
    color: '#666666',
    fontWeight: '500',
    marginBottom: 4,
  },
  growthMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  growthMetaText: {
    fontSize: 11,
    color: '#9E9E9E',
    fontWeight: '500',
  },
  nextFeedingHero: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#362E29',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
    borderLeftWidth: 5,
    borderLeftColor: '#FF6F81',
  },
  feedingLeft: {
    flex: 1,
  },
  feedingBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#FF6F81',
    marginRight: 6,
  },
  feedingBadgeLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FF6F81',
  },
  feedingRemainingTime: {
    fontSize: 24,
    fontWeight: '900',
    color: '#2A2A2A',
    letterSpacing: -0.5,
    marginVertical: 2,
  },
  feedingDetailTime: {
    fontSize: 12,
    color: '#7D7D7D',
    fontWeight: '500',
  },
  feedingTimeEditChip: {
    backgroundColor: '#F7F7F7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ECECEC',
  },
  feedingTimeEditChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#555555',
  },
  statsSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    gap: 10,
  },
  statBox: {
    flex: 1,
    borderRadius: 18,
    padding: 13,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 6,
    elevation: 1,
  },
  statBoxLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#555555',
    marginBottom: 4,
  },
  statBoxValue: {
    fontSize: 19,
    fontWeight: '900',
    marginBottom: 4,
  },
  statBoxUnit: {
    fontSize: 12,
    fontWeight: '600',
  },
  statMiniProgress: {
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 2,
    marginVertical: 4,
    overflow: 'hidden',
  },
  statMiniProgressFill: {
    height: '100%',
    backgroundColor: '#FF6F81',
    borderRadius: 2,
  },
  statTargetText: {
    fontSize: 10,
    color: '#888888',
    fontWeight: '500',
  },
  statSubInfo: {
    fontSize: 10,
    color: '#888888',
    fontWeight: '500',
    marginTop: 2,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 12,
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#262626',
  },
  sectionSubtitle: {
    fontSize: 11,
    color: '#8E8E8E',
    fontWeight: '500',
  },
  sectionBadge: {
    fontSize: 11,
    color: '#FF6F81',
    fontWeight: '700',
  },
  quickActionGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 10,
  },
  quickActionItem: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#362E29',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  quickIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
  },
  quickIconEmoji: {
    fontSize: 20,
  },
  quickActionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#333333',
    marginBottom: 2,
  },
  quickActionDesc: {
    fontSize: 10,
    color: '#949494',
    fontWeight: '500',
  },
  sleepInteractiveCard: {
    backgroundColor: '#F3EEFF',
    borderRadius: 18,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
    borderWidth: 1,
    borderColor: '#E6DEFF',
  },
  sleepInteractiveCardActive: {
    backgroundColor: '#3E2F6E',
    borderColor: '#4A3B7E',
  },
  sleepLeftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  sleepCardIcon: {
    fontSize: 24,
    marginRight: 10,
  },
  sleepCardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#432E7A',
    marginBottom: 2,
  },
  sleepCardSub: {
    fontSize: 11,
    color: '#7666A6',
    fontWeight: '500',
  },
  sleepActionTag: {
    backgroundColor: '#7752CC',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
  },
  sleepActionTagActive: {
    backgroundColor: '#FF6F81',
  },
  sleepActionTagText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  filterChipRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#EFEFEF',
  },
  filterChipActive: {
    backgroundColor: '#2D3142',
    borderColor: '#2D3142',
  },
  filterChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#777777',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  timelineList: {
    marginTop: 4,
  },
  timelineRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  timelineSidebar: {
    width: 62,
    alignItems: 'center',
    position: 'relative',
    paddingTop: 10,
  },
  timelineTimeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8A8A8A',
    marginBottom: 6,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  timelineVerticalLine: {
    position: 'absolute',
    top: 34,
    bottom: -16,
    width: 2,
    backgroundColor: '#EBE6DC',
  },
  timelineContentCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 14,
    shadowColor: '#362E29',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  typeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  typeTagIcon: {
    fontSize: 11,
    marginRight: 4,
  },
  typeTagText: {
    fontSize: 11,
    fontWeight: '800',
  },
  relativeTimeText: {
    fontSize: 10,
    color: '#A0A0A0',
    fontWeight: '500',
  },
  cardMainText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#2A2A2A',
    marginBottom: 2,
  },
  cardSubText: {
    fontSize: 11,
    color: '#808080',
    fontWeight: '500',
  },
});
