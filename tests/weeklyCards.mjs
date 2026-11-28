import assert from 'node:assert/strict';
import { buildWeeklyCards } from '../src/utils/weeklyCards.ts';

// 로컬 시간대 기준으로 고정한 현재 시각입니다. 2026-11-27 15:00
const NOW = new Date(2026, 10, 27, 15, 0).getTime();
const at = (month, day, hour = 10, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

let seq = 0;
const id = () => `log-${seq += 1}`;
const formula = (ts, amount = 100) => ({ id: id(), type: 'formula', timestamp: ts, amount });
const urine = ts => ({ id: id(), type: 'urine', timestamp: ts, wetness: 'medium', color: 'normal' });
const stool = ts => ({ id: id(), type: 'stool', timestamp: ts, color: 'yellow', consistency: 'soft', amount: 'medium' });
const sleep = (ts, endedAt) => ({ id: id(), type: 'sleep', timestamp: ts, ...(endedAt === undefined ? {} : { endedAt }) });
const weight = (ts, weightKg) => ({ id: id(), type: 'weight', timestamp: ts, weightKg });
const repeat = (count, make) => Array.from({ length: count }, (_, index) => make(index));

const tests = [];
const test = (name, run) => tests.push([name, run]);

test('1. 빈 기록과 오늘만 있는 기록은 빈 배열입니다', () => {
  assert.deepEqual(buildWeeklyCards([], NOW), []);
  assert.deepEqual(buildWeeklyCards([formula(at(11, 27, 9))], NOW), []);
});

test('2. 최근 주는 어제-6일부터 어제까지이고 오늘 기록은 빠집니다', () => {
  const cards = buildWeeklyCards([formula(at(11, 21), 200), formula(at(11, 27, 9), 999)], NOW);
  assert.equal(cards.length, 1);
  const latest = cards[0];
  assert.equal(latest.start, new Date(2026, 10, 20).getTime());
  assert.equal(latest.end, new Date(2026, 10, 27).getTime());
  assert.equal(latest.label, '11/20 ~ 11/26');
  assert.equal(latest.coveredDays, 6); // 첫 기록일 11/21부터 11/26까지
  assert.equal(latest.formulaPerDay, Math.round(200 / 6));
  assert.equal(latest.feedsPerDay, 0.2);
});

test('3. 오래된 주부터 최근 주 순서이고 마지막만 isLatest입니다', () => {
  const cards = buildWeeklyCards([formula(at(11, 2)), formula(at(11, 10)), formula(at(11, 18)), formula(at(11, 22))], NOW);
  assert.equal(cards.length, 4);
  for (let index = 1; index < cards.length; index += 1) {
    assert.equal(cards[index].start, cards[index - 1].end);
  }
  assert.deepEqual(cards.map(card => card.isLatest), [false, false, false, true]);
  assert.equal(cards[3].label, '11/20 ~ 11/26');
});

test('4. 기록이 20주 전부터 있으면 12장이고 맨 앞 카드에도 delta가 있습니다', () => {
  const today = new Date(2026, 10, 27);
  // k번째 주(0이 최근)의 마지막 날 오전에 기록을 하나씩 둡니다.
  const logs = repeat(20, k => {
    const day = new Date(today);
    day.setDate(day.getDate() - 7 * k - 1);
    day.setHours(10, 0, 0, 0);
    return formula(day.getTime(), 100 + k);
  });
  const cards = buildWeeklyCards(logs, NOW);
  assert.equal(cards.length, 12);
  const expectedFirstStart = new Date(today);
  expectedFirstStart.setDate(expectedFirstStart.getDate() - 7 * 12);
  assert.equal(cards[0].start, expectedFirstStart.getTime());
  assert.notEqual(cards[0].delta, null);
  assert.equal(cards[0].delta.feedsPerDay, 0);
  assert.equal(buildWeeklyCards(logs, NOW, 3).length, 3);
});

test('5. 첫 주 coveredDays는 첫 기록일부터 센 날 수이고 평균이 그 값으로 나뉩니다', () => {
  const only = buildWeeklyCards([formula(at(11, 24), 120), formula(at(11, 25), 60)], NOW);
  assert.equal(only.length, 1);
  assert.equal(only[0].coveredDays, 3);
  assert.equal(only[0].formulaPerDay, 60);
  assert.equal(only[0].feedsPerDay, 0.7);
  assert.equal(only[0].delta, null);

  const several = buildWeeklyCards([formula(at(11, 10, 0, 30)), formula(at(11, 15))], NOW);
  assert.deepEqual(several.map(card => card.coveredDays), [3, 7, 7]);
});

test('6. 수면은 자정을 넘으면 두 주에 나뉘고 진행 중 수면은 오늘 부분이 빠집니다', () => {
  const split = buildWeeklyCards([
    formula(at(11, 13)),
    sleep(at(11, 19, 22), at(11, 20, 6)),
    formula(at(11, 21)),
  ], NOW);
  assert.equal(split.length, 2);
  assert.equal(split[0].sleepHoursPerDay, 0.3); // 2시간 / 7일
  assert.equal(split[1].sleepHoursPerDay, 0.9); // 6시간 / 7일

  const ongoing = buildWeeklyCards([
    formula(at(11, 20)),
    sleep(at(11, 26, 21)), // 진행 중이라 now까지 잡히지만 오늘 부분은 주 구간 밖입니다.
    sleep(at(11, 22, 10), at(11, 22, 9)), // 끝이 시작보다 앞서면 0입니다.
  ], NOW);
  assert.equal(ongoing.length, 1);
  assert.equal(ongoing[0].sleepHoursPerDay, 0.4); // 3시간 / 7일
});

test('7. 증감은 반올림한 값끼리 빼서 다시 반올림합니다', () => {
  const logs = [
    ...repeat(15, index => urine(at(11, 13 + (index % 6), 8 + Math.floor(index / 6)))), // 2.14 에서 2.1
    ...repeat(16, index => stool(at(11, 20 + (index % 6), 8 + Math.floor(index / 6)))), // 2.29 에서 2.3
    ...repeat(14, index => formula(at(11, 13 + (index % 6), 8 + Math.floor(index / 6)), 100)),
    ...repeat(14, index => formula(at(11, 20 + (index % 6), 8 + Math.floor(index / 6)), 120)),
  ];
  const cards = buildWeeklyCards(logs, NOW);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].diapersPerDay, 2.1);
  assert.equal(cards[1].diapersPerDay, 2.3);
  assert.equal(cards[0].delta, null);
  assert.equal(cards[1].delta.diapersPerDay, 0.2);
  assert.equal(cards[1].delta.formulaPerDay, cards[1].formulaPerDay - cards[0].formulaPerDay);
  assert.equal(cards[1].delta.feedsPerDay, 0);
  assert.ok(Object.is(cards[1].delta.feedsPerDay, 0));
});

