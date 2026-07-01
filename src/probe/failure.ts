import type { ReachedStage } from './types.ts';

export interface MappedFailure {
	first_failure_code: string;
	reached_stage: ReachedStage;
}

// PROBE_PAYLOAD.md "Deriving the taxonomy from CDP (http_get)": on a failed
// `http_get`, CDP emits only `Network.loadingFailed.errorText` (a
// `net::ERR_*` string) and no partial hop/timing record, so both
// `first_failure_code` and `reached_stage` are derived solely from that
// string. Keyed by the exact ERR_* token; order matters only for tokens
// that share a prefix (ERR_CONNECTION_*), and those are listed as distinct
// full tokens below so a substring search can't shadow one with another.
const ERR_TABLE: Record<string, MappedFailure> = {
	ERR_PROXY_CONNECTION_FAILED: {
		first_failure_code: 'proxy_connection_failed',
		reached_stage: 'dns',
	},
	ERR_NAME_NOT_RESOLVED: { first_failure_code: 'dns_nxdomain', reached_stage: 'dns' },
	ERR_CONNECTION_REFUSED: {
		first_failure_code: 'connection_refused',
		reached_stage: 'tcp_connect',
	},
	ERR_CONNECTION_TIMED_OUT: {
		first_failure_code: 'connection_timeout',
		reached_stage: 'tcp_connect',
	},
	ERR_TIMED_OUT: { first_failure_code: 'connection_timeout', reached_stage: 'tcp_connect' },
	ERR_CONNECTION_RESET: {
		first_failure_code: 'tls_closed_during_handshake',
		reached_stage: 'tls_handshake',
	},
	ERR_SSL_PROTOCOL_ERROR: {
		first_failure_code: 'tls_handshake_failed',
		reached_stage: 'tls_handshake',
	},
	ERR_CERT_DATE_INVALID: {
		first_failure_code: 'tls_cert_expired',
		reached_stage: 'tls_handshake',
	},
	ERR_CERT_AUTHORITY_INVALID: {
		first_failure_code: 'tls_cert_unknown_ca',
		reached_stage: 'tls_handshake',
	},
	ERR_CERT_COMMON_NAME_INVALID: {
		first_failure_code: 'tls_cert_hostname_mismatch',
		reached_stage: 'tls_handshake',
	},
	ERR_EMPTY_RESPONSE: {
		first_failure_code: 'http_body_truncated',
		reached_stage: 'body_transfer',
	},
};

// Longest token first: `ERR_CONNECTION_TIMED_OUT` must be tested before
// `ERR_TIMED_OUT` would ever get a chance to match a substring of it, and
// before any looser `ERR_CONNECTION_` prefix could shadow the more specific
// `ERR_CONNECTION_RESET` / `ERR_CONNECTION_REFUSED` tokens. Since every key
// here is matched as an exact, non-overlapping token, sorting by length
// (longest first) is sufficient to make the search order-independent.
const ERR_TOKENS = Object.keys(ERR_TABLE).sort((a, b) => b.length - a.length);

const UNKNOWN_FAILURE: MappedFailure = {
	first_failure_code: 'unknown_failure',
	reached_stage: 'http_response',
};

// Playwright's navigation `TimeoutError` (e.g. "Timeout 10000ms exceeded.")
// is not a `net::ERR_*` string — it fires when the commit deadline passes
// before any response, so per spec it maps to `http_response_timeout` /
// `http_request`, not the generic unknown-failure floor.
const TIMEOUT_ERROR_PATTERN = /Timeout \d+ms exceeded/;

/** Map a Chromium net::ERR_* string (or Playwright error text) to our
 *  failure code + the stage we reached. Table per PROBE_PAYLOAD.md. */
export function mapNetError(errorText: string): MappedFailure {
	for (const token of ERR_TOKENS) {
		if (errorText.includes(token)) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- token is drawn from ERR_TABLE's own keys
			return ERR_TABLE[token]!;
		}
	}

	if (TIMEOUT_ERROR_PATTERN.test(errorText)) {
		return { first_failure_code: 'http_response_timeout', reached_stage: 'http_request' };
	}

	return UNKNOWN_FAILURE;
}
