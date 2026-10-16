import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from './defaults.ts';
import {
	appConfigSchema,
	metricsSchema,
	pathSchema,
	probesSchema,
	schedulerSchema,
	shapeDetectionSchema,
	storageSchema,
	targetSchema,
} from './schema.ts';

describe('metricsSchema', () => {
	test('accepts a valid metrics block', () => {
		expect(metricsSchema.safeParse(DEFAULT_CONFIG.metrics).success).toBe(true);
	});

	test('rejects a port outside 1-65535', () => {
		expect(
			metricsSchema.safeParse({ host: '127.0.0.1', port: 0, path: '/metrics' }).success,
		).toBe(false);
		expect(
			metricsSchema.safeParse({ host: '127.0.0.1', port: 65536, path: '/metrics' }).success,
		).toBe(false);
	});

	test('rejects a non-integer port', () => {
		expect(
			metricsSchema.safeParse({ host: '127.0.0.1', port: 80.5, path: '/metrics' }).success,
		).toBe(false);
	});

	test('rejects a path that does not start with /', () => {
		expect(
			metricsSchema.safeParse({ host: '127.0.0.1', port: 9974, path: 'metrics' }).success,
		).toBe(false);
	});

	test('tolerates the documented extra key log_level (lenient)', () => {
		expect(
			metricsSchema.safeParse({ ...DEFAULT_CONFIG.metrics, log_level: 'info' }).success,
		).toBe(true);
	});
});

describe('storageSchema', () => {
	test('accepts a valid storage block', () => {
		expect(storageSchema.safeParse(DEFAULT_CONFIG.storage).success).toBe(true);
	});

	test('rejects an empty db_path', () => {
		expect(storageSchema.safeParse({ db_path: '', retention_days: 30 }).success).toBe(false);
	});

	test('rejects retention_days below 1', () => {
		expect(storageSchema.safeParse({ db_path: './db', retention_days: 0 }).success).toBe(false);
	});

	test('rejects a non-integer retention_days', () => {
		expect(storageSchema.safeParse({ db_path: './db', retention_days: 1.5 }).success).toBe(
			false,
		);
	});
});

describe('schedulerSchema', () => {
	test('accepts a valid scheduler block', () => {
		expect(schedulerSchema.safeParse(DEFAULT_CONFIG.scheduler).success).toBe(true);
	});

	test('rejects any cadence below 1', () => {
		expect(
			schedulerSchema.safeParse({
				http_get_cadence_seconds: 0,
				dns_lookup_cadence_seconds: 300,
				tcp_connect_cadence_seconds: 300,
			}).success,
		).toBe(false);
	});

	test('rejects a non-integer cadence', () => {
		expect(
			schedulerSchema.safeParse({
				http_get_cadence_seconds: 900,
				dns_lookup_cadence_seconds: 1.5,
				tcp_connect_cadence_seconds: 300,
			}).success,
		).toBe(false);
	});
});

describe('shapeDetectionSchema', () => {
	test('accepts a valid shape_detection block', () => {
		expect(shapeDetectionSchema.safeParse(DEFAULT_CONFIG.probes.shape_detection).success).toBe(
			true,
		);
	});

	test('rejects non-string entries in unavailability_phrases', () => {
		expect(shapeDetectionSchema.safeParse({ unavailability_phrases: [1, 2] }).success).toBe(
			false,
		);
	});
});

describe('probesSchema', () => {
	test('accepts a valid probes block', () => {
		expect(probesSchema.safeParse(DEFAULT_CONFIG.probes).success).toBe(true);
	});

	test('rejects default_timeout_ms below 1', () => {
		expect(
			probesSchema.safeParse({ ...DEFAULT_CONFIG.probes, default_timeout_ms: 0 }).success,
		).toBe(false);
	});

	test('rejects an empty default_impersonation_profile', () => {
		expect(
			probesSchema.safeParse({ ...DEFAULT_CONFIG.probes, default_impersonation_profile: '' })
				.success,
		).toBe(false);
	});

	test('rejects a negative default_body_snippet_cap_bytes', () => {
		expect(
			probesSchema.safeParse({ ...DEFAULT_CONFIG.probes, default_body_snippet_cap_bytes: -1 })
				.success,
		).toBe(false);
	});

	test('tolerates the documented extra keys (lenient)', () => {
		expect(
			probesSchema.safeParse({
				...DEFAULT_CONFIG.probes,
				default_follow_redirects: true,
				default_max_redirects: 5,
				default_pinned_http_version: '',
				default_response_headers_captured: ['content-type', 'location'],
			}).success,
		).toBe(true);
	});
});

