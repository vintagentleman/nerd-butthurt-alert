import { describe, expect, test } from 'vitest';

import { deepMerge } from './merge.ts';

describe('deepMerge', () => {
	test('merges nested objects key-by-key', () => {
		const base = { a: { x: 1, y: 2 }, b: 1 };
		const override = { a: { y: 99 } };
		expect(deepMerge(base, override)).toEqual({ a: { x: 1, y: 99 }, b: 1 });
	});

	test('replaces arrays wholesale rather than concatenating', () => {
		const base = { list: [1, 2, 3] };
		const override = { list: [9] };
		expect(deepMerge(base, override)).toEqual({ list: [9] });
	});

	test('overrides scalars outright', () => {
		const base = { n: 1, s: 'a', flag: true };
		const override = { n: 2, s: 'b', flag: false };
		expect(deepMerge(base, override)).toEqual({ n: 2, s: 'b', flag: false });
	});

	test('keys missing from override fall through to base', () => {
		const base = { a: 1, b: { c: 2, d: 3 } };
		const override = { b: { c: 20 } };
		expect(deepMerge(base, override)).toEqual({ a: 1, b: { c: 20, d: 3 } });
	});

	test('does not mutate the base object', () => {
		const base = { a: { x: 1 } };
		const snapshot = structuredClone(base);
		deepMerge(base, { a: { x: 2 } });
		expect(base).toEqual(snapshot);
	});

	test('a plain object override replaces a non-object base value', () => {
		const base = { a: 'scalar' };
		const override = { a: { nested: true } };
		expect(deepMerge(base as unknown as Record<string, unknown>, override)).toEqual({
			a: { nested: true },
		});
	});

	test('a scalar override replaces a plain object base value', () => {
		const base = { a: { nested: true } };
		const override = { a: 'scalar' };
		expect(deepMerge(base, override)).toEqual({ a: 'scalar' });
	});

	test('deep merge recurses through multiple nesting levels', () => {
		const base = { a: { b: { c: 1, d: 2 } } };
		const override = { a: { b: { c: 99 } } };
		expect(deepMerge(base, override)).toEqual({ a: { b: { c: 99, d: 2 } } });
	});
});
