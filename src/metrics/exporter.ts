import { createServer, type Server } from 'node:http';

import type { Metrics } from './registry.ts';

export function startExporter(
	m: Metrics,
	opts: { host: string; port: number; path: string },
): Server {
	const server = createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === opts.path) {
			try {
				res.writeHead(200, { 'Content-Type': m.registry.contentType });
				res.end(await m.registry.metrics());
			} catch {
				res.writeHead(500);
				res.end('error');
			}
			return;
		}
		res.writeHead(404).end('not found');
	});
	server.listen(opts.port, opts.host);
	return server;
}
