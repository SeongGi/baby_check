export type LogType = 'formula' | 'urine' | 'stool';

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

export type BabyLogEntry = FormulaLog | UrineLog | StoolLog;

export interface BabyProfile {
  name: string;
  birthDate: string; // YYYY-MM-DD
  birthWeight: string; // in kg, e.g. "3.2"
  targetFormula: number; // in ml, e.g. 800
  syncKey?: string; // Sync group key for 부부 공유
  updatedAt?: number; // Last modified timestamp for syncing
  deletedLogIds?: string[]; // Tombstone: 삭제된 로그 ID 추적 (동기화 시 재출현 방지)
}

