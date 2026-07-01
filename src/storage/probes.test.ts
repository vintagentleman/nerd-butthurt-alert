import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProbeInsert } from '../probe/types.ts';
import { openDatabase } from './db.ts';
import { runMigrations } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { insertProbe, latestProbesPerCell } from './probes.ts';

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-storage-test-'));
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

describe('insertProbe', () => {
	test('round-trips: a row read back matches what was inserted', () => {
		const row = makeRow();
		insertProbe(db, row);

		const inserted = db.prepare('SELECT * FROM probes').all() as unknown as (ProbeInsert & {
			id: number;
		})[];
		expect(inserted).toHaveLength(1);
		const got = inserted[0];
		expect(got?.target_name).toBe(row.target_name);
		expect(got?.path_name).toBe(row.path_name);
		expect(got?.path_role).toBe(row.path_role);
		expect(got?.check_type).toBe(row.check_type);
		expect(got?.started_at).toBe(row.started_at);
		expect(got?.runtime_ms).toBe(row.runtime_ms);
		expect(got?.reached_stage).toBe(row.reached_stage);
		expect(got?.first_failure_code).toBeNull();
		expect(got?.final_status_code).toBe(row.final_status_code);
		expect(got?.impersonation_profile).toBe(row.impersonation_profile);
		expect(got?.payload).toBe(row.payload);
	});

	test('round-trips a failed probe with a non-null first_failure_code', () => {
		const row = makeRow({
			reached_stage: 'tcp_connect',
			first_failure_code: 'connection_refused',
			final_status_code: null,
			impersonation_profile: null,
		});
		insertProbe(db, row);

		const got = db.prepare('SELECT * FROM probes').get() as unknown as ProbeInsert;
		expect(got.first_failure_code).toBe('connection_refused');
		expect(got.final_status_code).toBeNull();
		expect(got.impersonation_profile).toBeNull();
	});
});

describe('latestProbesPerCell', () => {
	test('returns exactly one row per (target_name, path_name, check_type) cell', () => {
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				started_at: '2026-07-01T00:00:00.000Z',
			}),
		);
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				started_at: '2026-07-01T00:05:00.000Z',
			}),
		);
		insertProbe(
			db,
			makeRow({
				target_name: 'b',
				path_name: 'direct',
				started_at: '2026-07-01T00:01:00.000Z',
			}),
		);

		const rows = latestProbesPerCell(db);
		expect(rows).toHaveLength(2);
	});

	test('picks the row with the max started_at per cell', () => {
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				started_at: '2026-07-01T00:00:00.000Z',
				reached_stage: 'complete',
				first_failure_code: null,
			}),
		);
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				started_at: '2026-07-01T00:05:00.000Z',
				reached_stage: 'tcp_connect',
				first_failure_code: 'connection_refused',
			}),
		);

		const rows = latestProbesPerCell(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.started_at).toBe('2026-07-01T00:05:00.000Z');
		expect(rows[0]?.reached_stage).toBe('tcp_connect');
		expect(rows[0]?.first_failure_code).toBe('connection_refused');
	});

	test('on a started_at tie, returns exactly one row — the later-inserted (higher id)', () => {
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				check_type: 'http_get',
				started_at: '2026-07-01T00:00:00.000Z',
				reached_stage: 'complete',
				first_failure_code: null,
			}),
		);
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				check_type: 'http_get',
				started_at: '2026-07-01T00:00:00.000Z',
				reached_stage: 'tcp_connect',
				first_failure_code: 'connection_refused',
			}),
		);

		const rows = latestProbesPerCell(db);
		expect(rows).toHaveLength(1);
		// The second insert has the higher id, so the tiebreak must pick it.
		expect(rows[0]?.reached_stage).toBe('tcp_connect');
		expect(rows[0]?.first_failure_code).toBe('connection_refused');
	});

	test('distinguishes cells by check_type as well as target/path', () => {
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				check_type: 'http_get',
				started_at: '2026-07-01T00:00:00.000Z',
			}),
		);
		insertProbe(
			db,
			makeRow({
				target_name: 'a',
				path_name: 'direct',
				check_type: 'tcp_connect',
				started_at: '2026-07-01T00:00:00.000Z',
				final_status_code: null,
				impersonation_profile: null,
			}),
		);

		const rows = latestProbesPerCell(db);
		expect(rows).toHaveLength(2);
		const checkTypes = rows.map((r) => r.check_type).sort();
		expect(checkTypes).toEqual(['http_get', 'tcp_connect']);
	});

	test('returns only the ProbeMetricInput fields', () => {
		insertProbe(db, makeRow());
		const rows = latestProbesPerCell(db);
		expect(rows[0]).toEqual({
			target_name: 'rutracker',
			path_name: 'direct',
			check_type: 'http_get',
			reached_stage: 'complete',
			first_failure_code: null,
			runtime_ms: 223,
			started_at: '2026-07-01T00:00:00.000Z',
		});
	});

	test('returns an empty array when no probes exist', () => {
		expect(latestProbesPerCell(db)).toEqual([]);
	});
});
