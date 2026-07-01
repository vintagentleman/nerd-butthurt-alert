import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { deriveFirstFailureCode } from '../storage/derive.ts';
import { runHttpGet } from './http_get.ts';
import { findUnusedPort, startTestServer } from './testServer.ts';
import type { TestServer } from './testServer.ts';

const PATH = { name: 'direct', role: 'direct' as const, tags: [] };
const SHAPE = { unavailability_phrases: [] };

let server: TestServer;

beforeAll(async () => {
	server = await startTestServer();
});

afterAll(async () => {
	await server.close();
});

describe('runHttpGet', () => {
	test('200 route -> reached_stage complete, final status 200, shape signals present, no failure', async () => {
		const payload = await runHttpGet({
			url: `${server.url}/ok`,
			timeoutMs: 10_000,
			impersonationProfile: 'chromium-baseline',
			bodySnippetCapBytes: 32_768,
			proxyUrl: null,
			path: PATH,
			shape: SHAPE,
		});

		expect(payload.schema_version).toBe('nba-v0');
		expect(payload.check_type).toBe('http_get');
		expect(payload.data.reached_stage).toBe('complete');
		expect(payload.data.termination_mode).toBe('clean_fin');
		expect(payload.data.rollup?.final_status_code).toBe(200);
		expect(deriveFirstFailureCode(payload)).toBeNull();

		const hop = payload.data.hops?.[0];
		expect(hop?.http?.response?.code).toBe(200);
		expect(hop?.body?.shape_signals).toBeDefined();
		expect(hop?.body?.shape_signals?.is_empty_or_minimal_html).toBe(true);
		expect(typeof payload.runtime_ms).toBe('number');
		expect(payload.data.config?.impersonation_profile).toBe('chromium-baseline');
	}, 20_000);

	test('302 -> 200 redirect: final status 200 and redirect captured in rollup.redirect_chain', async () => {
		const payload = await runHttpGet({
			url: `${server.url}/redirect`,
			timeoutMs: 10_000,
			impersonationProfile: 'chromium-baseline',
			bodySnippetCapBytes: 32_768,
			proxyUrl: null,
			path: PATH,
			shape: SHAPE,
		});

		expect(payload.data.reached_stage).toBe('complete');
		expect(payload.data.rollup?.final_status_code).toBe(200);
		expect(payload.data.rollup?.final_url).toContain('/ok');
		expect(payload.data.rollup?.redirect_chain?.length).toBeGreaterThanOrEqual(1);
		expect(deriveFirstFailureCode(payload)).toBeNull();
	}, 20_000);

	test('connection refused (nothing listening) -> failure payload with connection_refused', async () => {
		const deadPort = await findUnusedPort();
		const payload = await runHttpGet({
			url: `http://127.0.0.1:${String(deadPort)}/`,
			timeoutMs: 10_000,
			impersonationProfile: 'chromium-baseline',
			bodySnippetCapBytes: 32_768,
			proxyUrl: null,
			path: PATH,
			shape: SHAPE,
		});

		expect(payload.data.reached_stage).not.toBe('complete');
		expect(payload.data.reached_stage).toBe('tcp_connect');
		expect(deriveFirstFailureCode(payload)).toBe('connection_refused');
	}, 20_000);
});
