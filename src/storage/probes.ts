import type { DatabaseSync } from 'node:sqlite';
import type { ProbeInsert, ProbeMetricInput } from '../probe/types.ts';

export function insertProbe(db: DatabaseSync, row: ProbeInsert): void {
	db.prepare(
		`INSERT INTO probes
			(target_name, path_name, path_role, check_type, started_at, runtime_ms,
			 reached_stage, first_failure_code, final_status_code, impersonation_profile, payload)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.target_name,
		row.path_name,
		row.path_role,
		row.check_type,
		row.started_at,
		row.runtime_ms,
		row.reached_stage,
		row.first_failure_code,
		row.final_status_code,
		row.impersonation_profile,
		row.payload,
	);
}

interface ProbeMetricRow {
	target_name: string;
	path_name: string;
	check_type: string;
	reached_stage: string;
	first_failure_code: string | null;
	runtime_ms: number;
	started_at: string;
}

/** Latest probe per (target_name, path_name, check_type) — the exporter's
 *  gauge seed; uses idx_probes_target_path_time. Exactly one ProbeMetricInput
 *  per cell at MAX(started_at). ROW_NUMBER() with a deterministic
 *  (started_at DESC, id DESC) ordering guarantees one row even when two
 *  probes for the same cell share an identical started_at — the higher id
 *  (later-inserted row) wins the tie. */
export function latestProbesPerCell(db: DatabaseSync): ProbeMetricInput[] {
	const rows = db
		.prepare(
			`SELECT target_name, path_name, check_type, reached_stage,
			        first_failure_code, runtime_ms, started_at
			 FROM (
			   SELECT target_name, path_name, check_type, reached_stage,
			          first_failure_code, runtime_ms, started_at,
			          ROW_NUMBER() OVER (
			            PARTITION BY target_name, path_name, check_type
			            ORDER BY started_at DESC, id DESC
			          ) AS rn
			   FROM probes
			 )
			 WHERE rn = 1`,
		)
		.all() as unknown as ProbeMetricRow[];

	return rows.map((row) => ({
		target_name: row.target_name,
		path_name: row.path_name,
		check_type: row.check_type as ProbeMetricInput['check_type'],
		reached_stage: row.reached_stage as ProbeMetricInput['reached_stage'],
		first_failure_code: row.first_failure_code,
		runtime_ms: row.runtime_ms,
		started_at: row.started_at,
	}));
}
