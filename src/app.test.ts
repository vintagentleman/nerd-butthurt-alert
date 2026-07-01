import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildSweep, ensureParentDir } from './app.ts';
import type { AppConfig } from './config/schema.ts';
import { buildRegistry } from './metrics/registry.ts';
import type { Metrics } from './metrics/registry.ts';
import { runHttpGet } from './probe/http_get.ts';
import { startTestServer } from './probe/testServer.ts';
import type { TestServer } from './probe/testServer.ts';
import { openDatabase } from './storage/db.ts';
import { runMigrations } from './storage/migrate.ts';
import { MIGRATIONS } from './storage/migrations/index.ts';

let tmpDir: string;
let server: TestServer;
let db: DatabaseSync;
let metrics: Metrics;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-app-test-'));
	server = await startTestServer();
	db = openDatabase(join(tmpDir, 'probes.db'));
	runMigrations(db, MIGRATIONS);
	metrics = buildRegistry({ version: '0.0.0', nodeVersion: process.version });
});

afterEach(async () => {
	db.close();
	await server.close();
	await rm(tmpDir, { recursive: true, force: true });
});

function buildTestConfig(targetUrl: string): AppConfig {
	return {
		metrics: { host: '127.0.0.1', port: 9974, path: '/metrics' },
		storage: { db_path: join(tmpDir, 'probes.db'), retention_days: 30 },
		scheduler: {
			http_get_cadence_seconds: 900,
			dns_lookup_cadence_seconds: 300,
			tcp_connect_cadence_seconds: 300,
		},
		probes: {
			default_timeout_ms: 10_000,
			default_impersonation_profile: 'chromium-latest',
			default_body_snippet_cap_bytes: 32_768,
			shape_detection: { unavailability_phrases: [] },
		},
		paths: [{ name: 'direct', role: 'direct' }],
		targets: [
			{
				name: 'fixture',
				url: targetUrl,
				enabled: true,
				check_types: ['http_get'],
			},
		],
	};
}

describe('buildSweep', () => {
	test('runs the real http_get spine: one probes row, gauges and counters updated', async () => {
		const config = buildTestConfig(`${server.url}/ok`);
		const sweep = buildSweep({ config, db, metrics, httpGet: runHttpGet });

		await sweep();

		const rows = db.prepare('SELECT * FROM probes').all() as {
			target_name: string;
			path_name: string;
			check_type: string;
			first_failure_code: string | null;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target_name).toBe('fixture');
		expect(rows[0]?.path_name).toBe('direct');
		expect(rows[0]?.check_type).toBe('http_get');
		expect(rows[0]?.first_failure_code).toBeNull();

		const text = await metrics.registry.metrics();
		expect(text).toMatch(
			/nba_probe_up\{target="fixture",path="direct",check_type="http_get"\} 1/,
		);
		expect(text).toMatch(
			/nba_probes_total\{target="fixture",path="direct",check_type="http_get",outcome="success"\} 1/,
		);
	}, 20_000);

	test('an httpGet throw is isolated: a synthetic failure probe is inserted instead of sinking the sweep', async () => {
		const config = buildTestConfig(`${server.url}/ok`);
		const failingHttpGet = async (): Promise<never> => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw new Error('boom');
		};
		const sweep = buildSweep({ config, db, metrics, httpGet: failingHttpGet });

		await expect(sweep()).resolves.toBeUndefined();

		const rows = db.prepare('SELECT * FROM probes').all() as {
			target_name: string;
			first_failure_code: string | null;
			runtime_ms: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target_name).toBe('fixture');
		expect(rows[0]?.first_failure_code).toBe('unknown_failure');
		expect(rows[0]?.runtime_ms).toBeGreaterThan(0);
	});
});

describe('ensureParentDir', () => {
	test('creates a missing parent directory chain for a db path', async () => {
		const dbPath = join(tmpDir, 'nested', 'deeper', 'probes.db');
		ensureParentDir(dbPath);
		expect(existsSync(join(tmpDir, 'nested', 'deeper'))).toBe(true);
	});

	test('is a no-op when the parent directory already exists', () => {
		expect(() => {
			ensureParentDir(join(tmpDir, 'probes.db'));
		}).not.toThrow();
	});
});
