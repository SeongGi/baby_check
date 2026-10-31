import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme/colors';
import { clampCodePoints, countCodePoints } from '../utils/diary';

interface DiaryEditorProps {
  visible: boolean;
  title: string;
  description?: string;
  placeholder?: string;
  /** 입력 창을 열 때 보여 줄 원문. 최대 글자 수를 넘어도 자르지 않고 그대로 보여 줍니다. */
  initialText: string;
  /** 코드 포인트 기준 최대 글자 수(일기 200, 댓글 100). */
  maxLength: number;
  multiline?: boolean;
  saveLabel?: string;
  /** 앞뒤 공백을 뺀 본문으로 저장합니다. true면 창을 닫고, false면 실패 안내를 띄웁니다. */
  onSave: (text: string) => Promise<boolean>;
  onClose: () => void;
}

/** 일기와 댓글이 함께 쓰는 입력 창입니다. */
export const DiaryEditor: React.FC<DiaryEditorProps> = ({
  visible,
  title,
  description,
  placeholder,
  initialText,
  maxLength,
  multiline = true,
  saveLabel = '저장',
  onSave,
  onClose,
}) => {
  const [text, setText] = useState(initialText);
  const [isSaving, setIsSaving] = useState(false);
  // 처음 쓸 때 연달아 눌러 줄이 둘 생기는 것을 막습니다(Dashboard의 editSavingRef와 같은 방식).
  const savingRef = useRef(false);

  // 창을 열 때마다 원문으로 되돌립니다.
  useEffect(() => {
    if (visible) setText(initialText);
  }, [visible, initialText]);

  const count = countCodePoints(text);
  const overLimit = count > maxLength;

  const handleChange = (value: string) => {
    const nextCount = countCodePoints(value);
    // 한도를 넘으면서 이전보다 길어지는 입력은 거부하고 이전 값을 그대로 둡니다. 뒤를 잘라 받으면
    // 글 중간에 입력할 때 끝 글자가 말없이 사라지기 때문입니다. 이미 한도를 넘는 원문(1.8.0에서 고친 줄)도
    // 길이가 늘지 않는 입력(지우기, 같은 길이로 바꾸기)은 그대로 받아 줄일 수 있습니다.
    if (nextCount > maxLength && nextCount > count) {
      // 빈 상태에서 긴 글을 붙여 넣은 경우만 한도까지 잘라 받습니다. 거부하면 아무 반응이 없어 보이고,
      // 지킬 이전 글도 없어 잘라 받아도 사라지는 글자가 없습니다(카운터가 한도에 닿아 알 수 있습니다).
      if (count === 0) setText(clampCodePoints(value, maxLength));
      return;
    }
    setText(value);
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert('내용 확인', '내용을 입력해 주세요.');
      return;
    }
    if (countCodePoints(trimmed) > maxLength) {
      Alert.alert('글자 수 확인', `${maxLength}자 이내로 줄여 주세요.`);
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    try {
      let saved = false;
      try {
        saved = await onSave(trimmed);
      } catch {
        saved = false;
      }
      if (saved) onClose();
      else Alert.alert('저장 실패', '글을 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (savingRef.current) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleCancel}>
      <KeyboardAvoidingView style={styles.overlay} behavior="padding">
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <TextInput
            style={[styles.input, multiline && styles.inputMultiline, overLimit && styles.inputOver]}
            value={text}
            onChangeText={handleChange}
            placeholder={placeholder}
            placeholderTextColor={COLORS.textMuted}
            multiline={multiline}
            autoFocus
            textAlignVertical="top"
            editable={!isSaving}
            accessibilityLabel={title}
          />
          <Text style={[styles.counter, overLimit && styles.counterOver]}>{count}/{maxLength}</Text>
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleCancel}
              disabled={isSaving}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.saveButton, isSaving && styles.saveButtonDisabled]}
              onPress={handleSave}
              disabled={isSaving}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>{isSaving ? '저장 중...' : saveLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 22,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  description: {
    color: COLORS.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  input: {
    marginTop: 16,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: COLORS.text,
    backgroundColor: COLORS.background,
  },
  inputMultiline: {
    minHeight: 110,
    maxHeight: 220,
  },
  inputOver: {
    borderColor: COLORS.danger,
  },
  counter: {
    alignSelf: 'flex-end',
    marginTop: 6,
    fontSize: 12,
    color: COLORS.textMuted,
  },
  counterOver: {
    color: COLORS.danger,
    fontWeight: 'bold',
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelText: {
    color: COLORS.textMuted,
    fontWeight: 'bold',
    fontSize: 15,
  },
  saveButton: {
    backgroundColor: COLORS.primary,
  },
  saveButtonDisabled: {
    opacity: 0.55,
  },
  saveText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
});
