import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRegistry } from './registry.ts';
import { startExporter } from './exporter.ts';

describe('exporter', () => {
	const servers: Server[] = [];

	afterEach(async () => {
		for (const s of servers) {
			await new Promise<void>((resolve) => {
				s.close(() => {
					resolve();
				});
			});
		}
		servers.length = 0;
	});

	it('GET /metrics returns 200 with metrics and correct Content-Type', async () => {
		const metrics = buildRegistry({ version: '0.0.0', nodeVersion: process.version });
		const server = startExporter(metrics, { host: '127.0.0.1', port: 0, path: '/metrics' });
		servers.push(server);

		const addr = await new Promise<AddressInfo>((resolve) => {
			server.once('listening', () => {
				const address = server.address();
				if (address && typeof address !== 'string') {
					resolve(address as AddressInfo);
				}
			});
		});

		const url = `http://127.0.0.1:${addr.port}/metrics`;

		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe(metrics.registry.contentType);

		const body = await res.text();
		expect(body).toContain('nba_build_info');
	});

	it('GET /wrong-path returns 404', async () => {
		const metrics = buildRegistry({ version: '0.0.0', nodeVersion: process.version });
		const server = startExporter(metrics, { host: '127.0.0.1', port: 0, path: '/metrics' });
		servers.push(server);

		const addr = await new Promise<AddressInfo>((resolve) => {
			server.once('listening', () => {
				const address = server.address();
				if (address && typeof address !== 'string') {
					resolve(address as AddressInfo);
				}
			});
		});

		const url = `http://127.0.0.1:${addr.port}/nope`;

		const res = await fetch(url);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toBe('not found');
	});
});
