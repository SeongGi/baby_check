/** 알림 대상 기록 종류 9종. diary, diaryComment는 대상이 아니다. */
export const PUSH_TYPES = [
  'formula',
  'urine',
  'stool',
  'bath',
  'weight',
  'temperature',
  'sleep',
  'tummyTime',
  'play',
] as const;
export type PushType = (typeof PUSH_TYPES)[number];

const MAX_TOKEN_LENGTH = 200;

/** 등록 본문 검증 결과. types가 비면 등록하지 않고 해제와 같게 처리한다. */
export interface PushRegistration {
  token: string;
  types: PushType[];
  quietStart: number | null;
  quietEnd: number | null;
  tzOffsetMinutes: number;
}

const isMinuteOfDay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439;

/** 2.2의 검증 규칙. 토큰이 잘못되면 null을 돌려주고 호출한 쪽이 400 invalid_push_token으로 답한다. */
export function parsePushRegistration(body: any): PushRegistration | null {
  const token = body?.token;
  if (
    typeof token !== 'string' ||
    token.length > MAX_TOKEN_LENGTH ||
    !(token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['))
  ) {
    return null;
  }
  const rawTypes: unknown[] = Array.isArray(body.types) ? body.types : [];
  const types = PUSH_TYPES.filter(type => rawTypes.includes(type));
  const quietOk =
    isMinuteOfDay(body.quietStart) && isMinuteOfDay(body.quietEnd) && body.quietStart !== body.quietEnd;
  const tz = body.tzOffsetMinutes;
  const tzOk = typeof tz === 'number' && Number.isInteger(tz) && tz >= -840 && tz <= 840;
  return {
    token,
    types,
    quietStart: quietOk ? body.quietStart : null,
    quietEnd: quietOk ? body.quietEnd : null,
    tzOffsetMinutes: tzOk ? tz : 540,
  };
}
