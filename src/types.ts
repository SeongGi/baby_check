export type LogType = 'formula' | 'urine' | 'stool' | 'bath' | 'weight' | 'sleep' | 'tummyTime' | 'play';

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

export type BabyLogEntry = FormulaLog | UrineLog | StoolLog | BathLog | WeightLog | SleepLog | TummyTimeLog | PlayLog;

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
}
