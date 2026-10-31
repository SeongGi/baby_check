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
    // 입력 중에는 최대 글자 수에서 더 입력되지 않게 자릅니다. 다만 이미 한도를 넘는 원문
    // (1.8.0에서 고친 줄)은 자르지 않고, 지우는 쪽으로는 자유롭게 줄일 수 있게 둡니다.
    setText(clampCodePoints(value, Math.max(maxLength, countCodePoints(text))));
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
