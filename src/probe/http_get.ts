import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import { mapNetError } from './failure.ts';
import { detectShapeSignals } from './shape.ts';
import type { ShapeDetectionConfig } from './shape.ts';
import type { PathRole, ProbeHop, ProbePayload, RedirectChainEntry } from './types.ts';

export interface HttpGetArgs {
	url: string;
	timeoutMs: number;
	impersonationProfile: string; // recorded into the payload; M1 always launches Chromium
	bodySnippetCapBytes: number; // cap on the stored body snippet
	proxyUrl: string | null; // null on direct path
	path: { name: string; role: PathRole; tags: string[] };
	shape: ShapeDetectionConfig;
}

/** Walk `redirectedFrom()` back from the final request to build the
 *  envelope-level redirect chain (oldest first). Per PROBE_PAYLOAD.md
 *  `rollup.redirect_chain`: `{ url, status }` per hop. Only the final hop's
 *  status is known here — it's the terminal response's status. The
 *  intermediate hops' own redirect codes (301/302/307/308) are NOT exposed
 *  on the intermediate `Request` via Playwright's high-level API, so per
 *  the "never fabricated" rule they are recorded as `null` rather than
 *  guessed at `302` (recovering real intermediate codes needs per-request
 *  response walking — M2 fidelity, out of M1 scope). */
function buildRedirectChain(finalResponse: Response): RedirectChainEntry[] {
	const urls: string[] = [];
	let current: Request | null = finalResponse.request();
	while (current) {
		urls.unshift(current.url());
		current = current.redirectedFrom();
	}
	const finalStatus = finalResponse.status();
	return urls.map((url, index) => ({
		url,
		status: index === urls.length - 1 ? finalStatus : null,
	}));
}

function truncateSnippet(body: string, capBytes: number): { snippet: string; truncated: boolean } {
	const buf = Buffer.from(body, 'utf8');
	if (buf.byteLength <= capBytes) {
		return { snippet: body, truncated: false };
	}
	return { snippet: buf.subarray(0, capBytes).toString('utf8'), truncated: true };
}

async function buildSuccessPayload(args: {
	resp: Response;
	startedAt: string;
	runtimeMs: number;
	httpGetArgs: HttpGetArgs;
}): Promise<ProbePayload> {
	const { resp, startedAt, runtimeMs, httpGetArgs } = args;

	const bodyBuffer = await resp.body().catch(() => Buffer.alloc(0));
	const bodyText = bodyBuffer.toString('utf8');
	const { snippet, truncated } = truncateSnippet(bodyText, httpGetArgs.bodySnippetCapBytes);
	const shapeSignals = detectShapeSignals(bodyText, bodyBuffer.byteLength, httpGetArgs.shape);

	const securityDetails = await resp.securityDetails().catch(() => null);
	const timing = resp.request().timing();

	const hop: ProbeHop = {
		sequence: 0,
		url: resp.url(),
		tls: resp.url().startsWith('https:')
			? {
					server_name: new URL(resp.url()).hostname,
					tls_version: securityDetails?.protocol,
					negotiated_protocol: undefined,
					failure: null,
				}
			: undefined,
		http: {
			request: {
				method: 'GET',
				failure: null,
			},
			response: {
				code: resp.status(),
				headers: resp.headers(),
				ttfb_ms:
					Number.isFinite(timing.responseStart) && timing.responseStart >= 0
						? Math.round(timing.responseStart)
						: undefined,
				transfer_duration_ms:
					Number.isFinite(timing.responseEnd) &&
					Number.isFinite(timing.responseStart) &&
					timing.responseEnd >= 0 &&
					timing.responseStart >= 0
						? Math.round(timing.responseEnd - timing.responseStart)
						: undefined,
				failure: null,
			},
		},
		body: {
			metadata: {
				bytes_received: bodyBuffer.byteLength,
			},
			snippet,
			snippet_truncated: truncated,
			snippet_encoding: 'utf8',
			shape_signals: shapeSignals,
			failure: null,
		},
		hop_duration_ms: runtimeMs,
		failure: null,
	};

	const redirectChain = buildRedirectChain(resp);

	return {
		schema_version: 'nba-v0',
		check_type: 'http_get',
		started_at: startedAt,
		runtime_ms: runtimeMs,
		url: httpGetArgs.url,
		path: httpGetArgs.path,
		data: {
			config: {
				method: 'GET',
				impersonation_profile: httpGetArgs.impersonationProfile,
				follow_redirects: true,
				timeout_ms: httpGetArgs.timeoutMs,
				body_snippet_cap_bytes: httpGetArgs.bodySnippetCapBytes,
				pinned_http_version: null,
			},
			reached_stage: 'complete',
			termination_mode: 'clean_fin',
			hops: [hop],
			network_events: [],
			rollup: {
				final_url: resp.url(),
				final_status_code: resp.status(),
				redirect_chain: redirectChain,
			},
		},
	};
}

