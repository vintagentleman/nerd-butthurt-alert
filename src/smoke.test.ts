import { expect, test } from 'vitest';

test('toolchain runs typescript tests', () => {
	const xs: readonly number[] = [1, 2, 3];
	expect(xs.reduce((a, b) => a + b, 0)).toBe(6);
});
