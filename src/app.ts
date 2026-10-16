import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { loadConfig } from './config/load.ts';
import type { AppConfig } from './config/schema.ts';
import { startExporter } from './metrics/exporter.ts';
import type { Metrics } from './metrics/registry.ts';
import { buildRegistry } from './metrics/registry.ts';
import { seedMetrics } from './metrics/seed.ts';
import { applyProbeToMetrics } from './metrics/update.ts';
import type { HttpGetArgs } from './probe/http_get.ts';
import { runHttpGet } from './probe/http_get.ts';
import { mergeProbeConfig } from './probe/probeConfig.ts';
import type { ProbeInsert, ProbeMetricInput, ProbePayload } from './probe/types.ts';
import { startScheduler } from './scheduler/scheduler.ts';
import { openDatabase } from './storage/db.ts';
import { deriveProbeColumns } from './storage/derive.ts';
import { runMigrations } from './storage/migrate.ts';
import { MIGRATIONS } from './storage/migrations/index.ts';
import { insertProbe } from './storage/probes.ts';

const VERSION = '0.0.0';

export interface SweepDeps {
	config: AppConfig;
	db: DatabaseSync;
	metrics: Metrics;
	httpGet: (args: HttpGetArgs) => Promise<ProbePayload>; // injectable for tests
}

/** Pick the 7 fields metrics need off a stored probe row. */
export function toMetricInput(row: ProbeInsert): ProbeMetricInput {
	return {
		target_name: row.target_name,
		path_name: row.path_name,
		check_type: row.check_type,
		reached_stage: row.reached_stage,
		first_failure_code: row.first_failure_code,
		runtime_ms: row.runtime_ms,
		started_at: row.started_at,
	};
}

/** Build a synthetic failure row for a cell whose probe threw before
 *  producing a payload (e.g. runHttpGet itself rejected), so the cell's
 *  gauges still move instead of going stale. */
function buildSyntheticFailureRow(args: {
	targetName: string;
	pathName: string;
	pathRole: AppConfig['paths'][number]['role'];
	checkType: AppConfig['targets'][number]['check_types'][number];
	startedAt: string;
	runtimeMs: number;
}): ProbeInsert {
	return {
		target_name: args.targetName,
		path_name: args.pathName,
		path_role: args.pathRole,
		check_type: args.checkType,
		started_at: args.startedAt,
		runtime_ms: args.runtimeMs,
		reached_stage: 'http_response',
		first_failure_code: 'unknown_failure',
		final_status_code: null,
		impersonation_profile: null,
		payload: JSON.stringify({
			note: 'synthetic failure row: sweep threw before a payload existed',
		}),
	};
}

/** One full sweep: every enabled target × every path it should run on,
 *  http_get only in M1. Each probe is isolated — a throw is caught, logged,
 *  and turned into a failure payload so one bad cell can't sink the sweep. */
export function buildSweep(deps: SweepDeps): () => Promise<void> {
	return async () => {
		for (const target of deps.config.targets) {
			if (!target.enabled) continue;
			if (!target.check_types.includes('http_get')) continue; // M1: http_get is the only check type
			for (const path of deps.config.paths) {
				if (path.role !== 'direct') continue; // M1: direct only
				const pc = mergeProbeConfig(deps.config.probes, target.probe_overrides);
				const startedAt = new Date().toISOString();
				const startTime = performance.now();
				try {
					const payload = await deps.httpGet({
						url: target.url,
						timeoutMs: pc.timeoutMs,
						impersonationProfile: pc.impersonationProfile,
						bodySnippetCapBytes: pc.bodySnippetCapBytes,
						proxyUrl: null,
						path: {
							name: path.name,
							role: path.role,
							tags: Array.isArray(path.tags) ? (path.tags as string[]) : [],
						},
						shape: deps.config.probes.shape_detection,
					});
					const row = deriveProbeColumns({ targetName: target.name, payload });
					insertProbe(deps.db, row);
					applyProbeToMetrics(deps.metrics, toMetricInput(row));
				} catch (err) {
					console.error(
						`sweep: probe failed for target="${target.name}" path="${path.name}"`,
						err,
					);
					const row = buildSyntheticFailureRow({
						targetName: target.name,
						pathName: path.name,
						pathRole: path.role,
						checkType: 'http_get',
						startedAt,
						runtimeMs: Math.round(performance.now() - startTime),
					});
					insertProbe(deps.db, row);
					applyProbeToMetrics(deps.metrics, toMetricInput(row));
				}
			}
		}
	};
}

/** Create the db path's parent directory chain if missing — `openDatabase`
 *  (SQLite) doesn't create it, and `./data/` is gitignored so a fresh
 *  clone/deploy never has it on disk. */
export function ensureParentDir(dbPath: string): void {
	mkdirSync(dirname(dbPath), { recursive: true });
}

export async function main(): Promise<void> {
	const config = loadConfig();
	ensureParentDir(config.storage.db_path);
	const db = openDatabase(config.storage.db_path);
	runMigrations(db, MIGRATIONS);
	const metrics = buildRegistry({ version: VERSION, nodeVersion: process.version });
	seedMetrics(metrics, db);
	startExporter(metrics, config.metrics);
	const sweep = buildSweep({ config, db, metrics, httpGet: runHttpGet });
	startScheduler(config.scheduler.http_get_cadence_seconds, sweep);
	await sweep(); // run once immediately so /metrics is populated before the first tick
}
