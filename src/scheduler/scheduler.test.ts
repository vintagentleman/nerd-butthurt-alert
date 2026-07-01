import { Cron } from 'croner';
import { describe, expect, test } from 'vitest';
import { makeGuarded, secondsToCronPattern, startScheduler } from './scheduler.ts';

describe('secondsToCronPattern', () => {
	test('30 seconds → every-30-seconds pattern', () => {
		expect(secondsToCronPattern(30)).toBe('*/30 * * * * *');
	});

	test('60 seconds → every-1-minute pattern', () => {
		expect(secondsToCronPattern(60)).toBe('0 */1 * * * *');
	});

	test('300 seconds → every-5-minutes pattern', () => {
		expect(secondsToCronPattern(300)).toBe('0 */5 * * * *');
	});

	test('a sub-60 value that does not evenly divide 60 throws', () => {
		expect(() => secondsToCronPattern(7)).toThrow();
	});

	test('a >=60 value that is not a whole number of minutes throws', () => {
		expect(() => secondsToCronPattern(90)).toThrow();
	});

	test('zero throws', () => {
		expect(() => secondsToCronPattern(0)).toThrow();
	});

	test('a negative value throws', () => {
		expect(() => secondsToCronPattern(-30)).toThrow();
	});

	test('a non-integer value throws', () => {
		expect(() => secondsToCronPattern(30.5)).toThrow();
	});
});

describe('makeGuarded', () => {
	test('skips a re-entrant call while the prior call is still in flight', async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const job = () =>
			new Promise<void>((resolve) => {
				calls++;
				release = resolve;
			});
		const guarded = makeGuarded(job);

		const firstCall = guarded();
		expect(calls).toBe(1);

		// A second call arrives while the first is still pending — must be a no-op.
		const secondCall = guarded();
		expect(calls).toBe(1);

		release?.();
		await firstCall;
		await secondCall;

		// Now that the first run finished, a fresh call must run the job again.
		const thirdCall = guarded();
		expect(calls).toBe(2);
		release?.();
		await thirdCall;
	});
});

describe('startScheduler', () => {
	test('returns a Cron instance without throwing for a valid interval', () => {
		const cron = startScheduler(30, () => Promise.resolve());
		expect(cron).toBeInstanceOf(Cron);
		cron.stop();
	});
});
