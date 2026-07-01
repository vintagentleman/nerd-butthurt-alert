import { describe, expect, test } from 'vitest';
import type { ProbesConfig } from '../config/schema.ts';
import { mergeProbeConfig } from './probeConfig.ts';

const PROBES: ProbesConfig = {
	default_timeout_ms: 10000,
	default_impersonation_profile: 'chromium-latest',
	default_body_snippet_cap_bytes: 32768,
	shape_detection: { unavailability_phrases: [] },
};

describe('mergeProbeConfig', () => {
	test('defaults-only: no overrides falls back to [probes] defaults', () => {
		const result = mergeProbeConfig(PROBES, undefined);
		expect(result).toEqual({
			timeoutMs: 10000,
			impersonationProfile: 'chromium-latest',
			bodySnippetCapBytes: 32768,
		});
	});

	test('overrides win: a fully-specified override replaces every default', () => {
		const result = mergeProbeConfig(PROBES, {
			timeout_ms: 30000,
			impersonation_profile: 'firefox-latest',
			body_snippet_cap_bytes: 65536,
		});
		expect(result).toEqual({
			timeoutMs: 30000,
			impersonationProfile: 'firefox-latest',
			bodySnippetCapBytes: 65536,
		});
	});

	test('partial overrides: unset override keys fall back to defaults', () => {
		const result = mergeProbeConfig(PROBES, { timeout_ms: 5000 });
		expect(result).toEqual({
			timeoutMs: 5000,
			impersonationProfile: 'chromium-latest',
			bodySnippetCapBytes: 32768,
		});
	});
});
