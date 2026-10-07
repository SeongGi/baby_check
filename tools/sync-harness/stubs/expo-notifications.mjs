export const AndroidImportance = { MAX: 5 };
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
export const setNotificationChannelAsync = async () => undefined;
export const getPermissionsAsync = async () => ({ status: permissionStatus });
export const requestPermissionsAsync = async () => { permissionRequests += 1; permissionStatus = 'granted'; return { status: 'granted' }; };
export const cancelScheduledNotificationAsync = async id => { scheduled.delete(id); };
export const scheduleNotificationAsync = async request => {
  await new Promise(resolve => setTimeout(resolve, 15));
  const id = `notification-${++sequence}`;
  scheduled.set(id, request);
  return id;
};
