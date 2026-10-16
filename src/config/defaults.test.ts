import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from './defaults.ts';

describe('DEFAULT_CONFIG', () => {
	test('matches the documented shape verbatim', () => {
		expect(DEFAULT_CONFIG).toEqual({
			metrics: { host: '127.0.0.1', port: 9974, path: '/metrics' },
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
				shape_detection: {
					unavailability_phrases: [],
				},
			},
			paths: [{ name: 'direct', role: 'direct' }],
			targets: [],
		});
	});
});
