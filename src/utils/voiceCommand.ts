export type VoiceCommand =
  | { kind: 'formula'; amount: number }
  | { kind: 'sleepStart' }
  | { kind: 'sleepEnd' }
  | { kind: 'unknown' };

export const parseVoiceCommand = (transcript: string): VoiceCommand => {
  const text = transcript.toLowerCase().replace(/[,，.。]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:아기(?:가)?\s*)?(?:지금\s*)?(?:깼어|깨어났어|일어났어|잠에서\s*깼어)(?:요)?$/.test(text)) {
    return { kind: 'sleepEnd' };
  }
  if (/^(?:아기(?:가)?\s*)?(?:지금\s*)?(?:자|잔다|잠들었어|잠자기\s*시작)(?:요)?$/.test(text)) {
    return { kind: 'sleepStart' };
  }
  if (!/분유/.test(text) || !/(?:먹었|먹였|마셨|수유|먹음)/.test(text)) return { kind: 'unknown' };
  const amounts = [...text.matchAll(/(\d{1,4})\s*(?:ml|mL|밀리리터|미리|밀리)?/g)];
  if (amounts.length !== 1) return { kind: 'unknown' };
  const amount = Number(amounts[0][1]);
  return Number.isInteger(amount) && amount >= 10 && amount <= 500
    ? { kind: 'formula', amount }
    : { kind: 'unknown' };
};
