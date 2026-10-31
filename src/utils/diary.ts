// 한줄 육아일기와 댓글의 순수 함수 모음입니다. 저장소·네트워크·React를 부르지 않아
// 저장 함수(storage.ts), 화면, 하네스 시험이 같은 규칙을 그대로 씁니다.
import { DiaryCommentLog, DiaryLog, DiaryRole, isDiaryType } from '../types';
import { compareCodePoints } from './compareCodePoints';

export const DIARY_MAX_LENGTH = 200;
export const DIARY_COMMENT_MAX_LENGTH = 100;
export const DIARY_ROLES: DiaryRole[] = ['dad', 'mom'];

export const DIARY_ROLE_LABEL: Record<DiaryRole, string> = { dad: '아빠', mom: '엄마' };
export const DIARY_ROLE_EMOJI: Record<DiaryRole, string> = { dad: '👨', mom: '👩' };

const DIARY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ────────────── 글자 수 ──────────────

/** 코드 포인트 기준 글자 수. 한글과 이모지가 모두 한 글자로 세어집니다. */
export const countCodePoints = (text: string): number => Array.from(text).length;

/** 코드 포인트 기준으로 최대 글자 수까지만 남깁니다(입력 중 자르기). */
export const clampCodePoints = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

// ────────────── 날짜 ──────────────

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value));

/** 기기 현지 시각 기준 'YYYY-MM-DD'. */
export const toDiaryDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

export const isValidDiaryDate = (value: unknown): value is string =>
  typeof value === 'string' && DIARY_DATE_PATTERN.test(value);

/** 'YYYY-MM-DD'를 현지 시각 정오의 Date로 바꿉니다(서머타임 경계에서 날짜가 밀리지 않게 정오를 씁니다). */
const parseDiaryDate = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
};

/** 날짜를 하루 단위로 옮깁니다. */
export const shiftDiaryDate = (date: string, days: number): string => {
  const moved = parseDiaryDate(date);
  moved.setDate(moved.getDate() + days);
  return toDiaryDate(moved.getTime());
};

/** 예: '11월 1일 (일)'. */
export const formatDiaryDateLabel = (date: string): string => {
  const parsed = parseDiaryDate(date);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][parsed.getDay()];
  return `${parsed.getMonth() + 1}월 ${parsed.getDate()}일 (${weekday})`;
};

/**
 * 고를 수 있는 날짜의 범위. 위쪽은 오늘, 아래쪽은 아기 생일입니다.
 * 생일이 형식에 맞지 않거나 오늘보다 뒤면 아래쪽 한계를 두지 않고, 오늘은 항상 고를 수 있습니다.
 */
export const diaryDateBounds = (birthDate: string | undefined, now: number): { min: string | null; max: string } => {
  const max = toDiaryDate(now);
  if (!isValidDiaryDate(birthDate) || birthDate > max) return { min: null, max };
  return { min: birthDate, max };
};

/**
 * 일기의 timestamp. 오늘 쓰면 저장한 시각, 지난 날짜에 쓰면 그날 21:00(현지)입니다.
 * 1.8.0 타임라인에서 카드가 놓일 자리와 정렬에만 쓰이며, 새 앱은 날짜를 diaryDate로만 판단합니다.
 */
export const diaryTimestampFor = (diaryDate: string, now: number): number => {
  if (diaryDate === toDiaryDate(now)) return now;
  const [year, month, day] = diaryDate.split('-').map(Number);
  return new Date(year, month - 1, day, 21, 0, 0, 0).getTime();
};

// ────────────── id ──────────────

/**
 * 일기 id: diary_<YYYYMMDD>_<role>_<무작위>. 날짜와 역할은 사람이 읽기 쉽게 붙일 뿐이며
 * 코드는 id에서 날짜나 역할을 읽지 않습니다. 무작위 부분은 addLog와 같은 방식입니다.
 */
export const makeDiaryId = (
  diaryDate: string,
  role: DiaryRole,
  now: number = Date.now(),
  random: () => number = Math.random,
): string =>
  `diary_${diaryDate.replace(/-/g, '')}_${role}_${random().toString(36).substring(2, 9)}${now.toString(36)}`;

// ────────────── 형식 검사 ──────────────
// 동기화로 깨진 값이 내려와도 새 화면이 멈추지 않도록, 검사를 통과한 기록만 다룹니다.
// 통과하지 못한 기록은 지우지 않고 무시합니다.

const isRole = (value: unknown): value is DiaryRole => value === 'dad' || value === 'mom';

const hasBaseShape = (log: unknown): log is Record<string, unknown> =>
  !!log && typeof log === 'object'
  && typeof (log as { id?: unknown }).id === 'string'
  && typeof (log as { timestamp?: unknown }).timestamp === 'number';

export const isDiaryLog = (log: unknown): log is DiaryLog =>
  hasBaseShape(log)
  && log.type === 'diary'
  && isValidDiaryDate(log.diaryDate)
  && isRole(log.authorRole)
  && (log.notes === undefined || typeof log.notes === 'string');

export const isDiaryComment = (log: unknown): log is DiaryCommentLog =>
  hasBaseShape(log)
  && log.type === 'diaryComment'
  && typeof log.parentId === 'string'
  && isValidDiaryDate(log.diaryDate)
  && isRole(log.authorRole)
  && (log.notes === undefined || typeof log.notes === 'string');

