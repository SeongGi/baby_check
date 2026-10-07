export type AutoVoiceLaunchAction = 'none' | 'discard' | 'defer' | 'schedule';

export const getAutoVoiceLaunchAction = (
  candidate: number,
  consumed: number,
  isDashboard: boolean,
  enabled: boolean,
  appState: string | null,
): AutoVoiceLaunchAction => {
  if (candidate <= consumed) return 'none';
  if (!isDashboard || !enabled) return 'discard';
  if (appState !== 'active') return 'defer';
  return 'schedule';
};

export const canDispatchAutoVoiceLaunch = (appState: string | null) => appState === 'active';
