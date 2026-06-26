export type LogType = 'formula' | 'urine' | 'stool';

export interface BaseLog {
  id: string;
  type: LogType;
  timestamp: number; // UTC timestamp
  notes?: string;
}

export type MilkTemperature = 'warm' | 'room' | 'cold';

export interface FormulaLog extends BaseLog {
  type: 'formula';
  amount: number; // in ml
  temperature: MilkTemperature;
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
}
