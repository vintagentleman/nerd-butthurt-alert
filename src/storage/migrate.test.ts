import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openDatabase } from './db.ts';
import { runMigrations } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-storage-test-'));
	dbPath = join(tmpDir, 'probes.db');
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
	return (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
			name: string;
		}[]
	).map((row) => row.name);
}

function indexNames(db: ReturnType<typeof openDatabase>): string[] {
	return (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
			name: string;
		}[]
	).map((row) => row.name);
}

describe('runMigrations', () => {
	test('creates the schema_migrations table', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		expect(tableNames(db)).toContain('schema_migrations');
		db.close();
	});

	test('creates the probes table', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		expect(tableNames(db)).toContain('probes');
		db.close();
	});

	test('creates all three probes indexes', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		const names = indexNames(db);
		expect(names).toContain('idx_probes_target_path_time');
		expect(names).toContain('idx_probes_time');
		expect(names).toContain('idx_probes_failure');
		db.close();
	});

	test('records one schema_migrations row for version 1', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		const rows = db.prepare('SELECT version, applied_at FROM schema_migrations').all() as {
			version: number;
			applied_at: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.version).toBe(1);
		expect(rows[0]?.applied_at).toBeTruthy();
		db.close();
	});

	test('is idempotent: running twice yields exactly one row', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		runMigrations(db, MIGRATIONS);
		const rows = db.prepare('SELECT version FROM schema_migrations').all() as {
			version: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.version).toBe(1);
		db.close();
	});

	test('enforces the path_role CHECK constraint on probes', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		expect(() =>
			db
				.prepare(
					`INSERT INTO probes
						(target_name, path_name, path_role, check_type, started_at, runtime_ms, reached_stage, payload)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					'rutracker',
					'direct',
					'not-a-real-role',
					'http_get',
					'2026-07-01T00:00:00.000Z',
					123,
					'complete',
					'{}',
				),
		).toThrow();
		db.close();
	});

	test('enforces the check_type CHECK constraint on probes', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		expect(() =>
			db
				.prepare(
					`INSERT INTO probes
						(target_name, path_name, path_role, check_type, started_at, runtime_ms, reached_stage, payload)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					'rutracker',
					'direct',
					'direct',
					'not-a-real-check-type',
					'2026-07-01T00:00:00.000Z',
					123,
					'complete',
					'{}',
				),
		).toThrow();
		db.close();
	});

	test('accepts a valid probes row', () => {
		const db = openDatabase(dbPath);
		runMigrations(db, MIGRATIONS);
		expect(() =>
			db
				.prepare(
					`INSERT INTO probes
						(target_name, path_name, path_role, check_type, started_at, runtime_ms, reached_stage, payload)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					'rutracker',
					'direct',
					'direct',
					'http_get',
					'2026-07-01T00:00:00.000Z',
					123,
					'complete',
					'{}',
				),
		).not.toThrow();
		const rows = db.prepare('SELECT * FROM probes').all();
		expect(rows).toHaveLength(1);
		db.close();
	});
});
