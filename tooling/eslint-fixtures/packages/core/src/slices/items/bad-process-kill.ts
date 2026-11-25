export const stop = (pid: number) => process.kill(pid, "SIGTERM");
const { kill } = process;
export const alive = (pid: number) => kill(pid, 0);
