/** Every command contributed by the extension. Keep in sync with package.json. */
export const Commands = {
  connect: 'devpulse.connect',
  disconnect: 'devpulse.disconnect',
  reconnect: 'devpulse.reconnect',
  pauseTracking: 'devpulse.pauseTracking',
  resumeTracking: 'devpulse.resumeTracking',
  startSession: 'devpulse.startSession',
  endSession: 'devpulse.endSession',
  syncNow: 'devpulse.syncNow',
  clearQueue: 'devpulse.clearQueue',
  excludeProject: 'devpulse.excludeCurrentProject',
  openSettings: 'devpulse.openSettings',
  showLogs: 'devpulse.showLogs',
} as const;

export type CommandId = (typeof Commands)[keyof typeof Commands];
