// Replacing or signalling processes belongs to kernel/process.
export const replace = () => process.execve("/bin/sh", []);
export const signal = () => process.kill(1);
