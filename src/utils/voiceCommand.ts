import type { BathType, MilkTemperature, StoolAmount, StoolColor, StoolConsistency, UrineColor, UrineWetness } from '../types';

export type TimedVoiceType = 'sleep' | 'tummyTime' | 'play';
export type VoiceCommand =
  | { kind: 'formula'; amount: number; feedingType?: 'formula' | 'breast' | 'mixed'; formulaAmount?: number; breastAmount?: number; temperature?: MilkTemperature }
  | { kind: 'urine'; wetness: UrineWetness; color: UrineColor }
  | { kind: 'stool'; color: StoolColor; consistency: StoolConsistency; amount: StoolAmount }
  | { kind: 'bath'; bathType: BathType; durationMinutes: number }
  | { kind: 'weight'; weightKg: number }
  | { kind: 'sleepStart' | 'sleepEnd' | 'tummyStart' | 'tummyEnd' | 'playStart' | 'playEnd' }
  | { kind: 'unknown' };

const pick = <T extends string>(text: string, options: [RegExp, T][]): T | undefined =>
  options.find(([pattern]) => pattern.test(text))?.[1];
const validMilk = (amount: number) => Number.isInteger(amount) && amount >= 10 && amount <= 500;

export const parseVoiceCommand = (transcript: string): VoiceCommand => {
  const raw = transcript.trim().toLowerCase();
  if (!raw || /[?？]|(?:안|못)\s*(?:먹|했|봤|갈|잤|잠|자|놀|씻)|하지\s*않|아니|인가|인가요/.test(raw)) return { kind: 'unknown' };

  // Normalize punctuation and trailing polite ending
  const text = raw
    .replace(/[,，。!！?？~～]|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:했)?(?:어요|아요|에요|예요|요)$/, '');

  if (!text) return { kind: 'unknown' };

  const groups = [
    /분유|모유|수유|맘마|우유|유축/.test(text),
    /소변|오줌|쉬야|(?:^|\s)쉬(?:\s|$|했|함)|기저귀\s*갈/.test(text) && !/대변|응가|똥/.test(text),
    /대변|응가|똥/.test(text),
    /목욕|씻기|씻겼|씻음|목욕함/.test(text),
    /몸무게|체중/.test(text),
    /터미타임|엎드려\s*놀/.test(text),
    /놀기|놀이|놀았|놀고|놀아/.test(text) && !/엎드려\s*놀/.test(text),
    /잠|수면|깼|일어났|일어남|기상|잔다|(?:^|\s)자(?:요|$|ㅁ)|재웠|낮잠|밤잠/.test(text),
  ];

  if (groups.filter(Boolean).length > 1) return { kind: 'unknown' };

  // 1. 수면
  if (groups[7]) {
    if (/깼|일어났|일어남|기상|수면\s*(?:끝|종료)|낮잠\s*(?:끝|종료)|밤잠\s*(?:끝|종료)/.test(text)) {
      return { kind: 'sleepEnd' };
    }
    if (/(?:^|\s)자(?:다|ㅁ|기)?|잔다|잠들|잠자기|수면\s*시작|낮잠\s*시작|밤잠\s*시작|재웠/.test(text)) {
      return { kind: 'sleepStart' };
    }
    return { kind: 'unknown' };
  }

  // 2. 터미타임 & 놀기
  if (groups[5] || groups[6]) {
    const isEnd = /끝|종료|그만|마침/.test(text);
    const isStart = /시작|출발|해|했|함|하자/.test(text) || (!isEnd && (groups[5] ? /^터미타임$/.test(text) : /^놀기|^놀이$/.test(text)));
    if (!isEnd && !isStart) return { kind: 'unknown' };
    return { kind: groups[5] ? (isEnd ? 'tummyEnd' : 'tummyStart') : (isEnd ? 'playEnd' : 'playStart') };
  }

  // 3. 체중
  if (groups[4]) {
    const numMatch = /\d{1,2}(?:\.\d{1,2})?/.exec(text);
    if (!numMatch) return { kind: 'unknown' };
    const weightKg = Number(numMatch[0]);
    return weightKg >= 0.5 && weightKg <= 100 ? { kind: 'weight', weightKg } : { kind: 'unknown' };
  }

  // 4. 목욕 (기본 시간: 10분)
  if (groups[3]) {
    const durationText = /(\d{1,3})\s*(?:분|min)/.exec(text)?.[1];
    const durationMinutes = durationText !== undefined ? Number(durationText) : 10;
    if (durationMinutes < 1 || durationMinutes > 120) return { kind: 'unknown' };
    const bathType: BathType = /간단|부분/.test(text) ? 'quick' : 'full';
    return { kind: 'bath', bathType, durationMinutes };
  }

  // 5. 대변 (수동 입력 화면과 동일한 기본값: yellow / soft / medium)
  if (groups[2]) {
    if (/\d/.test(text)) return { kind: 'unknown' };
    const color = pick<StoolColor>(text, [
      [/빨강|빨간|붉은|혈변/, 'red'],
      [/검정|검은|흑변/, 'black'],
      [/회색|흰색|하얀/, 'grey'],
      [/초록|녹색|연두/, 'green'],
      [/갈색/, 'brown'],
      [/노랑|노란|황금/, 'yellow'],
    ]) ?? 'yellow';

    const consistency = pick<StoolConsistency>(text, [
      [/묽|설사/, 'watery'],
      [/단단|딱딱|변비/, 'hard'],
      [/형태\s*보통|부드러|보통/, 'soft'],
    ]) ?? 'soft';

    const amount = pick<StoolAmount>(text, [
      [/많이|많은|많음/, 'large'],
      [/조금|적게|적은|적음/, 'small'],
      [/양\s*보통|양\s*중간|보통/, 'medium'],
    ]) ?? 'medium';

    return { kind: 'stool', color, consistency, amount };
  }

  // 6. 소변 (수동 입력 화면과 동일한 기본값: medium / normal)
  if (groups[1]) {
    if (/\d/.test(text)) return { kind: 'unknown' };
    const wetness = pick<UrineWetness>(text, [
      [/많이|많은|흠뻑|많음/, 'heavy'],
      [/조금|적게|적은|적음/, 'light'],
      [/젖은\s*정도\s*보통|보통/, 'medium'],
    ]) ?? 'medium';

    const color = pick<UrineColor>(text, [
      [/진한|어두운|짙은/, 'dark'],
      [/맑은|투명/, 'clear'],
      [/색\s*보통|보통/, 'normal'],
    ]) ?? 'normal';

    return { kind: 'urine', wetness, color };
  }

  // 7. 수유 (분유/모유/맘마/우유)
  if (groups[0]) {
    const formulaMatch = /(?:분유|맘마|우유)\s*(\d{1,4})(?:\s*(?:ml|밀리리터|미리))?/.exec(text);
    const breastMatch = /(?:모유|유축)\s*(\d{1,4})(?:\s*(?:ml|밀리리터|미리))?/.exec(text);
    const genericMatch = /수유\s*(\d{1,4})(?:\s*(?:ml|밀리리터|미리))?/.exec(text)
      || /(\d{1,4})(?:\s*(?:ml|밀리리터|미리))?\s*(?:먹었|먹였|마셨|수유|먹음|완료)/.exec(text)
      || /(\d{1,4})\s*(?:ml|밀리리터|미리)/.exec(text);

    const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)];
    const temperature: MilkTemperature | undefined = /따뜻|데운/.test(text)
      ? 'warm'
      : /실온/.test(text)
      ? 'room'
      : /차가|찬/.test(text)
      ? 'cold'
      : undefined;

    // 혼합 수유 (분유 + 모유)
    if (formulaMatch && breastMatch && numbers.length === 2) {
      const formulaAmount = Number(formulaMatch[1]);
      const breastAmount = Number(breastMatch[1]);
      const amount = formulaAmount + breastAmount;
      return validMilk(amount) && formulaAmount > 0 && breastAmount > 0
        ? { kind: 'formula', feedingType: 'mixed', amount, formulaAmount, breastAmount, temperature }
        : { kind: 'unknown' };
    }

    if (numbers.length === 1) {
      const amount = Number(numbers[0][0]);
      if (!validMilk(amount)) return { kind: 'unknown' };
      const feedingType = /모유|유축/.test(text) ? 'breast' : 'formula';
      return {
        kind: 'formula',
        feedingType,
        amount,
        temperature: feedingType === 'breast' ? undefined : temperature,
      };
    }

    return { kind: 'unknown' };
  }

  return { kind: 'unknown' };
};
