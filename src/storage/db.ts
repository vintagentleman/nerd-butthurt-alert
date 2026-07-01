import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string, busyTimeoutMs = 5000): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec('PRAGMA journal_mode = WAL;'); // load-bearing: concurrent Grafana reads
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)};`);
	return db;
}