test('8. 기록이 0건인 주는 평균이 null이고 맞닿은 증감도 null입니다', () => {
  const cards = buildWeeklyCards([formula(at(11, 7)), formula(at(11, 22))], NOW);
  assert.equal(cards.length, 3);
  const [first, gap, last] = cards;
  assert.equal(first.formulaPerDay === null, false);
  assert.equal(gap.coveredDays, 7);
  for (const key of ['formulaPerDay', 'feedsPerDay', 'sleepHoursPerDay', 'diapersPerDay']) {
    assert.equal(gap[key], null);
    assert.equal(gap.delta[key], null);
    assert.equal(last.delta[key], null);
  }
  assert.notEqual(last.formulaPerDay, null);
});

test('9. 체중은 주에 잰 마지막 값이고 이전 측정 대비 증감은 소수 2자리입니다', () => {
  const logs = [weight(at(11, 2), 3.5), weight(at(11, 16), 4.0), weight(at(11, 18), 4.1)];
  const cards = buildWeeklyCards(logs, NOW);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(card => card.weightKg), [3.5, null, 4.1, null]);
  assert.deepEqual(cards.map(card => card.weightDeltaKg), [null, null, 0.6, null]);
  // 목록 상한으로 앞 주가 잘려도 증감은 전체 기록 기준입니다.
  const trimmed = buildWeeklyCards(logs, NOW, 2);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].weightDeltaKg, 0.6);
});

test('10. 수유 없이 기저귀나 수면만 기록한 주도 평균을 냅니다', () => {
  const cards = buildWeeklyCards([formula(at(11, 7)), urine(at(11, 14)), sleep(at(11, 21, 1), at(11, 21, 4))], NOW);
  assert.equal(cards.length, 3);
  const [, diaperOnly, sleepOnly] = cards;
  assert.equal(diaperOnly.formulaPerDay, 0);
  assert.equal(diaperOnly.diapersPerDay, 0.1);
  assert.equal(sleepOnly.formulaPerDay, 0);
  assert.equal(sleepOnly.sleepHoursPerDay, 0.4); // 3시간 / 7일
});

test('11. 순서가 뒤섞인 체중도 그 주의 마지막 값을 쓰고 증감은 양쪽이 대칭입니다', () => {
  const cards = buildWeeklyCards([weight(at(11, 25), 4.0), weight(at(11, 18), 4.125), weight(at(11, 24), 4.125), weight(at(11, 23), 3.9)], NOW);
  // 11/20~11/26 주에는 11/23(3.9), 11/24(4.125), 11/25(4.0)이 있어 마지막은 4.0입니다.
  assert.equal(cards[cards.length - 1].weightKg, 4.0);
  const down = buildWeeklyCards([weight(at(11, 10), 4.125), weight(at(11, 22), 4.0)], NOW);
  const up = buildWeeklyCards([weight(at(11, 10), 4.0), weight(at(11, 22), 4.125)], NOW);
  assert.equal(down[down.length - 1].weightDeltaKg, -0.13);
  assert.equal(up[up.length - 1].weightDeltaKg, 0.13);
});

test('12. 시각이 깨진 기록과 잘못된 상한은 결과를 망가뜨리지 않습니다', () => {
  const good = [formula(at(11, 10)), formula(at(11, 22))];
  const broken = [{ ...formula(at(11, 1)), timestamp: Number.NaN }, ...good];
  assert.deepEqual(buildWeeklyCards(broken, NOW).map(card => card.coveredDays), buildWeeklyCards(good, NOW).map(card => card.coveredDays));
  assert.equal(buildWeeklyCards(good, NOW, Number.NaN).length, buildWeeklyCards(good, NOW).length);
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(error);
  }
}
console.log(failed === 0 ? `\n${tests.length}개 통과` : `\n${failed}개 실패`);
if (failed > 0) process.exitCode = 1;
