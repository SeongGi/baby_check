import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';
import { PERMISSION_NOTICE_ITEMS, PERMISSION_NOTICE_TEXT } from '../utils/permissionNotice';

interface PermissionNoticeModalProps {
  visible: boolean;
  onConfirm: () => void;
}

// 앱을 처음 실행할 때 한 번 보여 주는 접근권한 안내입니다. 뒤로 가기도 확인과 같게 처리합니다.
export const PermissionNoticeModal: React.FC<PermissionNoticeModalProps> = ({ visible, onConfirm }) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onConfirm}>
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Text style={styles.title}>{PERMISSION_NOTICE_TEXT.title}</Text>
        <Text style={styles.description}>{PERMISSION_NOTICE_TEXT.noRequired}</Text>
        <View style={styles.list}>
          {PERMISSION_NOTICE_ITEMS.map(item => (
            <View key={item.name} style={styles.item}>
              <Text style={styles.itemName}>{item.name} (선택)</Text>
              <Text style={styles.itemReason}>{item.reason}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.closing}>{PERMISSION_NOTICE_TEXT.closing}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel={PERMISSION_NOTICE_TEXT.confirm}
        >
          <Text style={styles.buttonText}>{PERMISSION_NOTICE_TEXT.confirm}</Text>
        </TouchableOpacity>
      </View>
    </View>
  </Modal>
);

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
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  list: {
    marginTop: 14,
    gap: 10,
  },
  item: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
  },
  itemName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  itemReason: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.textMuted,
  },
  closing: {
    marginTop: 14,
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textMuted,
  },
  button: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
});
