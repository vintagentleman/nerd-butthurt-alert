import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openDatabase } from './db.ts';

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-storage-test-'));
	dbPath = join(tmpDir, 'probes.db');
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('openDatabase', () => {
	// PRAGMA journal_mode = WAL against an in-memory DB reports back "memory",
	// not "wal" — this pragma is only meaningfully testable against a real file.
	test('sets journal_mode to wal on a real file', () => {
		const db = openDatabase(dbPath);
		const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
		expect(row.journal_mode).toBe('wal');
		db.close();
	});

	test('sets foreign_keys on', () => {
		const db = openDatabase(dbPath);
		const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
		expect(row.foreign_keys).toBe(1);
		db.close();
	});

	test('sets synchronous to NORMAL (1)', () => {
		const db = openDatabase(dbPath);
		const row = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
		expect(row.synchronous).toBe(1);
		db.close();
	});

	test('sets busy_timeout to the default of 5000ms', () => {
		const db = openDatabase(dbPath);
		const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
		expect(row.timeout).toBe(5000);
		db.close();
	});

	test('honours a custom busyTimeoutMs argument', () => {
		const db = openDatabase(dbPath, 1234);
		const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
		expect(row.timeout).toBe(1234);
		db.close();
	});
});
