import type { Server } from 'node:http';
import { createServer } from 'node:http';

// A tiny node:http fixture for http_get.test.ts (T6) and the T10 sweep
// integration test. Routes:
//   /ok       -> 200 with a small HTML body
//   /redirect -> 302 Location: /ok
// An address with nothing listening (see `unusedPort` below) is used
// separately by tests that want a deterministic ERR_CONNECTION_REFUSED —
// this fixture doesn't need to simulate that itself.
export interface TestServer {
	url: string;
	close: () => Promise<void>;
}

const OK_BODY = '<html><body><h1>ok</h1></body></html>';

export async function startTestServer(): Promise<TestServer> {
	const server: Server = createServer((req, res) => {
		const path = req.url ?? '/';
		if (path === '/redirect') {
			res.statusCode = 302;
			res.setHeader('location', '/ok');
			res.end();
			return;
		}
		if (path === '/ok') {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/html');
			res.end(OK_BODY);
			return;
		}
		res.statusCode = 404;
		res.end();
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('test server did not bind to a network port');
	}

	const url = `http://127.0.0.1:${String(address.port)}`;

	return {
		url,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			}),
	};
}

/** Find a `127.0.0.1` TCP port nothing is listening on, for tests that want
 *  a deterministic `ERR_CONNECTION_REFUSED` (bind, grab the port, close). */
export async function findUnusedPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => {
		probe.listen(0, '127.0.0.1', resolve);
	});
	const address = probe.address();
	if (address === null || typeof address === 'string') {
		throw new Error('port probe did not bind to a network port');
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => {
		probe.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
	return port;
}
