import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// The full `nba_*` metric inventory (OBSERVABILITY.md "Metric inventory").
// One Registry per buildRegistry() call — no shared/default registry, so
// tests (and, eventually, process restarts within the same runtime) never
// leak series across instances.
export interface Metrics {
	registry: Registry;
	probeUp: Gauge;
	probeReachedStage: Gauge;
	probeLatency: Gauge;
	probeDuration: Histogram;
	probeLastTimestamp: Gauge;
	probesTotal: Counter;
	probeErrors: Counter;
	buildInfo: Gauge;
}

const CELL_LABELS = ['target', 'path', 'check_type'] as const;

// OBSERVABILITY.md leaves histogram buckets open ("generic latency set,
// tune later") — this is that explicit ms-latency set.
const DURATION_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export function buildRegistry(opts: { version: string; nodeVersion: string }): Metrics {
	const registry = new Registry();

	const probeUp = new Gauge({
		name: 'nba_probe_up',
		help: '1 when the last probe reached complete with no failure; else 0.',
		labelNames: CELL_LABELS,
		registers: [registry],
	});

	const probeReachedStage = new Gauge({
		name: 'nba_probe_reached_stage',
		help: "Ordinal of the last probe's reached_stage.",
		labelNames: CELL_LABELS,
		registers: [registry],
	});

	const probeLatency = new Gauge({
		name: 'nba_probe_latency_ms',
		help: "Last probe's runtime_ms.",
		labelNames: CELL_LABELS,
		registers: [registry],
	});

	const probeDuration = new Histogram({
		name: 'nba_probe_duration_ms',
		help: 'Distribution of runtime_ms.',
		labelNames: CELL_LABELS,
		buckets: DURATION_BUCKETS_MS,
		registers: [registry],
	});

	const probeLastTimestamp = new Gauge({
		name: 'nba_probe_last_timestamp_seconds',
		help: 'Unix time of the last probe.',
		labelNames: CELL_LABELS,
		registers: [registry],
	});

	const probesTotal = new Counter({
		name: 'nba_probes_total',
		help: 'Count of probes by outcome.',
		labelNames: [...CELL_LABELS, 'outcome'],
		registers: [registry],
	});

	const probeErrors = new Counter({
		name: 'nba_probe_errors_total',
		help: 'Count of probes by first_failure_code.',
		labelNames: [...CELL_LABELS, 'code'],
		registers: [registry],
	});

	const buildInfo = new Gauge({
		name: 'nba_build_info',
		help: 'Always 1; carries build metadata as labels.',
		labelNames: ['version', 'node_version'],
		registers: [registry],
	});
	buildInfo.set({ version: opts.version, node_version: opts.nodeVersion }, 1);

	return {
		registry,
		probeUp,
		probeReachedStage,
		probeLatency,
		probeDuration,
		probeLastTimestamp,
		probesTotal,
		probeErrors,
		buildInfo,
	};
}
