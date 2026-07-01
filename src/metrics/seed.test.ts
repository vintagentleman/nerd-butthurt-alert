import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProbeInsert } from '../probe/types.ts';
import { insertProbe } from '../storage/probes.ts';
import { openDatabase } from '../storage/db.ts';
import { runMigrations } from '../storage/migrate.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';
import { buildRegistry } from './registry.ts';
import { seedMetrics } from './seed.ts';

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-metrics-seed-test-'));
	dbPath = join(tmpDir, 'probes.db');
	db = openDatabase(dbPath);
	runMigrations(db, MIGRATIONS);
});

afterEach(async () => {
	db.close();
	await rm(tmpDir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<ProbeInsert> = {}): ProbeInsert {
	return {
		target_name: 'rutracker',
		path_name: 'direct',
		path_role: 'direct',
		check_type: 'http_get',
		started_at: '2026-07-01T00:00:00.000Z',
		runtime_ms: 223,
		reached_stage: 'complete',
		first_failure_code: null,
		final_status_code: 200,
		impersonation_profile: 'chromium-124',
		payload: '{"schema_version":"nba-v0"}',
		...overrides,
	};
}

describe('seedMetrics', () => {
	test('replays the latest probe per cell into the gauges', async () => {
		insertProbe(
			db,
			makeRow({ target_name: 'a', started_at: '2026-07-01T00:00:00.000Z', runtime_ms: 100 }),
		);
		insertProbe(
			db,
			makeRow({ target_name: 'a', started_at: '2026-07-01T00:05:00.000Z', runtime_ms: 200 }),
		);

		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		seedMetrics(m, db);
		const text = await m.registry.metrics();

		expect(text).toContain(
			'nba_probe_latency_ms{target="a",path="direct",check_type="http_get"} 200',
		);
	});

	test('seeds gauges for multiple cells independently', async () => {
		insertProbe(db, makeRow({ target_name: 'a', path_name: 'direct' }));
		insertProbe(
			db,
			makeRow({
				target_name: 'b',
				path_name: 'direct',
				reached_stage: 'tcp_connect',
				first_failure_code: 'connection_refused',
				final_status_code: null,
			}),
		);

		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		seedMetrics(m, db);
		const text = await m.registry.metrics();

		expect(text).toContain('nba_probe_up{target="a",path="direct",check_type="http_get"} 1');
		expect(text).toContain('nba_probe_up{target="b",path="direct",check_type="http_get"} 0');
		expect(text).toContain(
			'nba_probe_reached_stage{target="b",path="direct",check_type="http_get"} 1',
		);
	});

	test('does not touch counters — probes_total stays absent after seeding', async () => {
		insertProbe(db, makeRow());

		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		seedMetrics(m, db);
		const text = await m.registry.metrics();

		expect(text).not.toContain('nba_probes_total{target="rutracker"');
		expect(text).not.toContain('nba_probe_errors_total{target="rutracker"');
	});

	test('does nothing when the DB has no probes', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		seedMetrics(m, db);
		const text = await m.registry.metrics();

		expect(text).not.toContain('target="rutracker"');
	});
});
