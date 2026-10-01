// Starting a process costs several times more on Windows, and a hosted CI runner is slower again: the engine tests, which run git hundreds of times, ran three to four times longer there than the Linux-sized limits allow.
export const TIMEOUT_SCALE = process.platform === "win32" ? 4 : 1;
