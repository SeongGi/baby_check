// 하네스는 안드로이드 기기를 흉내 냅니다. 동기화 계층은 Platform만 쓰고,
// 수유 알림은 권한 사전 안내창 때문에 Alert와 AppState도 씁니다.
export const Platform = { OS: 'android', select: (options) => options.android ?? options.default };
export const NativeModules = {};

// 안내창 응답을 시험마다 정합니다. 'continue'와 'cancel'은 해당 버튼을 누른 것으로,
// 'dismissed'는 뒤로 가기로 닫은 것으로, 'hold'는 응답 없이 떠 있는 것으로 처리합니다.
let alertAnswer = 'continue';
const alertCalls = [];
export const setAlertAnswer = answer => { alertAnswer = answer; };
export const getAlertCalls = () => alertCalls;
export const resetAlertCalls = () => { alertCalls.length = 0; };
export const Alert = {
  alert: (title, message, buttons = [], options = {}) => {
    alertCalls.push({ title, message });
    if (alertAnswer === 'hold') return;
    if (alertAnswer === 'dismissed') { options.onDismiss?.(); return; }
    const label = alertAnswer === 'cancel' ? '취소' : '계속';
    buttons.find(button => button.text === label)?.onPress?.();
  },
};

const appStateListeners = new Set();
export const emitAppState = state => { for (const listener of appStateListeners) listener(state); };
export const AppState = {
  currentState: 'active',
  addEventListener: (_type, listener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
};
