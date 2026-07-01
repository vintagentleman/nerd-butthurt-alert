import { describe, expect, test } from 'vitest';
import type { ProbeHop, ProbePayload } from '../probe/types.ts';
import { deriveFirstFailureCode, deriveProbeColumns } from './derive.ts';

function makeHop(overrides: Partial<ProbeHop> = {}): ProbeHop {
	return {
		sequence: 0,
		url: 'https://example.com/',
		dns: { failure: null },
		tcp: { ip: '93.184.216.34', port: 443, status: { success: true, failure: null } },
		tls: { failure: null },
		http: {
			request: { failure: null },
			response: { failure: null },
		},
		body: { failure: null },
		failure: null,
		...overrides,
	};
}

function makePayload(overrides: Partial<ProbePayload> = {}): ProbePayload {
	return {
		schema_version: 'nba-v0',
		check_type: 'http_get',
		started_at: '2026-07-01T00:00:00.000Z',
		runtime_ms: 223,
		url: 'https://example.com/',
		path: { name: 'direct', role: 'direct', tags: [] },
		data: {
			reached_stage: 'complete',
			hops: [makeHop()],
			rollup: { final_url: 'https://example.com/', final_status_code: 200 },
			config: { impersonation_profile: 'chromium-124' },
		},
		...overrides,
	};
}

describe('deriveFirstFailureCode', () => {
	test('returns null for a clean http_get payload', () => {
		const payload = makePayload();
		expect(deriveFirstFailureCode(payload)).toBeNull();
	});

	test('returns the dns failure when the dns op fails', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'dns',
				hops: [makeHop({ dns: { failure: 'dns_nxdomain' } })],
			},
		});
		expect(deriveFirstFailureCode(payload)).toBe('dns_nxdomain');
	});

	test('returns the tcp status failure (nested at tcp.status.failure)', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'tcp_connect',
				hops: [
					makeHop({
						tcp: {
							ip: null,
							port: 443,
							status: { success: false, failure: 'connection_refused' },
						},
					}),
				],
			},
		});
		expect(deriveFirstFailureCode(payload)).toBe('connection_refused');
	});

	test('earliest-op-within-hop wins: dns failure precedes a later tls failure', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'dns',
				hops: [
					makeHop({
						dns: { failure: 'dns_nxdomain' },
						tls: { failure: 'tls_handshake_failed' },
					}),
				],
			},
		});
		expect(deriveFirstFailureCode(payload)).toBe('dns_nxdomain');
	});

	test('earliest-hop wins: a failure in hop 0 precedes a failure in hop 1', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'tls_handshake',
				hops: [
					makeHop({ sequence: 0, tls: { failure: 'tls_handshake_failed' } }),
					makeHop({ sequence: 1, dns: { failure: 'dns_nxdomain' } }),
				],
			},
		});
		expect(deriveFirstFailureCode(payload)).toBe('tls_handshake_failed');
	});

	test('is null-safe when sub-op blocks are absent', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'complete',
				hops: [{ sequence: 0, url: 'https://example.com/' }],
			},
		});
		expect(deriveFirstFailureCode(payload)).toBeNull();
	});

	test('is null-safe when hops is absent entirely', () => {
		const payload = makePayload({
			data: { reached_stage: 'complete' },
		});
		expect(deriveFirstFailureCode(payload)).toBeNull();
	});
});

describe('deriveProbeColumns', () => {
	test('maps every column from the envelope, path, and data', () => {
		const payload = makePayload({
			path: { name: 'corp-vantage', role: 'vantage', tags: ['vpn'] },
		});
		const row = deriveProbeColumns({ targetName: 'rutracker', payload });

		expect(row.target_name).toBe('rutracker');
		expect(row.path_name).toBe('corp-vantage');
		expect(row.path_role).toBe('vantage');
		expect(row.check_type).toBe('http_get');
		expect(row.started_at).toBe('2026-07-01T00:00:00.000Z');
		expect(row.runtime_ms).toBe(223);
		expect(row.reached_stage).toBe('complete');
		expect(row.first_failure_code).toBeNull();
		expect(row.final_status_code).toBe(200);
		expect(row.impersonation_profile).toBe('chromium-124');
		expect(JSON.parse(row.payload)).toEqual(payload);
	});

	test('final_status_code and impersonation_profile fall back to null when absent', () => {
		const payload = makePayload({ data: { reached_stage: 'complete' } });
		const row = deriveProbeColumns({ targetName: 'rutracker', payload });

		expect(row.final_status_code).toBeNull();
		expect(row.impersonation_profile).toBeNull();
	});

	test('carries a derived first_failure_code through onto the row', () => {
		const payload = makePayload({
			data: {
				reached_stage: 'tcp_connect',
				hops: [
					makeHop({
						tcp: {
							ip: null,
							port: 443,
							status: { success: false, failure: 'connection_refused' },
						},
					}),
				],
			},
		});
		const row = deriveProbeColumns({ targetName: 'rutracker', payload });

		expect(row.first_failure_code).toBe('connection_refused');
		expect(row.reached_stage).toBe('tcp_connect');
	});
});
