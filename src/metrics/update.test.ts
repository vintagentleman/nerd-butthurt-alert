import { describe, expect, test } from 'vitest';
import type { ProbeMetricInput } from '../probe/types.ts';
import { buildRegistry } from './registry.ts';
import { applyProbeToMetrics, setProbeGauges, STAGE_ORDINAL } from './update.ts';

function makeProbe(overrides: Partial<ProbeMetricInput> = {}): ProbeMetricInput {
	return {
		target_name: 'rutracker',
		path_name: 'direct',
		check_type: 'http_get',
		reached_stage: 'complete',
		first_failure_code: null,
		runtime_ms: 223,
		started_at: '2026-07-01T00:00:00.000Z',
		...overrides,
	};
}

describe('STAGE_ORDINAL', () => {
	test('maps every ReachedStage to its ordinal per OBSERVABILITY.md', () => {
		expect(STAGE_ORDINAL).toEqual({
			dns: 0,
			tcp_connect: 1,
			tls_handshake: 2,
			http_request: 3,
			http_response: 4,
			body_transfer: 5,
			complete: 6,
		});
	});
});

describe('setProbeGauges', () => {
	test('sets probe_up=1 for a completed probe with no failure', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe());
		const text = await m.registry.metrics();
		expect(text).toContain(
			'nba_probe_up{target="rutracker",path="direct",check_type="http_get"} 1',
		);
	});

	test('sets probe_up=0 for a probe with a first_failure_code even if reached_stage is complete', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe({ first_failure_code: 'connection_refused' }));
		const text = await m.registry.metrics();
		expect(text).toContain(
			'nba_probe_up{target="rutracker",path="direct",check_type="http_get"} 0',
		);
	});

	test('sets probe_up=0 for a probe that did not reach complete', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(
			m,
			makeProbe({ reached_stage: 'tcp_connect', first_failure_code: 'connection_refused' }),
		);
		const text = await m.registry.metrics();
		expect(text).toContain(
			'nba_probe_up{target="rutracker",path="direct",check_type="http_get"} 0',
		);
	});

	test('sets probe_reached_stage to the correct ordinal', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe({ reached_stage: 'tls_handshake' }));
		const text = await m.registry.metrics();
		expect(text).toContain(
			'nba_probe_reached_stage{target="rutracker",path="direct",check_type="http_get"} 2',
		);
	});

	test('sets probe_latency_ms to runtime_ms', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe({ runtime_ms: 512 }));
		const text = await m.registry.metrics();
		expect(text).toContain(
			'nba_probe_latency_ms{target="rutracker",path="direct",check_type="http_get"} 512',
		);
	});

	test('sets probe_last_timestamp_seconds from started_at', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe({ started_at: '2026-07-01T00:00:00.000Z' }));
		const text = await m.registry.metrics();
		const expected = Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000);
		expect(text).toContain(
			`nba_probe_last_timestamp_seconds{target="rutracker",path="direct",check_type="http_get"} ${expected}`,
		);
	});

	test('does not touch counters', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		setProbeGauges(m, makeProbe());
		const text = await m.registry.metrics();
		expect(text).not.toContain('nba_probes_total{target="rutracker"');
	});
});

describe('applyProbeToMetrics', () => {
	test('success probe: sets up=1 and increments probes_total{outcome="success"}', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		applyProbeToMetrics(m, makeProbe());
		const text = await m.registry.metrics();

		expect(text).toContain(
			'nba_probe_up{target="rutracker",path="direct",check_type="http_get"} 1',
		);
		expect(text).toContain(
			'nba_probes_total{target="rutracker",path="direct",check_type="http_get",outcome="success"} 1',
		);
		expect(text).not.toContain('nba_probe_errors_total{target="rutracker"');
	});

	test('failure probe: sets up=0, increments probes_total{outcome="failure"} and probe_errors_total{code}', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		applyProbeToMetrics(
			m,
			makeProbe({
				reached_stage: 'tcp_connect',
				first_failure_code: 'connection_refused',
			}),
		);
		const text = await m.registry.metrics();

		expect(text).toContain(
			'nba_probe_up{target="rutracker",path="direct",check_type="http_get"} 0',
		);
		expect(text).toContain(
			'nba_probe_reached_stage{target="rutracker",path="direct",check_type="http_get"} 1',
		);
		expect(text).toContain(
			'nba_probes_total{target="rutracker",path="direct",check_type="http_get",outcome="failure"} 1',
		);
		expect(text).toContain(
			'nba_probe_errors_total{target="rutracker",path="direct",check_type="http_get",code="connection_refused"} 1',
		);
	});

	test('observes runtime_ms into the duration histogram', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		applyProbeToMetrics(m, makeProbe({ runtime_ms: 223 }));
		const text = await m.registry.metrics();

		expect(text).toContain(
			'nba_probe_duration_ms_bucket{le="250",target="rutracker",path="direct",check_type="http_get"} 1',
		);
		expect(text).toContain(
			'nba_probe_duration_ms_sum{target="rutracker",path="direct",check_type="http_get"} 223',
		);
	});

	test('two probes accumulate the counter across calls', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		applyProbeToMetrics(m, makeProbe());
		applyProbeToMetrics(m, makeProbe());
		const text = await m.registry.metrics();

		expect(text).toContain(
			'nba_probes_total{target="rutracker",path="direct",check_type="http_get",outcome="success"} 2',
		);
	});
});
