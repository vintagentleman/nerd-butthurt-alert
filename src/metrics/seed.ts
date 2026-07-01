import type { DatabaseSync } from 'node:sqlite';
import { latestProbesPerCell } from '../storage/probes.ts';
import type { Metrics } from './registry.ts';
import { setProbeGauges } from './update.ts';

/** Replay the latest probe per cell into the gauges at startup, so
 *  /metrics reflects last-known state before the first new sweep. Gauges
 *  only — counters are in-process lifetime and start at zero. */
export function seedMetrics(m: Metrics, db: DatabaseSync): void {
	for (const p of latestProbesPerCell(db)) setProbeGauges(m, p);
}
