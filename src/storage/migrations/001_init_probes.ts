import type { Migration } from '../migrate.ts';

// The `probes` table + indexes, exactly per STORAGE_SCHEMA.md. Hot columns
// duplicate fields already present in `payload` for query speed; the full
// probe record (including termination_mode, DNS answers, cert chains, etc.)
// lives only in the JSON `payload` column, not as additional hot columns.
const migration001: Migration = {
	version: 1,
	name: 'init_probes',
	up(db): void {
		db.exec(`
			CREATE TABLE probes (
				id                    INTEGER PRIMARY KEY AUTOINCREMENT,
				target_name           TEXT    NOT NULL,       -- denormalised; the config target's name
				path_name             TEXT    NOT NULL,       -- from payload.path.name
				path_role             TEXT    NOT NULL        -- from payload.path.role
				                        CHECK (path_role IN ('direct','vantage','obfuscation')),
				check_type            TEXT    NOT NULL
				                        CHECK (check_type IN ('http_get','dns_lookup','tcp_connect')),
				started_at            TEXT    NOT NULL,       -- ISO 8601 UTC; mirrors payload.started_at
				runtime_ms            INTEGER NOT NULL,       -- mirrors payload.runtime_ms
				reached_stage         TEXT    NOT NULL,       -- payload.data.reached_stage
				first_failure_code    TEXT,                    -- derived; NULL on full success
				final_status_code     INTEGER,                 -- http_get only; else NULL
				impersonation_profile TEXT,                    -- http_get only; else NULL
				payload               TEXT    NOT NULL         -- full JSON per PROBE_PAYLOAD.md
			);

			CREATE INDEX idx_probes_target_path_time
				ON probes (target_name, path_name, check_type, started_at DESC);
			CREATE INDEX idx_probes_time
				ON probes (started_at DESC);
			CREATE INDEX idx_probes_failure
				ON probes (first_failure_code)
				WHERE first_failure_code IS NOT NULL;
		`);
	},
};

export default migration001;
