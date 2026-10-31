import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { BabyLogEntry, BabyProfile, DiaryCommentLog, DiaryRole } from '../types';
import { DiaryEditor } from '../components/DiaryEditor';
import {
  DIARY_COMMENT_MAX_LENGTH,
  DIARY_MAX_LENGTH,
  DIARY_ROLE_EMOJI,
  DIARY_ROLE_LABEL,
  DiaryDayGroup,
  DiaryRoleEntry,
  diaryDateBounds,
  diaryText,
  formatDiaryDateLabel,
  groupDiaryByDate,
  pickDiaryLine,
  shiftDiaryDate,
  toDiaryDate,
} from '../utils/diary';

// 기록 화면이 수천 건을 한 번에 그리지 않도록 처음 30일치만 그리고 "이전 일기 더 보기"로 늘립니다.
const DAYS_PER_PAGE = 30;

interface DiaryProps {
  logs: BabyLogEntry[];
  profile: BabyProfile;
  onSaveDiaryLine: (date: string, text: string, targetId: string | null) => Promise<boolean>;
  onDeleteDiaryGroup: (date: string) => Promise<boolean>;
  /** 댓글 추가: 기존 기록 추가 함수를 넘겨받음 */
  onAddLog: (log: Omit<BabyLogEntry, 'id'>) => Promise<unknown>;
  /** 댓글 삭제: 성공하면 true, 실패하면 false(화면이 실패 안내를 띄움) */
  onDeleteComment: (id: string) => Promise<boolean>;
  onNavigate: (screen: 'dashboard' | 'profile') => void;
}

type EditorState =
  | { kind: 'diary'; date: string; targetId: string | null; initialText: string }
  | { kind: 'comment'; date: string; parentId: string };

