import assert from 'node:assert/strict';
import {
  MICROPHONE_PROMPT,
  NOTIFICATION_PROMPT,
  PARTNER_PUSH_PROMPT,
  PERMISSION_NOTICE_ITEMS,
  PERMISSION_NOTICE_KEY,
  PERMISSION_NOTICE_TEXT,
  shouldExplainBeforeRequest,
  shouldShowPermissionNotice,
} from '../src/utils/permissionNotice.ts';

// 첫 실행 안내: 저장값이 '1'일 때만 다시 보여 주지 않는다.
assert.equal(shouldShowPermissionNotice(null), true);
assert.equal(shouldShowPermissionNotice(''), true);
assert.equal(shouldShowPermissionNotice('0'), true);
assert.equal(shouldShowPermissionNotice('1'), false);

// 요청 직전 안내: 허용되지 않았고 다시 물을 수 있을 때만 안내한다.
assert.equal(shouldExplainBeforeRequest({ granted: true }), false);
assert.equal(shouldExplainBeforeRequest({ granted: true, canAskAgain: true }), false);
assert.equal(shouldExplainBeforeRequest({ granted: false, canAskAgain: true }), true);
assert.equal(shouldExplainBeforeRequest({ granted: false, canAskAgain: false }), false);
assert.equal(shouldExplainBeforeRequest({ granted: false }), true);

// 권한 항목: 2개 모두 선택 권한이고 이유가 비어 있지 않다.
assert.equal(PERMISSION_NOTICE_ITEMS.length, 2);
assert.deepEqual(PERMISSION_NOTICE_ITEMS.map(item => item.name), ['마이크', '알림']);
for (const item of PERMISSION_NOTICE_ITEMS) {
  assert.equal(item.required, false, `${item.name}은 선택 권한이어야 합니다`);
  assert.ok(item.reason.trim().length > 0, `${item.name}의 이유가 비어 있습니다`);
}

// 문구: 선택 권한이라는 점과 거부해도 다른 기능을 쓸 수 있다는 점을 담는다.
for (const prompt of [MICROPHONE_PROMPT, NOTIFICATION_PROMPT]) {
  assert.ok(prompt.title.trim().length > 0);
  assert.ok(prompt.message.includes('선택'), '안내 문구에 "선택"이 들어 있어야 합니다');
  assert.ok(prompt.message.includes('허용하지 않아도'), '거부해도 쓸 수 있다는 문구가 있어야 합니다');
}
// 가족 기록 알림 안내는 수유 알림 문구와 달라야 하고 같은 조건(선택, 거부해도 사용 가능)을 담는다.
assert.notEqual(PARTNER_PUSH_PROMPT.message, NOTIFICATION_PROMPT.message);
assert.ok(PARTNER_PUSH_PROMPT.message.includes('가족'));
assert.ok(!PARTNER_PUSH_PROMPT.message.includes('수유'));
assert.ok(PARTNER_PUSH_PROMPT.message.includes('선택'));
assert.ok(PARTNER_PUSH_PROMPT.message.includes('허용하지 않아도'));
assert.ok(PERMISSION_NOTICE_TEXT.noRequired.includes('선택'));
assert.ok(PERMISSION_NOTICE_TEXT.noRequired.includes('필수'));
assert.ok(PERMISSION_NOTICE_TEXT.closing.includes('허용하지 않아도 다른 기능은 그대로 쓸 수 있습니다.'));
assert.ok(PERMISSION_NOTICE_TEXT.closing.includes('휴대폰 설정 > 애플리케이션 > 아기기록 > 권한'));

// 저장소 키는 새로 추가하는 하나뿐이다.
assert.equal(PERMISSION_NOTICE_KEY, '@babycheck/permissionNoticeSeen.v1');

console.log('PASS permissionNotice');