/** 본문. notes가 없는 줄은 빈 본문으로 봅니다. */
export const diaryText = (log: { notes?: unknown }): string =>
  typeof log.notes === 'string' ? log.notes : '';

const isEmptyText = (log: { notes?: unknown }): boolean => diaryText(log).trim() === '';

// ────────────── 한 줄 고르기 ──────────────

const stampOf = (log: { updatedAt?: number; timestamp: number }): number =>
  log.updatedAt || log.timestamp || 0;

/** 최근에 고친 줄이 앞에 오도록 비교합니다. 같으면 id를 코드 포인트 순서로 비교해 큰 쪽이 앞입니다. */
const compareLinesBestFirst = (a: DiaryLog, b: DiaryLog): number => {
  const diff = stampOf(b) - stampOf(a);
  if (diff !== 0) return diff;
  return compareCodePoints(b.id, a.id);
};

/**
 * 같은 diaryDate와 authorRole을 가진 일기를 한 묶음으로 보고, 고르는 순서(가장 앞이 보이는 줄)대로 돌려줍니다.
 * 본문이 빈 줄도 포함합니다.
 */
export const diaryGroupLines = (logs: readonly unknown[], diaryDate: string, role: DiaryRole): DiaryLog[] =>
  logs
    .filter((log): log is DiaryLog => isDiaryLog(log) && log.diaryDate === diaryDate && log.authorRole === role)
    .sort(compareLinesBestFirst);

/**
 * 묶음에서 줄 하나를 고릅니다. 모든 기기가 같은 줄을 고릅니다.
 * includeEmpty가 참이면 본문이 빈 줄도 후보이며 그대로 돌려줍니다(저장할 때 쓰는 규칙).
 * 거짓이면 고른 줄의 본문이 비어 있을 때 "아직 안 씀"으로 보고 null을 돌려줍니다(화면에 보여 줄 때 쓰는 규칙).
 */
export const pickDiaryLine = (
  logs: readonly unknown[],
  diaryDate: string,
  role: DiaryRole,
  options: { includeEmpty?: boolean } = {},
): DiaryLog | null => {
  const picked = diaryGroupLines(logs, diaryDate, role)[0] ?? null;
  if (!picked) return null;
  if (!options.includeEmpty && isEmptyText(picked)) return null;
  return picked;
};

// ────────────── 날짜별 묶기 ──────────────

export interface DiaryRoleEntry {
  role: DiaryRole;
  /** 보이는 줄 */
  line: DiaryLog;
  /** 같은 날짜·역할의 숨은 줄(본문이 빈 줄은 뺍니다) */
  hidden: DiaryLog[];
  /** 같은 묶음의 모든 줄 id에 달린 댓글. 오래된 것부터 */
  comments: DiaryCommentLog[];
}

export interface DiaryDayGroup {
  date: string;
  /** 아빠, 엄마 순서. 아직 안 쓴 역할은 들어 있지 않습니다. */
  entries: DiaryRoleEntry[];
}

/** 일기 줄이 있는 날짜를 최근 날짜부터 묶습니다. 보이는 줄이 하나도 없는 날짜는 넣지 않습니다. */
export const groupDiaryByDate = (logs: readonly unknown[]): DiaryDayGroup[] => {
  const diaries: DiaryLog[] = [];
  const comments: DiaryCommentLog[] = [];
  for (const log of logs) {
    if (isDiaryLog(log)) diaries.push(log);
    else if (isDiaryComment(log)) comments.push(log);
  }
  const commentsByParent = new Map<string, DiaryCommentLog[]>();
  for (const comment of comments) {
    const list = commentsByParent.get(comment.parentId);
    if (list) list.push(comment);
    else commentsByParent.set(comment.parentId, [comment]);
  }

  const buckets = new Map<string, DiaryLog[]>();
  for (const diary of diaries) {
    const key = `${diary.diaryDate}|${diary.authorRole}`;
    const list = buckets.get(key);
    if (list) list.push(diary);
    else buckets.set(key, [diary]);
  }

  const days = new Map<string, DiaryRoleEntry[]>();
  buckets.forEach(lines => {
    lines.sort(compareLinesBestFirst);
    const [line, ...rest] = lines;
    if (isEmptyText(line)) return;
    const merged: DiaryCommentLog[] = [];
    for (const member of lines) merged.push(...(commentsByParent.get(member.id) ?? []));
    merged.sort((a, b) => a.timestamp - b.timestamp || compareCodePoints(a.id, b.id));
    const entry: DiaryRoleEntry = {
      role: line.authorRole,
      line,
      hidden: rest.filter(item => !isEmptyText(item)),
      comments: merged,
    };
    const list = days.get(line.diaryDate);
    if (list) list.push(entry);
    else days.set(line.diaryDate, [entry]);
  });

  return Array.from(days.entries())
    .map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => DIARY_ROLES.indexOf(a.role) - DIARY_ROLES.indexOf(b.role)),
    }))
    .sort((a, b) => compareCodePoints(b.date, a.date));
};

// ────────────── 거르기 ──────────────

/**
 * 활동 타임라인·통계·위젯 상태처럼 "활동"만 다루는 곳에서 일기와 댓글을 뺍니다.
 * 원본 배열은 바꾸지 않고, 일기와 댓글은 지우지 않습니다(화면에서만 거릅니다).
 */
export const withoutDiaryLogs = <T extends { type: string }>(logs: readonly T[]): T[] =>
  logs.filter(log => !isDiaryType(log.type));
