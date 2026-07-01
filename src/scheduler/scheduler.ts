import { Cron } from 'croner';

/**
 * interval_seconds → a 6-field cron pattern (seconds is the first field).
 * <60: must evenly divide 60 (else throw) → `*\/N * * * * *`
 * >=60: must be a whole number of minutes (else throw) → `0 *\/M * * * *`
 */
export function secondsToCronPattern(seconds: number): string {
	if (!Number.isInteger(seconds) || seconds < 1) {
		throw new Error(`secondsToCronPattern: seconds must be a positive integer, got ${seconds}`);
	}
	if (seconds < 60) {
		if (60 % seconds !== 0) {
			throw new Error(
				`secondsToCronPattern: ${seconds} must evenly divide 60 when under 60 seconds`,
			);
		}
		return `*/${seconds} * * * * *`;
	}
	if (seconds % 60 !== 0) {
		throw new Error(
			`secondsToCronPattern: ${seconds} must be a whole number of minutes when 60 or over`,
		);
	}
	return `0 */${seconds / 60} * * * *`;
}

/** Wrap a job so overlapping ticks are skipped (belt; croner `protect` is the braces). */
export function makeGuarded(job: () => Promise<void>): () => Promise<void> {
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			await job();
		} finally {
			running = false;
		}
	};
}

export function startScheduler(intervalSeconds: number, job: () => Promise<void>): Cron {
	const guarded = makeGuarded(job);
	return new Cron(secondsToCronPattern(intervalSeconds), { protect: true }, guarded);
}
