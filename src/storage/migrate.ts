import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
	version: number;
	name: string; // for logging only — not stored (schema_migrations has no name column)
	up(db: DatabaseSync): void;
}

export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL          -- ISO 8601 UTC
	);`);
	const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
	const applied = new Set(rows.map((row) => row.version));
	for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
		if (applied.has(migration.version)) continue;
		migration.up(db);
		db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
			migration.version,
			new Date().toISOString(),
		);
	}
}
