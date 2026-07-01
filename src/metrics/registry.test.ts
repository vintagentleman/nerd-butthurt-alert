import { describe, expect, test } from 'vitest';
import { buildRegistry } from './registry.ts';

describe('buildRegistry', () => {
	test('exposes every nba_* series name in the scraped exposition text', async () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		const text = await m.registry.metrics();

		expect(text).toContain('nba_probe_up');
		expect(text).toContain('nba_probe_reached_stage');
		expect(text).toContain('nba_probe_latency_ms');
		expect(text).toContain('nba_probe_duration_ms');
		expect(text).toContain('nba_probe_last_timestamp_seconds');
		expect(text).toContain('nba_probes_total');
		expect(text).toContain('nba_probe_errors_total');
		expect(text).toContain('nba_build_info');
	});

	test('sets nba_build_info{version, node_version} to 1', async () => {
		const m = buildRegistry({ version: '1.2.3', nodeVersion: 'v26.4.0' });
		const text = await m.registry.metrics();

		expect(text).toContain('nba_build_info{version="1.2.3",node_version="v26.4.0"} 1');
	});

	test('returns a Metrics object exposing all registered instruments', () => {
		const m = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });

		expect(m.probeUp).toBeDefined();
		expect(m.probeReachedStage).toBeDefined();
		expect(m.probeLatency).toBeDefined();
		expect(m.probeDuration).toBeDefined();
		expect(m.probeLastTimestamp).toBeDefined();
		expect(m.probesTotal).toBeDefined();
		expect(m.probeErrors).toBeDefined();
		expect(m.buildInfo).toBeDefined();
	});

	test('each buildRegistry call produces an independent registry (no cross-instance leakage)', async () => {
		const a = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });
		const b = buildRegistry({ version: '0.0.0', nodeVersion: 'v26.4.0' });

		a.probesTotal.inc({
			target: 't',
			path: 'direct',
			check_type: 'http_get',
			outcome: 'success',
		});

		const bText = await b.registry.metrics();
		expect(bText).not.toContain('nba_probes_total{target="t"');
	});
});
