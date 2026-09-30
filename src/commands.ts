/** Every command contributed by the extension. Keep in sync with package.json. */
export const Commands = {
  openSettings: 'devpulse.openSettings',
  showLogs: 'devpulse.showLogs',
} as const;

export type CommandId = (typeof Commands)[keyof typeof Commands];
