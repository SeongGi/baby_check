import { Alert } from 'react-native';
import { PermissionPrompt } from './permissionNotice';

// 'continue'는 "계속", 'cancel'은 "취소" 버튼입니다.
// 뒤로 가기, 바깥 누름, 다른 Alert에 밀려 닫힌 경우는 모두 'dismissed'입니다.
export type PermissionPromptResult = 'continue' | 'cancel' | 'dismissed';

// 운영체제 허용 창을 띄우기 직전에 앱이 먼저 용도를 알리는 안내창입니다.
// 대기 중인 Promise를 모듈 수준에서 공유하지 않습니다. 콜백 없이 사라진 Alert가 남아 이후 시작을 막지 않도록,
// 겹침 방지는 호출하는 쪽이 맡습니다.
export const confirmPermissionPrompt = (prompt: PermissionPrompt): Promise<PermissionPromptResult> =>
  new Promise(resolve => {
    let settled = false;
    const settle = (result: PermissionPromptResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    Alert.alert(
      prompt.title,
      prompt.message,
      [
        { text: '취소', style: 'cancel', onPress: () => settle('cancel') },
        { text: '계속', onPress: () => settle('continue') },
      ],
      { cancelable: true, onDismiss: () => settle('dismissed') },
    );
  });