export const Diary: React.FC<DiaryProps> = ({
  logs,
  profile,
  onSaveDiaryLine,
  onDeleteDiaryGroup,
  onAddLog,
  onDeleteComment,
  onNavigate,
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const today = toDiaryDate(now);
  const yesterday = shiftDiaryDate(today, -1);
  const myRole = profile.diaryRole;

  const [visibleDays, setVisibleDays] = useState(DAYS_PER_PAGE);
  const [pickedDate, setPickedDate] = useState(today);
  const [editor, setEditor] = useState<EditorState | null>(null);
  // 입력 창이 닫히는 fade 동안에도 마지막으로 연 입력 창의 제목·안내문·한도로 그려 값이 바뀌어 보이지 않게 합니다.
  const lastEditorRef = useRef<EditorState | null>(null);
  if (editor) lastEditorRef.current = editor;
  const shownEditor = editor ?? lastEditorRef.current;
  const [expandedHidden, setExpandedHidden] = useState<Record<string, boolean>>({});

  const bounds = useMemo(() => diaryDateBounds(profile.birthDate, now), [profile.birthDate, now]);
  const days = useMemo<DiaryDayGroup[]>(() => {
    const grouped = groupDiaryByDate(logs);
    // 오늘 카드는 아직 아무도 쓰지 않았어도 항상 맨 위에 둡니다.
    const todayGroup = grouped.find(group => group.date === today) ?? { date: today, entries: [] };
    // 오늘보다 뒤 날짜(시계가 어긋난 기기에서 온 줄)는 목록 맨 위로 올라오지 않고 그대로 날짜 순서를 지킵니다.
    return [todayGroup, ...grouped.filter(group => group.date !== today)].sort((a, b) =>
      (a.date === today ? -1 : b.date === today ? 1 : a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [logs, today]);
  const shownDays = days.slice(0, visibleDays);

  const dayLabel = (date: string) => {
    const label = formatDiaryDateLabel(date);
    if (date === today) return `오늘 · ${label}`;
    if (date === yesterday) return `어제 · ${label}`;
    return `${date.slice(0, 4)}년 ${label}`;
  };

  const askRoleFirst = () => {
    Alert.alert('작성자를 먼저 정해 주세요', '프로필에서 아빠인지 엄마인지 먼저 정해 주세요.', [
      { text: '닫기', style: 'cancel' },
      { text: '프로필로 가기', onPress: () => onNavigate('profile') },
    ]);
  };

  // 입력 창을 열 때 고치기 대상을 정합니다. 본문이 빈 줄(1.8.0에서 메모를 지운 줄)도 대상입니다.
  const openDiaryEditor = (date: string) => {
    if (!myRole) { askRoleFirst(); return; }
    const target = pickDiaryLine(logs, date, myRole, { includeEmpty: true });
    setEditor({ kind: 'diary', date, targetId: target?.id ?? null, initialText: target ? diaryText(target) : '' });
  };

  const openCommentEditor = (date: string, parentId: string) => {
    if (!myRole) { askRoleFirst(); return; }
    setEditor({ kind: 'comment', date, parentId });
  };

  const handleEditorSave = async (text: string): Promise<boolean> => {
    if (!editor || !myRole) return false;
    if (editor.kind === 'diary') {
      return onSaveDiaryLine(editor.date, text, editor.targetId);
    }
    const comment: Omit<DiaryCommentLog, 'id'> = {
      type: 'diaryComment',
      timestamp: Date.now(),
      parentId: editor.parentId,
      diaryDate: editor.date,
      authorRole: myRole,
      notes: text,
    };
    return !!(await onAddLog(comment));
  };

  const confirmDeleteLine = (date: string, entry: DiaryRoleEntry) => {
    const extra = entry.hidden.length > 0
      ? `\n같은 역할로 쓴 다른 줄 ${entry.hidden.length}개도 함께 지워져요.`
      : '';
    Alert.alert('내 일기를 지울까요?', `${formatDiaryDateLabel(date)}에 쓴 한 줄과 달린 댓글이 사라져요.${extra}`, [
      { text: '취소', style: 'cancel' },
      {
        text: '지우기',
        style: 'destructive',
        onPress: async () => {
          let ok = false;
          try {
            ok = await onDeleteDiaryGroup(date);
          } catch {
            ok = false;
          }
          if (!ok) Alert.alert('삭제 실패', '일기를 지우지 못했어요. 잠시 뒤 다시 시도해 주세요.');
        },
      },
    ]);
  };

  const confirmDeleteComment = (comment: DiaryCommentLog) => {
    Alert.alert('댓글을 지울까요?', '지운 댓글은 되돌릴 수 없어요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '지우기',
        style: 'destructive',
        onPress: async () => {
          let ok = false;
          try {
            ok = await onDeleteComment(comment.id);
          } catch {
            ok = false;
          }
          if (!ok) Alert.alert('삭제 실패', '댓글을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요.');
        },
      },
    ]);
  };

  const renderEntry = (date: string, entry: DiaryRoleEntry) => {
    const mine = entry.role === myRole;
    const hiddenOpen = expandedHidden[`${date}|${entry.role}`] === true;
    return (
      <View key={entry.role} style={styles.entry}>
        <View style={styles.entryHeader}>
          <Text style={styles.entryAuthor}>
            {DIARY_ROLE_EMOJI[entry.role]} {DIARY_ROLE_LABEL[entry.role]}{mine ? ' (나)' : ''}
          </Text>
          {mine && (
            <View style={styles.entryActions}>
              <TouchableOpacity
                style={styles.smallButton}
                onPress={() => openDiaryEditor(date)}
                accessibilityRole="button"
                accessibilityLabel={`${formatDiaryDateLabel(date)} 내 일기 고치기`}
              >
                <Text style={styles.smallButtonText}>✏️ 고치기</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.smallButton}
                onPress={() => confirmDeleteLine(date, entry)}
                accessibilityRole="button"
                accessibilityLabel={`${formatDiaryDateLabel(date)} 내 일기 지우기`}
              >
                <Text style={[styles.smallButtonText, { color: COLORS.danger }]}>🗑 지우기</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        <Text style={styles.entryText}>{diaryText(entry.line)}</Text>

        {entry.hidden.length > 0 && (
          <View>
            <TouchableOpacity
              onPress={() => setExpandedHidden(current => ({ ...current, [`${date}|${entry.role}`]: !hiddenOpen }))}
              accessibilityRole="button"
              accessibilityState={{ expanded: hiddenOpen }}
            >
              <Text style={styles.hiddenNote}>
                같은 역할로 쓴 다른 줄 {entry.hidden.length}개가 더 있어요 {hiddenOpen ? '▲' : '▼'}
              </Text>
            </TouchableOpacity>
            {hiddenOpen && entry.hidden.map(line => (
              <Text key={line.id} style={styles.hiddenText}>· {diaryText(line)}</Text>
            ))}
          </View>
        )}

        {entry.comments.map(comment => (
          <View key={comment.id} style={styles.comment}>
            <Text style={styles.commentBody}>
              <Text style={styles.commentAuthor}>{DIARY_ROLE_EMOJI[comment.authorRole]} {DIARY_ROLE_LABEL[comment.authorRole]}  </Text>
              {diaryText(comment)}
            </Text>
            {comment.authorRole === myRole && (
              <TouchableOpacity
                style={styles.commentDelete}
                onPress={() => confirmDeleteComment(comment)}
                accessibilityRole="button"
                accessibilityLabel="내 댓글 지우기"
              >
                <Text style={styles.commentDeleteText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        <TouchableOpacity
          style={styles.addComment}
          onPress={() => openCommentEditor(date, entry.line.id)}
          accessibilityRole="button"
          accessibilityLabel={`${DIARY_ROLE_LABEL[entry.role]}의 일기에 댓글 달기`}
        >
          <Text style={styles.addCommentText}>💬 댓글 달기</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderDay = (group: DiaryDayGroup) => {
    const hasMine = !!myRole && group.entries.some(entry => entry.role === myRole);
    return (
      <View key={group.date} style={styles.dayCard}>
        <Text style={styles.dayTitle}>{dayLabel(group.date)}</Text>
        {group.entries.length === 0 && (
          <Text style={styles.emptyDay}>아직 쓴 일기가 없어요.</Text>
        )}
        {group.entries.map(entry => renderEntry(group.date, entry))}
        {!hasMine && (
          <TouchableOpacity
            style={styles.writeButton}
            onPress={() => openDiaryEditor(group.date)}
            accessibilityRole="button"
          >
            <Text style={styles.writeButtonText}>
              {myRole ? '✍️ 내 한 줄 쓰기' : '프로필에서 아빠·엄마를 먼저 정해 주세요'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // 날짜 선택기가 오늘보다 뒤나 생일보다 앞을 가리키지 않게 범위 안으로 맞춥니다(생일 한계가 없으면 아래쪽은 그대로).
  // 아래 모든 계산(고른 줄, 이동 버튼 활성, 쓰기 대상)이 이 값을 씁니다.
  const cappedPickedDate = pickedDate > bounds.max ? bounds.max : pickedDate;
  const safePickedDate = bounds.min !== null && cappedPickedDate < bounds.min ? bounds.min : cappedPickedDate;
  const pickedLine = myRole ? pickDiaryLine(logs, safePickedDate, myRole) : null;
  const canGoBack = bounds.min === null || shiftDiaryDate(safePickedDate, -1) >= bounds.min;
  const canGoForward = shiftDiaryDate(safePickedDate, 1) <= bounds.max;

  const roleOfEditor: DiaryRole | undefined = myRole;
  const editorIsDiary = shownEditor?.kind === 'diary';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => onNavigate('dashboard')} style={styles.backButton} accessibilityRole="button" accessibilityLabel="홈으로 돌아가기">
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.title}>한줄 육아일기</Text>
          <View style={styles.backButton} />
        </View>

        {!myRole && (
          <TouchableOpacity style={styles.roleNotice} onPress={() => onNavigate('profile')} accessibilityRole="button">
            <Text style={styles.roleNoticeText}>프로필에서 아빠·엄마를 먼저 정해 주세요 ›</Text>
          </TouchableOpacity>
        )}

        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>다른 날짜에 쓰기</Text>
          <View style={styles.pickerRow}>
            <TouchableOpacity
              style={[styles.arrowButton, !canGoBack && styles.arrowDisabled]}
              disabled={!canGoBack}
              onPress={() => setPickedDate(shiftDiaryDate(safePickedDate, -1))}
              accessibilityRole="button"
              accessibilityLabel="하루 전 날짜"
            >
              <Text style={styles.arrowText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.pickerDate}>{dayLabel(safePickedDate)}</Text>
            <TouchableOpacity
              style={[styles.arrowButton, !canGoForward && styles.arrowDisabled]}
              disabled={!canGoForward}
              onPress={() => setPickedDate(shiftDiaryDate(safePickedDate, 1))}
              accessibilityRole="button"
              accessibilityLabel="하루 뒤 날짜"
            >
              <Text style={styles.arrowText}>›</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.writeButton}
            onPress={() => openDiaryEditor(safePickedDate)}
            accessibilityRole="button"
          >
            <Text style={styles.writeButtonText}>
              {!myRole ? '프로필에서 아빠·엄마를 먼저 정해 주세요' : pickedLine ? '✏️ 이 날 내 일기 고치기' : '✍️ 이 날 한 줄 쓰기'}
            </Text>
          </TouchableOpacity>
        </View>

        {shownDays.map(renderDay)}

        {days.length > shownDays.length && (
          <TouchableOpacity
            style={styles.moreButton}
            onPress={() => setVisibleDays(count => count + DAYS_PER_PAGE)}
            accessibilityRole="button"
          >
            <Text style={styles.moreText}>이전 일기 더 보기 · {shownDays.length} / {days.length}일</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <DiaryEditor
        visible={editor !== null}
        title={editorIsDiary
          ? `${roleOfEditor ? DIARY_ROLE_EMOJI[roleOfEditor] : ''} ${shownEditor ? formatDiaryDateLabel(shownEditor.date) : ''} 한 줄`
          : '💬 댓글 달기'}
        description={editorIsDiary ? '하루에 한 줄, 내 줄은 다시 쓰면 고쳐져요.' : undefined}
        placeholder={editorIsDiary ? '오늘 어땠나요?' : '댓글을 남겨 보세요'}
        initialText={shownEditor?.kind === 'diary' ? shownEditor.initialText : ''}
        maxLength={editorIsDiary ? DIARY_MAX_LENGTH : DIARY_COMMENT_MAX_LENGTH}
        multiline={editorIsDiary}
        saveLabel={editorIsDiary ? '저장' : '댓글 남기기'}
        onSave={handleEditorSave}
        onClose={() => setEditor(null)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 60 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  backButton: { width: 44, height: 44, justifyContent: 'center' },
  backText: { fontSize: 36, color: COLORS.text },
  title: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  roleNotice: {
    backgroundColor: COLORS.lightYellow,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  roleNoticeText: { color: COLORS.text, fontWeight: '600', fontSize: 13 },
  pickerCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pickerTitle: { fontSize: 13, fontWeight: 'bold', color: COLORS.textMuted, marginBottom: 10 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  pickerDate: { fontSize: 16, fontWeight: 'bold', color: COLORS.text },
  arrowButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  arrowDisabled: { opacity: 0.35 },
  arrowText: { fontSize: 24, color: COLORS.text },
  dayCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dayTitle: { fontSize: 15, fontWeight: 'bold', color: COLORS.text, marginBottom: 10 },
  emptyDay: { color: COLORS.textMuted, fontSize: 13, marginBottom: 8 },
  entry: { marginBottom: 12 },
  entryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  entryAuthor: { fontSize: 13, fontWeight: 'bold', color: COLORS.primary },
  entryActions: { flexDirection: 'row', gap: 6 },
  smallButton: { paddingHorizontal: 8, paddingVertical: 6 },
  smallButtonText: { fontSize: 12, fontWeight: '600', color: COLORS.textMuted },
  entryText: { fontSize: 16, lineHeight: 24, color: COLORS.text },
  hiddenNote: { fontSize: 11, color: COLORS.textMuted, marginTop: 6 },
  hiddenText: { fontSize: 13, lineHeight: 20, color: COLORS.textMuted, marginTop: 4, paddingLeft: 6 },
  comment: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 4,
    marginTop: 8,
  },
  commentBody: { flex: 1, fontSize: 13, lineHeight: 19, color: COLORS.text },
  commentAuthor: { fontWeight: 'bold', color: COLORS.textMuted },
  commentDelete: { width: 32, height: 28, alignItems: 'center', justifyContent: 'center' },
  commentDeleteText: { fontSize: 13, color: COLORS.danger },
  addComment: { alignSelf: 'flex-start', paddingVertical: 8, marginTop: 4 },
  addCommentText: { fontSize: 12, fontWeight: '600', color: COLORS.textMuted },
  writeButton: {
    minHeight: 46,
    borderRadius: 14,
    backgroundColor: COLORS.lightPink,
    borderWidth: 1,
    borderColor: COLORS.primary + '55',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  writeButtonText: { color: COLORS.primary, fontWeight: 'bold', fontSize: 14 },
  moreButton: { paddingVertical: 16, alignItems: 'center' },
  moreText: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600' },
});
