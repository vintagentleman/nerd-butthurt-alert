import type { ProbeMetricInput, ReachedStage } from '../probe/types.ts';
import type { Metrics } from './registry.ts';

// The reached_stage ordinal mapping, per OBSERVABILITY.md.
export const STAGE_ORDINAL: Record<ReachedStage, number> = {
	dns: 0,
	tcp_connect: 1,
	tls_handshake: 2,
	http_request: 3,
	http_response: 4,
	body_transfer: 5,
	complete: 6,
};

function cellLabels(p: ProbeMetricInput): { target: string; path: string; check_type: string } {
	return { target: p.target_name, path: p.path_name, check_type: p.check_type };
}

/** Gauges only — used both for seeding and within applyProbeToMetrics. */
export function setProbeGauges(m: Metrics, p: ProbeMetricInput): void {
	const labels = cellLabels(p);
	m.probeUp.set(labels, p.reached_stage === 'complete' && !p.first_failure_code ? 1 : 0);
	m.probeReachedStage.set(labels, STAGE_ORDINAL[p.reached_stage]);
	m.probeLatency.set(labels, p.runtime_ms);
	m.probeLastTimestamp.set(labels, Math.floor(Date.parse(p.started_at) / 1000));
}

/** Full update on a fresh probe: gauges + counters. */
export function applyProbeToMetrics(m: Metrics, p: ProbeMetricInput): void {
	setProbeGauges(m, p);
	const labels = cellLabels(p);
	const outcome = p.first_failure_code ? 'failure' : 'success';
	m.probesTotal.inc({ ...labels, outcome });
	if (p.first_failure_code) m.probeErrors.inc({ ...labels, code: p.first_failure_code });
	m.probeDuration.observe(labels, p.runtime_ms);
}