describe('pathSchema — superRefine matrix', () => {
	test('direct + no proxy_url -> OK', () => {
		expect(pathSchema.safeParse({ name: 'direct', role: 'direct' }).success).toBe(true);
	});

	test('direct + proxy_url -> error', () => {
		expect(
			pathSchema.safeParse({
				name: 'direct',
				role: 'direct',
				proxy_url: 'socks5h://localhost:10801',
			}).success,
		).toBe(false);
	});

	test('vantage + proxy_url -> OK', () => {
		expect(
			pathSchema.safeParse({
				name: 'corp-vantage',
				role: 'vantage',
				proxy_url: 'socks5h://localhost:10801',
			}).success,
		).toBe(true);
	});

	test('vantage + no proxy_url -> error', () => {
		expect(pathSchema.safeParse({ name: 'corp-vantage', role: 'vantage' }).success).toBe(false);
	});

	test('obfuscation + proxy_url -> OK', () => {
		expect(
			pathSchema.safeParse({
				name: 'spoofdpi-local',
				role: 'obfuscation',
				proxy_url: 'socks5h://localhost:10802',
			}).success,
		).toBe(true);
	});

	test('obfuscation + no proxy_url -> error', () => {
		expect(pathSchema.safeParse({ name: 'spoofdpi-local', role: 'obfuscation' }).success).toBe(
			false,
		);
	});

	test('rejects an empty name', () => {
		expect(pathSchema.safeParse({ name: '', role: 'direct' }).success).toBe(false);
	});

	test('rejects an unknown role', () => {
		expect(pathSchema.safeParse({ name: 'x', role: 'bogus' }).success).toBe(false);
	});

	test('tolerates the documented extra keys tags/description (lenient)', () => {
		expect(
			pathSchema.safeParse({
				name: 'direct',
				role: 'direct',
				tags: ['home'],
				description: "Host's default routing",
			}).success,
		).toBe(true);
	});
});

describe('targetSchema', () => {
	test('accepts a minimal valid target and applies defaults', () => {
		const result = targetSchema.safeParse({ name: 'rutracker', url: 'https://rutracker.org/' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
			expect(result.data.check_types).toEqual(['http_get']);
		}
	});

	test('rejects an empty name', () => {
		expect(targetSchema.safeParse({ name: '', url: 'https://example.com/' }).success).toBe(
			false,
		);
	});

	test('rejects a malformed url', () => {
		expect(targetSchema.safeParse({ name: 'x', url: 'not-a-url' }).success).toBe(false);
	});

	test('rejects an unknown check_type', () => {
		expect(
			targetSchema.safeParse({
				name: 'x',
				url: 'https://example.com/',
				check_types: ['carrier_pigeon'],
			}).success,
		).toBe(false);
	});

	test('accepts explicit enabled: false', () => {
		const result = targetSchema.safeParse({
			name: 'x',
			url: 'https://example.com/',
			enabled: false,
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.enabled).toBe(false);
	});

	test('accepts probe_overrides with un-prefixed keys', () => {
		const result = targetSchema.safeParse({
			name: 'x',
			url: 'https://example.com/',
			probe_overrides: {
				timeout_ms: 30000,
				impersonation_profile: 'firefox-latest',
				body_snippet_cap_bytes: 65536,
			},
		});
		expect(result.success).toBe(true);
	});

	test('accepts multiple check_types', () => {
		const result = targetSchema.safeParse({
			name: 'x',
			url: 'https://example.com/',
			check_types: ['http_get', 'dns_lookup', 'tcp_connect'],
		});
		expect(result.success).toBe(true);
	});

	test('tolerates the documented extra keys label/cadence_override_seconds (lenient)', () => {
		const result = targetSchema.safeParse({
			name: 'x',
			url: 'https://example.com/',
			label: 'Example',
			cadence_override_seconds: 600,
		});
		expect(result.success).toBe(true);
	});
});

describe('appConfigSchema', () => {
	test('accepts the full DEFAULT_CONFIG', () => {
		const result = appConfigSchema.safeParse(DEFAULT_CONFIG);
		expect(result.success).toBe(true);
	});

	test('accepts an empty paths array (empty-list is a finalize warning, not fatal)', () => {
		const result = appConfigSchema.safeParse({ ...DEFAULT_CONFIG, paths: [] });
		expect(result.success).toBe(true);
	});

	test('accepts an empty targets array', () => {
		const result = appConfigSchema.safeParse({ ...DEFAULT_CONFIG, targets: [] });
		expect(result.success).toBe(true);
	});

	test('rejects an unknown top-level section if not stripped first', () => {
		// appConfigSchema itself is strict at the TOP level; callers (loadConfig)
		// strip unknown sections via pick() before parse. Section schemas are
		// lenient, but the section *set* is closed.
		const result = appConfigSchema.safeParse({ ...DEFAULT_CONFIG, rules: { foo: 1 } });
		expect(result.success).toBe(false);
	});

	test('accepts a spec-compliant config carrying the fuller documented surface', () => {
		const specShaped = {
			metrics: { host: '127.0.0.1', port: 9974, path: '/metrics', log_level: 'info' },
			storage: { db_path: './data/probes.db', retention_days: 30 },
			scheduler: {
				http_get_cadence_seconds: 900,
				dns_lookup_cadence_seconds: 300,
				tcp_connect_cadence_seconds: 300,
			},
			probes: {
				default_timeout_ms: 10000,
				default_impersonation_profile: 'chromium-latest',
				default_body_snippet_cap_bytes: 32768,
				default_follow_redirects: true,
				default_max_redirects: 5,
				default_pinned_http_version: '',
				default_response_headers_captured: ['content-type', 'location', 'server'],
				shape_detection: { unavailability_phrases: ['blocked'] },
			},
			paths: [
				{ name: 'direct', role: 'direct', tags: [], description: "Host's default routing" },
				{
					name: 'corp-vantage',
					role: 'vantage',
					proxy_url: 'socks5h://localhost:10801',
					tags: ['vpn'],
					description: 'Work VPN',
				},
			],
			targets: [
				{
					name: 'rutracker',
					url: 'https://rutracker.org/',
					label: 'RuTracker',
					cadence_override_seconds: 600,
				},
			],
		};
		const result = appConfigSchema.safeParse(specShaped);
		expect(result.success).toBe(true);
	});
});
