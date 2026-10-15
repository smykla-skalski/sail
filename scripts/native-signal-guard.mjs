import process from 'node:process';

/**
 * A pid or group id of 0 or 1, a negative one or one beyond a 32-bit signed integer, turns a signal into one for the caller's own
 * group, for init or, with -1, for every process the user owns. Ids that come from a file or a
 * process listing pass this check before any signal.
 * @param {unknown} pid
 */
export const signalablePid = (pid) => Number.isSafeInteger(pid) && pid > 1 && pid <= 2 ** 31 - 1;

/** The runner itself and the shell that started it are never a target of a cleanup. */
export const isOwnProcess = (pid) => pid === process.pid || pid === process.ppid;
