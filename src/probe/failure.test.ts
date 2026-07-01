import { describe, expect, test } from 'vitest';
import type { ReachedStage } from './types.ts';
import { mapNetError } from './failure.ts';

// Table-driven per PROBE_PAYLOAD.md "Deriving the taxonomy from CDP
// (http_get)". Each errorText mirrors how Playwright actually surfaces a
// net::ERR_* code: embedded inside a longer navigation-failure message,
// never bare.
const cases: {
	errorText: string;
	first_failure_code: string;
	reached_stage: ReachedStage;
}[] = [
	{
		errorText: 'page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://example.com/',
		first_failure_code: 'proxy_connection_failed',
		reached_stage: 'dns',
	},
	{
		errorText: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/',
		first_failure_code: 'dns_nxdomain',
		reached_stage: 'dns',
	},
	{
		errorText: 'page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/',
		first_failure_code: 'connection_refused',
		reached_stage: 'tcp_connect',
	},
	{
		errorText: 'page.goto: net::ERR_CONNECTION_TIMED_OUT at https://example.com/',
		first_failure_code: 'connection_timeout',
		reached_stage: 'tcp_connect',
	},
	{
		errorText: 'page.goto: net::ERR_TIMED_OUT at https://example.com/',
		first_failure_code: 'connection_timeout',
		reached_stage: 'tcp_connect',
	},
	{
		errorText: 'page.goto: net::ERR_CONNECTION_RESET at https://example.com/',
		first_failure_code: 'tls_closed_during_handshake',
		reached_stage: 'tls_handshake',
	},
	{
		errorText: 'page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://example.com/',
		first_failure_code: 'tls_handshake_failed',
		reached_stage: 'tls_handshake',
	},
	{
		errorText: 'page.goto: net::ERR_CERT_DATE_INVALID at https://example.com/',
		first_failure_code: 'tls_cert_expired',
		reached_stage: 'tls_handshake',
	},
	{
		errorText: 'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://example.com/',
		first_failure_code: 'tls_cert_unknown_ca',
		reached_stage: 'tls_handshake',
	},
	{
		errorText: 'page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://example.com/',
		first_failure_code: 'tls_cert_hostname_mismatch',
		reached_stage: 'tls_handshake',
	},
	{
		errorText: 'page.goto: net::ERR_EMPTY_RESPONSE at https://example.com/',
		first_failure_code: 'http_body_truncated',
		reached_stage: 'body_transfer',
	},
];

describe('mapNetError', () => {
	for (const { errorText, first_failure_code, reached_stage } of cases) {
		test(`${errorText} -> ${first_failure_code} / ${reached_stage}`, () => {
			expect(mapNetError(errorText)).toEqual({ first_failure_code, reached_stage });
		});
	}

	test('Playwright navigation TimeoutError (no net::ERR_ token) maps to http_response_timeout / http_request', () => {
		expect(mapNetError('Timeout 10000ms exceeded.')).toEqual({
			first_failure_code: 'http_response_timeout',
			reached_stage: 'http_request',
		});
	});

	test('unrecognized net::ERR_* token falls through to unknown_failure / http_response', () => {
		expect(mapNetError('page.goto: net::ERR_SOMETHING_NEW at https://example.com/')).toEqual({
			first_failure_code: 'unknown_failure',
			reached_stage: 'http_response',
		});
	});

	test('ERR_UNSAFE_PORT falls through to unknown_failure in M1 (no special-casing)', () => {
		expect(mapNetError('page.goto: net::ERR_UNSAFE_PORT at https://example.com/')).toEqual({
			first_failure_code: 'unknown_failure',
			reached_stage: 'http_response',
		});
	});

	test('completely unrelated error text falls through to unknown_failure / http_response', () => {
		expect(mapNetError('some unrelated error')).toEqual({
			first_failure_code: 'unknown_failure',
			reached_stage: 'http_response',
		});
	});

	test('ERR_CONNECTION_RESET is not confused with ERR_CONNECTION_REFUSED', () => {
		const reset = mapNetError('net::ERR_CONNECTION_RESET at https://example.com/');
		const refused = mapNetError('net::ERR_CONNECTION_REFUSED at https://example.com/');
		expect(reset.first_failure_code).toBe('tls_closed_during_handshake');
		expect(refused.first_failure_code).toBe('connection_refused');
	});

	test('ERR_CONNECTION_RESET is not confused with ERR_CONNECTION_TIMED_OUT', () => {
		const reset = mapNetError('net::ERR_CONNECTION_RESET at https://example.com/');
		const timedOut = mapNetError('net::ERR_CONNECTION_TIMED_OUT at https://example.com/');
		expect(reset.first_failure_code).toBe('tls_closed_during_handshake');
		expect(timedOut.first_failure_code).toBe('connection_timeout');
	});

	test('ERR_CONNECTION_TIMED_OUT is not shadowed by a looser ERR_CONNECTION_ prefix match', () => {
		expect(mapNetError('net::ERR_CONNECTION_TIMED_OUT at https://example.com/')).toEqual({
			first_failure_code: 'connection_timeout',
			reached_stage: 'tcp_connect',
		});
	});
});
