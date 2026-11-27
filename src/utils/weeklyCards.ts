import type { BabyLogEntry } from '../types';

// react-native를 가져오지 않는 순수 계산 모듈입니다. node 테스트가 직접 불러옵니다.

export interface WeeklyDelta {
  formulaPerDay: number | null;
  feedsPerDay: number | null;
  sleepHoursPerDay: number | null;
  diapersPerDay: number | null;
}

export interface WeeklyCard {
  start: number; // 주 시작(포함) 로컬 자정
  end: number; // 주 끝(제외) 로컬 자정
  label: string; // "11/20 ~ 11/26" (끝 날짜는 end 하루 전)
  isLatest: boolean; // 어제로 끝나는 가장 최근 주
  coveredDays: number; // 평균의 분모가 되는 날 수(1~7)
  formulaPerDay: number | null; // ml 정수
  feedsPerDay: number | null; // 소수 1자리
  sleepHoursPerDay: number | null; // 소수 1자리
  diapersPerDay: number | null; // 대변과 소변 합계 소수 1자리
  weightKg: number | null; // 이 주에 잰 마지막 체중
  weightDeltaKg: number | null; // 이 주 이전에 잰 가장 최근 체중과의 차이 소수 2자리
  delta: WeeklyDelta | null; // 바로 앞 주와의 차이
}

const DEFAULT_MAX_WEEKS = 12;

const midnight = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date;
};

// 오늘 자정에서 days일 전의 자정입니다.
const daysBefore = (base: Date, days: number) => {
  const date = new Date(base);
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date;
};

const roundTo = (value: number, digits: number) => {
  const factor = 10 ** digits;
  // 절댓값으로 반올림해 늘어난 쪽과 줄어든 쪽을 같은 크기로 보입니다. + 0은 -0을 0으로 바꿉니다.
  return Math.sign(value) * Math.round(Math.abs(value) * factor) / factor + 0;
};

const diff = (current: number | null, previous: number | null, digits: number) =>
  current === null || previous === null ? null : roundTo(current - previous, digits);

const formatMonthDay = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

const countDays = (start: Date, end: Date, firstDay: number) => {
  let count = 0;
  const day = new Date(start);
  while (day.getTime() < end.getTime()) {
    if (day.getTime() >= firstDay) count += 1;
    day.setDate(day.getDate() + 1);
  }
  return count;
};

export function buildWeeklyCards(allLogs: BabyLogEntry[], now: number = Date.now(), maxWeeks: number = DEFAULT_MAX_WEEKS): WeeklyCard[] {
  // 시각이 깨진 기록은 첫 기록일을 망가뜨리므로 계산에서 뺍니다.
  const logs = allLogs.filter(log => Number.isFinite(log.timestamp));
  if (logs.length === 0) return [];
  const limit = Number.isFinite(maxWeeks) ? Math.max(1, Math.floor(maxWeeks)) : DEFAULT_MAX_WEEKS;

  let firstTimestamp = logs[0].timestamp;
  for (const log of logs) if (log.timestamp < firstTimestamp) firstTimestamp = log.timestamp;
  const firstDay = midnight(firstTimestamp).getTime();
  const today = midnight(now);
  if (firstDay >= today.getTime()) return [];

  // 최근 주부터 거슬러 올라가며 첫 기록일이 든 주까지 구간을 만듭니다. 내부에서는 한 주를 더 계산합니다.
  const ranges: { start: Date; end: Date }[] = [];
  for (let k = 0; ranges.length < limit + 1; k += 1) {
    const start = daysBefore(today, 7 * (k + 1));
    ranges.push({ start, end: daysBefore(today, 7 * k) });
    if (start.getTime() <= firstDay) break;
  }
  ranges.reverse();

  const formulas = logs.filter(log => log.type === 'formula');
  const sleeps = logs.filter(log => log.type === 'sleep');
  const weights = logs
    .filter(log => log.type === 'weight')
    .sort((a, b) => a.timestamp - b.timestamp);

  const computed: WeeklyCard[] = ranges.map(({ start, end }, index) => {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const coveredDays = countDays(start, end, firstDay);
    const inWeek = (timestamp: number) => timestamp >= startMs && timestamp < endMs;
    const weekLogs = logs.filter(log => inWeek(log.timestamp));

    let formulaPerDay: number | null = null;
    let feedsPerDay: number | null = null;
    let sleepHoursPerDay: number | null = null;
    let diapersPerDay: number | null = null;
    if (coveredDays > 0 && weekLogs.length > 0) {
      const weekFormulas = formulas.filter(log => inWeek(log.timestamp));
      const formulaTotal = weekFormulas.reduce((sum, log) => sum + log.amount, 0);
      const diapers = weekLogs.filter(log => log.type === 'urine' || log.type === 'stool').length;
      let sleepMinutes = 0;
      for (const sleep of sleeps) {
        const overlapStart = Math.max(sleep.timestamp, startMs);
        const overlapEnd = Math.min(sleep.endedAt ?? now, endMs);
        sleepMinutes += Math.max(0, Math.floor((overlapEnd - overlapStart) / 60_000));
      }
      formulaPerDay = Math.round(formulaTotal / coveredDays);
      feedsPerDay = roundTo(weekFormulas.length / coveredDays, 1);
      sleepHoursPerDay = roundTo(sleepMinutes / coveredDays / 60, 1);
      diapersPerDay = roundTo(diapers / coveredDays, 1);
    }

    let weightKg: number | null = null;
    let previousWeight: number | null = null;
    for (const weight of weights) {
      if (weight.timestamp < startMs) previousWeight = weight.weightKg;
      else if (weight.timestamp < endMs) weightKg = weight.weightKg;
    }

    return {
      start: startMs,
      end: endMs,
      label: `${formatMonthDay(startMs)} ~ ${formatMonthDay(daysBefore(end, 1).getTime())}`,
      isLatest: index === ranges.length - 1,
      coveredDays,
      formulaPerDay,
      feedsPerDay,
      sleepHoursPerDay,
      diapersPerDay,
      weightKg,
      weightDeltaKg: weightKg !== null && previousWeight !== null ? roundTo(weightKg - previousWeight, 2) : null,
      delta: null,
    };
  });

  const withDelta = computed.map((card, index) => {
    const previous = index > 0 ? computed[index - 1] : null;
    if (!previous || previous.coveredDays === 0 || card.coveredDays === 0) return card;
    return {
      ...card,
      delta: {
        formulaPerDay: diff(card.formulaPerDay, previous.formulaPerDay, 0),
        feedsPerDay: diff(card.feedsPerDay, previous.feedsPerDay, 1),
        sleepHoursPerDay: diff(card.sleepHoursPerDay, previous.sleepHoursPerDay, 1),
        diapersPerDay: diff(card.diapersPerDay, previous.diapersPerDay, 1),
      },
    };
  });

  return withDelta.length > limit ? withDelta.slice(withDelta.length - limit) : withDelta;
}