function buildFailurePayload(args: {
	url: string;
	startedAt: string;
	runtimeMs: number;
	httpGetArgs: HttpGetArgs;
	rawErrorText: string;
}): ProbePayload {
	const { url, startedAt, runtimeMs, httpGetArgs, rawErrorText } = args;
	const mapped = mapNetError(rawErrorText);

	// Place the failure on the sub-op matching the inferred stage, so
	// `deriveFirstFailureCode` (storage/derive.ts) recovers it by walking
	// [dns, tcp.status, tls, http.request, http.response, body] in order.
	const hop: ProbeHop = { sequence: 0, url, failure: mapped.first_failure_code };
	switch (mapped.reached_stage) {
		case 'dns':
			hop.dns = { failure: mapped.first_failure_code };
			break;
		case 'tcp_connect':
			hop.tcp = {
				ip: null,
				port: 0,
				status: { success: false, failure: mapped.first_failure_code },
			};
			break;
		case 'tls_handshake':
			hop.tls = { failure: mapped.first_failure_code };
			break;
		case 'http_request':
			hop.http = { request: { failure: mapped.first_failure_code } };
			break;
		case 'http_response':
		default:
			hop.http = { request: {}, response: { failure: mapped.first_failure_code } };
			break;
		case 'body_transfer':
			hop.body = { failure: mapped.first_failure_code };
			break;
	}

	const terminationMode = mapped.first_failure_code === 'connection_timeout' ? 'timeout' : 'rst';

	return {
		schema_version: 'nba-v0',
		check_type: 'http_get',
		started_at: startedAt,
		runtime_ms: runtimeMs,
		url,
		path: httpGetArgs.path,
		data: {
			config: {
				method: 'GET',
				impersonation_profile: httpGetArgs.impersonationProfile,
				follow_redirects: true,
				timeout_ms: httpGetArgs.timeoutMs,
				body_snippet_cap_bytes: httpGetArgs.bodySnippetCapBytes,
				pinned_http_version: null,
			},
			reached_stage: mapped.reached_stage,
			termination_mode: terminationMode,
			hops: [hop],
			network_events: [
				{
					offset_ms: runtimeMs,
					operation: 'navigation_failed',
					failure: rawErrorText,
					hop_index: 0,
				},
			],
			rollup: {
				final_status_code: null,
				redirect_chain: [],
			},
		},
	};
}

function errorTextOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Run one `http_get` probe over the direct path (M1: Chromium headless
 *  only, high-level Playwright API — no CDP). Per PROBE_PAYLOAD.md, always
 *  returns a payload: success or failure both produce a full `nba-v0`
 *  envelope, never a thrown error. */
export async function runHttpGet(args: HttpGetArgs): Promise<ProbePayload> {
	const startedAt = new Date().toISOString();
	const startTime = performance.now();

	const browser = await chromium.launch({
		headless: true,
		...(args.proxyUrl ? { proxy: { server: args.proxyUrl } } : {}),
	});
	try {
		const ctx = await browser.newContext(); // the browser IS the browser — no UA spoofing
		try {
			const page = await ctx.newPage();
			try {
				const resp = await page.goto(args.url, {
					timeout: args.timeoutMs,
					waitUntil: 'commit',
				});
				const runtimeMs = Math.round(performance.now() - startTime);

				if (resp === null) {
					return buildFailurePayload({
						url: args.url,
						startedAt,
						runtimeMs,
						httpGetArgs: args,
						rawErrorText: 'page.goto returned null response',
					});
				}

				return await buildSuccessPayload({ resp, startedAt, runtimeMs, httpGetArgs: args });
			} catch (err) {
				const runtimeMs = Math.round(performance.now() - startTime);
				return buildFailurePayload({
					url: args.url,
					startedAt,
					runtimeMs,
					httpGetArgs: args,
					rawErrorText: errorTextOf(err),
				});
			}
		} finally {
			await ctx.close();
		}
	} finally {
		await browser.close();
	}
}
