export type LogType = 'formula' | 'urine' | 'stool' | 'bath' | 'weight' | 'temperature' | 'sleep' | 'tummyTime' | 'play' | 'diary' | 'diaryComment';

export interface BaseLog {
  id: string;
  type: LogType;
  timestamp: number; // UTC timestamp
  updatedAt?: number; // Last modified timestamp for syncing
  notes?: string;
}

export type MilkTemperature = 'warm' | 'room' | 'cold';
export type FeedingType = 'formula' | 'breast' | 'mixed';

export interface FormulaLog extends BaseLog {
  type: 'formula';
  feedingType?: FeedingType; // default to 'formula'
  amount: number; // in ml (total amount)
  formulaAmount?: number; // for mixed feeding
  breastAmount?: number; // for mixed feeding
  temperature?: MilkTemperature;
}

export type UrineWetness = 'light' | 'medium' | 'heavy';
export type UrineColor = 'clear' | 'normal' | 'dark';

export interface UrineLog extends BaseLog {
  type: 'urine';
  wetness: UrineWetness;
  color: UrineColor;
}

export type StoolColor = 'yellow' | 'green' | 'brown' | 'red' | 'black' | 'grey';
export type StoolConsistency = 'soft' | 'watery' | 'hard';
export type StoolAmount = 'small' | 'medium' | 'large';

export interface StoolLog extends BaseLog {
  type: 'stool';
  color: StoolColor;
  consistency: StoolConsistency;
  amount: StoolAmount;
}

export type BathType = 'full' | 'quick';

export interface BathLog extends BaseLog {
  type: 'bath';
  bathType: BathType;
  durationMinutes: number;
}

export interface WeightLog extends BaseLog {
  type: 'weight';
  weightKg: number;
}

export interface TemperatureLog extends BaseLog {
  type: 'temperature';
  temperatureC: number; // 분유 온도(temperature)와 구분하기 위한 이름
}

export interface SleepLog extends BaseLog {
  type: 'sleep';
  // 종료 전에는 비워 두며, 이 기록이 현재 진행 중인 수면임을 뜻합니다.
  endedAt?: number;
}

export interface TummyTimeLog extends BaseLog {
  type: 'tummyTime';
  // 종료 전에는 비워 두며, 이 기록이 현재 진행 중인 터미타임임을 뜻합니다.
  endedAt?: number;
}

export interface PlayLog extends BaseLog {
  type: 'play';
  // 종료 전에는 비워 두며, 이 기록이 현재 진행 중인 놀기시간임을 뜻합니다.
  endedAt?: number;
}

// ────────────── 한줄 육아일기와 댓글 ──────────────
// 일기와 댓글은 기존 기록 목록(logs)에 새 종류로 함께 담겨 동기화·백업·삭제 표식을 그대로 물려받습니다.
// 본문은 notes 칸에 담아, 이미 설치된 1.8.0 앱에서도 "📝 본문"으로 보이고 멈추지 않습니다.
export type DiaryRole = 'dad' | 'mom';

export interface DiaryLog extends BaseLog {
  type: 'diary';
  diaryDate: string; // 'YYYY-MM-DD', 기기 현지 날짜. 일기가 속한 날의 기준
  authorRole: DiaryRole;
  notes: string; // 본문, 1~200자(코드 포인트 기준)
}

export interface DiaryCommentLog extends BaseLog {
  type: 'diaryComment';
  parentId: string; // 댓글을 단 일기 줄의 id
  diaryDate: string; // 부모 일기의 날짜. 부모를 못 찾아도 날짜로 묶을 수 있게 복사해 둔다
  authorRole: DiaryRole;
  notes: string; // 본문, 1~100자
}

/** 일기와 댓글은 "활동"이 아니므로 활동 타임라인·통계·위젯 계산에서 거를 때 씁니다. */
export const isDiaryType = (type: string): boolean => type === 'diary' || type === 'diaryComment';

export type BabyLogEntry = FormulaLog | UrineLog | StoolLog | BathLog | WeightLog | TemperatureLog | SleepLog | TummyTimeLog | PlayLog | DiaryLog | DiaryCommentLog;

export interface BabyProfile {
  name: string;
  birthDate: string; // YYYY-MM-DD
  birthWeight: string; // in kg, e.g. "3.2"
  targetFormula: number; // in ml, e.g. 800
  syncKey?: string; // Sync group key for real-time sharing
  updatedAt?: number; // Last modified timestamp for syncing
  // 가족이 공유하는 항목(이름·생일·출생체중·목표수유량)이 실제로 바뀐 시각입니다.
  // 알림 설정 같은 내 기기 전용 변경으로는 올라가지 않으므로, 방금 설치한 기기가
  // 기본값으로 가족 프로필을 덮어쓰는 사고를 막습니다.
  sharedUpdatedAt?: number;
  deletedLogIds?: string[]; // Tombstone: 삭제된 로그 ID 추적 (동기화 시 재출현 방지)
  feedingReminderEnabled?: boolean;
  feedingIntervalMinutes?: number;
  nextFeedingAt?: number; // 사용자가 직접 지정한 다음 수유 시각
  nextFeedingForLogId?: string; // 직접 지정 시각의 기준이 된 마지막 수유 기록
  // 이 휴대폰 사용자의 "일기 작성자" 역할입니다. 휴대폰마다 따로 두는 값이라 가족 공유 항목에 넣지 않고 서버에도 올리지 않습니다.
  diaryRole?: DiaryRole;
}
