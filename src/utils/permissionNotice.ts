// 앱 접근권한 사전 고지에 쓰는 순수 로직과 문구입니다.
// node 테스트가 이 파일을 바로 실행하므로 다른 파일을 가져오지 않고 enum과 namespace를 쓰지 않습니다.

export const PERMISSION_NOTICE_KEY = '@babycheck/permissionNoticeSeen.v1';

export type PermissionNoticeItem = {
  name: string;
  required: boolean;
  reason: string;
};

export const PERMISSION_NOTICE_ITEMS: PermissionNoticeItem[] = [
  {
    name: '마이크',
    required: false,
    reason: '음성으로 수유·수면 등을 기록할 때 말소리를 인식합니다.',
  },
  {
    name: '알림',
    required: false,
    reason: '다음 수유 시간이 되면 알려 드립니다.',
  },
];

export type PermissionPrompt = {
  title: string;
  message: string;
};

export const MICROPHONE_PROMPT: PermissionPrompt = {
  title: '마이크 사용 안내',
  message:
    '음성으로 수유·수면 등을 기록할 때 말소리를 인식하려고 마이크를 사용합니다. 마이크는 선택 권한이라서 허용하지 않아도 다른 기능은 그대로 쓸 수 있습니다.',
};

export const NOTIFICATION_PROMPT: PermissionPrompt = {
  title: '알림 사용 안내',
  message:
    '다음 수유 시간이 되면 알려 드리려고 알림을 사용합니다. 알림은 선택 권한이라서 허용하지 않아도 다른 기능은 그대로 쓸 수 있습니다.',
};

export const PARTNER_PUSH_PROMPT: PermissionPrompt = {
  title: '알림 사용 안내',
  message:
    '가족이 기록을 남기면 알려 드리려고 알림을 사용합니다. 알림은 선택 권한이라서 허용하지 않아도 다른 기능은 그대로 쓸 수 있습니다.',
};

export const PERMISSION_NOTICE_TEXT = {
  title: '앱 접근권한 안내',
  noRequired: '필수 접근권한은 없습니다. 아래 권한은 모두 선택이며, 해당 기능을 쓸 때 앱이 먼저 이유를 알려 드리고 동의를 여쭙니다.',
  closing:
    '허용하지 않아도 다른 기능은 그대로 쓸 수 있습니다. 휴대폰 설정 > 애플리케이션 > 아기기록 > 권한에서 언제든 바꿀 수 있습니다.',
  confirm: '확인',
};

// 저장값이 '1'이 아니면 첫 실행 안내를 보여 줍니다.
export const shouldShowPermissionNotice = (stored: string | null): boolean => stored !== '1';

// 허용되지 않았고 다시 물을 수 있을 때만 사전 안내창을 띄웁니다.
// 다시 물을 수 없는 상태에서는 운영체제 허용 창이 뜨지 않으므로 안내도 하지 않습니다.
export const shouldExplainBeforeRequest = (p: { granted: boolean; canAskAgain?: boolean }): boolean =>
  !p.granted && p.canAskAgain !== false;
