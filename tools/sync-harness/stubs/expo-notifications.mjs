export const AndroidImportance = { MAX: 5, HIGH: 4, LOW: 2 };
export const AndroidNotificationVisibility = { PUBLIC: 1 };
export const AndroidNotificationPriority = { MAX: 2 };
export const SchedulableTriggerInputTypes = { DATE: 'date' };

const scheduled = new Map();
let sequence = 0;
let permissionStatus = 'granted';
let permissionRequests = 0;
export const getScheduled = () => [...scheduled.values()];
export const resetScheduled = () => { scheduled.clear(); sequence = 0; };
export const setPermissionStatus = status => { permissionStatus = status; permissionRequests = 0; };
export const getPermissionRequests = () => permissionRequests;
export const setNotificationHandler = () => undefined;
export const getPermissionsAsync = async () => { calls.getPermissions += 1; return { status: permissionStatus }; };
export const requestPermissionsAsync = async () => { permissionRequests += 1; permissionStatus = 'granted'; return { status: 'granted' }; };
export const cancelScheduledNotificationAsync = async id => { scheduled.delete(id); };
export const scheduleNotificationAsync = async request => {
  await new Promise(resolve => setTimeout(resolve, 15));
  const id = `notification-${++sequence}`;
  scheduled.set(id, request);
  return id;
};

// 상대 기기 기록 알림(02 설계 5장)용 스텁입니다. 호출 수를 세어 앱 쪽 시험이 "푸시 관련 호출 0회" 같은 것을 확인합니다.
const calls = {
  getExpoPushToken: 0,
  getPermissions: 0,
  setNotificationChannel: 0,
  addPushTokenListener: 0,
  addNotificationReceivedListener: 0,
  getLastNotificationResponse: 0,
};
const channels = new Map();
const pushTokenListeners = new Set();
const receivedListeners = new Set();
let expoPushToken = 'ExponentPushToken[harness-token]';
let expoPushTokenError = null;
let lastNotificationResponse = null;
// 채널을 만든 시점의 토큰 조회 수를 적어 두면 "채널이 토큰 조회보다 먼저"를 확인할 수 있습니다.
const order = [];

export const getCallCounts = () => ({ ...calls });
export const getCallOrder = () => [...order];
export const resetCallCounts = () => {
  for (const key of Object.keys(calls)) calls[key] = 0;
  order.length = 0;
};
export const getChannels = () => [...channels.entries()].map(([id, channel]) => ({ id, ...channel }));
export const setExpoPushToken = token => { expoPushToken = token; };
export const setExpoPushTokenError = error => { expoPushTokenError = error; };
export const setLastNotificationResponse = response => { lastNotificationResponse = response; };
export const emitPushToken = token => { for (const listener of [...pushTokenListeners]) listener(token); };
export const emitNotificationReceived = notification => { for (const listener of [...receivedListeners]) listener(notification); };

export const setNotificationChannelAsync = async (id, channel) => {
  calls.setNotificationChannel += 1;
  order.push(`channel:${id}`);
  channels.set(id, channel);
  return channel;
};
export const getExpoPushTokenAsync = async options => {
  calls.getExpoPushToken += 1;
  order.push('token');
  if (expoPushTokenError) throw expoPushTokenError;
  return { type: 'expo', data: expoPushToken, options };
};
export const addPushTokenListener = listener => {
  calls.addPushTokenListener += 1;
  pushTokenListeners.add(listener);
  return { remove: () => { pushTokenListeners.delete(listener); } };
};
export const addNotificationReceivedListener = listener => {
  calls.addNotificationReceivedListener += 1;
  receivedListeners.add(listener);
  return { remove: () => { receivedListeners.delete(listener); } };
};
export const getLastNotificationResponseAsync = async () => {
  calls.getLastNotificationResponse += 1;
  return lastNotificationResponse;
};
