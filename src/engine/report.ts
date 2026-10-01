const reported = new Set<string>();

// Reports a problem the engine works around (a config file it skips) once per key in this process, so one met on every refresh does not flood the log.
export function reportOnce(key: string, message: string, err: unknown): void {
	if (!reported.has(key)) {
		reported.add(key);
		console.error(`suonetar: ${message}:`, err);
	}
}
