/** Whether the window runs on Linux, where an update installs only on Restart now and asks for the system password. */
export const onLinux = (): boolean => /\bLinux\b/.test(navigator.userAgent);
