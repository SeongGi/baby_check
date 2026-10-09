import type { BathType, MilkTemperature, StoolAmount, StoolColor, StoolConsistency, UrineColor, UrineWetness } from '../types';

export type TimedVoiceType = 'sleep' | 'tummyTime' | 'play';
export type VoiceCommand =
  | { kind: 'formula'; amount: number; feedingType?: 'formula' | 'breast' | 'mixed'; formulaAmount?: number; breastAmount?: number; temperature?: MilkTemperature }
  | { kind: 'urine'; wetness?: UrineWetness; color?: UrineColor }
  | { kind: 'stool'; color?: StoolColor; consistency?: StoolConsistency; amount?: StoolAmount }
  | { kind: 'bath'; bathType: BathType; durationMinutes?: number }
  | { kind: 'weight'; weightKg: number }
  | { kind: 'sleepStart' | 'sleepEnd' | 'tummyStart' | 'tummyEnd' | 'playStart' | 'playEnd' }
  | { kind: 'unknown' };

const pick = <T extends string>(text: string, options: [RegExp, T][]): T | undefined =>
  options.find(([pattern]) => pattern.test(text))?.[1];
const validMilk = (amount: number) => Number.isInteger(amount) && amount >= 10 && amount <= 500;

export const parseVoiceCommand = (transcript: string): VoiceCommand => {
  const text = transcript.toLowerCase().replace(/[,，。]|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim().replace(/요$/, '');
  if (!text || /[?？]|(?:안|못)\s*(?:먹|했|봤|갈|잤|잠|놀|씻)|하지\s*않|아니/.test(text)) return { kind: 'unknown' };
  const groups = [
    /분유|모유|수유/.test(text), /소변|오줌|쉬야/.test(text), /대변|응가|똥/.test(text),
    /목욕|씻기|씻겼/.test(text), /몸무게|체중/.test(text), /터미타임|엎드려\s*놀/.test(text),
    /놀기|놀이|놀았|놀고|놀아/.test(text) && !/엎드려\s*놀/.test(text), /잠|수면|깼|일어났|(?:^|\s)자(?:요|$)/.test(text),
  ];
  if (groups.filter(Boolean).length > 1) return { kind: 'unknown' };

  if (groups[7]) {
    if (/^(?:아기(?:가)?\s*)?(?:지금\s*)?(?:깼어|깨어났어|일어났어|잠에서\s*깼어|수면\s*(?:끝|종료))(?:요)?$/.test(text)) return { kind: 'sleepEnd' };
    if (/^(?:아기(?:가)?\s*)?(?:지금\s*)?(?:자|잔다|잠들었어|잠자기\s*시작|수면\s*시작)(?:요)?$/.test(text)) return { kind: 'sleepStart' };
    return { kind: 'unknown' };
  }
  if (groups[5] || groups[6]) {
    if (!/^(?:(?:지금|아기(?:가)?)\s*)?(?:터미타임|엎드려\s*놀기|놀기|놀이)\s*(?:시작|끝|종료|그만)(?:해|했어|해요|요)?$/.test(text)) return { kind: 'unknown' };
    const end = /끝|종료|그만/.test(text);
    return { kind: groups[5] ? (end ? 'tummyEnd' : 'tummyStart') : (end ? 'playEnd' : 'playStart') };
  }
  if (groups[4]) {
    if (!/^(?:지금\s*)?(?:아기\s*)?(?:몸무게|체중)\s*\d{1,2}(?:\.\d{1,2})?\s*(?:kg|킬로그램|킬로)\s*(?:기록|재었어|쟀어|야|이에요)?$/.test(text)) return { kind: 'unknown' };
    const weightKg = Number(/\d{1,2}(?:\.\d{1,2})?/.exec(text)?.[0]);
    return weightKg >= 0.5 && weightKg <= 100 ? { kind: 'weight', weightKg } : { kind: 'unknown' };
  }
  if (groups[3]) {
    if (!/^(?:지금\s*)?(?:아기\s*)?(?:(?:간단|부분)\s*)?(?:목욕|씻기|씻겼어)(?:\s*\d{1,3}\s*분)?\s*(?:했어|기록|끝|완료)?$/.test(text)) return { kind: 'unknown' };
    const durationText = /(\d{1,3})\s*분/.exec(text)?.[1];
    const durationMinutes = durationText === undefined ? undefined : Number(durationText);
    return durationMinutes === undefined || (durationMinutes >= 1 && durationMinutes <= 120)
      ? { kind: 'bath', bathType: /간단|부분/.test(text) ? 'quick' : 'full', durationMinutes }
      : { kind: 'unknown' };
  }
  if (groups[2]) {
    if (!/(?:봤어|눴어|기록|갈았어|교체했어)$/.test(text) || /\d/.test(text)) return { kind: 'unknown' };
    return {
      kind: 'stool',
      color: pick<StoolColor>(text, [[/빨강|빨간|붉은|혈변/, 'red'], [/검정|검은|흑변/, 'black'], [/회색|흰색|하얀/, 'grey'], [/초록|녹색|연두/, 'green'], [/갈색/, 'brown'], [/노랑|노란|황금/, 'yellow']]),
      consistency: pick<StoolConsistency>(text, [[/묽|설사/, 'watery'], [/단단|딱딱/, 'hard'], [/형태\s*보통|부드러/, 'soft']]),
      amount: pick<StoolAmount>(text, [[/많이|많은/, 'large'], [/조금|적게|적은/, 'small'], [/양\s*보통|양\s*중간/, 'medium']]),
    };
  }
  if (groups[1]) {
    if (!/(?:봤어|눴어|기록|갈았어|교체했어)$/.test(text) || /\d/.test(text)) return { kind: 'unknown' };
    return {
      kind: 'urine',
      wetness: pick<UrineWetness>(text, [[/많이|많은|흠뻑/, 'heavy'], [/조금|적게|적은/, 'light'], [/젖은\s*정도\s*보통/, 'medium']]),
      color: pick<UrineColor>(text, [[/진한|어두운|짙은/, 'dark'], [/맑은|투명/, 'clear'], [/색\s*보통/, 'normal']]),
    };
  }
  if (groups[0]) {
    if (!/(?:먹었어|먹였어|마셨어|수유|먹음|기록)$/.test(text)) return { kind: 'unknown' };
    const formula = /분유\s*(\d{1,4})\s*(?:ml|밀리리터|미리)/.exec(text);
    const breast = /모유\s*(\d{1,4})\s*(?:ml|밀리리터|미리)/.exec(text);
    const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)];
    const temperature: MilkTemperature | undefined = /따뜻|데운/.test(text) ? 'warm' : /실온/.test(text) ? 'room' : /차가|찬/.test(text) ? 'cold' : undefined;
    if (/분유/.test(text) && /모유/.test(text)) {
      if (!formula || !breast || numbers.length !== 2) return { kind: 'unknown' };
      const formulaAmount = Number(formula[1]);
      const breastAmount = Number(breast[1]);
      const amount = formulaAmount + breastAmount;
      return validMilk(amount) && formulaAmount > 0 && breastAmount > 0
        ? { kind: 'formula', feedingType: 'mixed', amount, formulaAmount, breastAmount, temperature }
        : { kind: 'unknown' };
    }
    if (numbers.length !== 1 || !(formula || breast)) return { kind: 'unknown' };
    const amount = Number(numbers[0][0]);
    const feedingType = /모유/.test(text) ? 'breast' : 'formula';
    return validMilk(amount) ? { kind: 'formula', feedingType, amount, temperature: feedingType === 'breast' ? undefined : temperature } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
};
