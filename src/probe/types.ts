// The M1 subset of the `nba-v0` payload vocabulary — enough for a direct
// `http_get` probe. Per PROBE_PAYLOAD.md, the payload is the *maximum*
// shape: fields CDP can't supply (through a path, or on non-http_get check
// types) are null/absent, never fabricated. CDP-only / non-M1 fields below
// are therefore optional so T6 (http_get producing payloads) can fill only
// the subset it actually measures.

export type CheckType = 'http_get' | 'dns_lookup' | 'tcp_connect';

export type PathRole = 'direct' | 'vantage' | 'obfuscation';

export type ReachedStage =
	| 'dns'
	| 'tcp_connect'
	| 'tls_handshake'
	| 'http_request'
	| 'http_response'
	| 'body_transfer'
	| 'complete';

export type TerminationMode =
	'clean_fin' | 'rst' | 'timeout' | 'tls_close_notify_missing' | 'body_incomplete';

export interface ProbePath {
	name: string;
	role: PathRole;
	tags: string[];
}

// `config` — the probe configuration echo (PROBE_PAYLOAD.md "config — what
// was asked for"). All fields optional here: M1's http_get producer (T6)
// fills a subset; the rest default at the config layer, not the payload.
export interface ProbeConfig {
	method?: string;
	impersonation_profile?: string | null;
	follow_redirects?: boolean;
	max_redirects?: number;
	timeout_ms?: number;
	body_snippet_cap_bytes?: number;
	response_headers_captured?: string[];
	pinned_http_version?: '1.1' | '2' | '3' | null;
}

// Shared per-answer element (PROBE_PAYLOAD.md: shared between
// `http_get.hops[].dns.answers` and `dns_lookup`/`tcp_connect` queries).
export interface DnsAnswer {
	answer_type: 'A' | 'AAAA';
	ipv4?: string;
	ipv6?: string;
	ttl: number;
}

export interface HopDns {
	hostname?: string;
	connected_ip?: string | null;
	engine?: string;
	answers?: DnsAnswer[];
	failure?: string | null;
	offset_ms?: number | null;
}

// Shared per-TCP-attempt record (also used standalone by `tcp_connect`).
export interface TcpAttempt {
	ip: string | null;
	port: number;
	status: { success: boolean; failure: string | null };
	connect_duration_ms?: number | null;
	offset_ms?: number;
}

export interface PeerCertificate {
	data?: string;
	subject_cn?: string;
	subject_alt_names?: string[];
	issuer_cn?: string;
	not_before?: string;
	not_after?: string;
	serial?: string;
	sha256_fingerprint?: string;
}

export interface HopTls {
	server_name?: string;
	tls_version?: string;
	cipher_suite?: string;
	negotiated_protocol?: string;
	alpn_offered?: string[];
	peer_certificates?: PeerCertificate[];
	handshake_duration_ms?: number;
	failure?: string | null;
	offset_ms?: number;
}

export interface HopHttpRequest {
	method?: string;
	http_version?: string;
	header_names?: string[];
	failure?: string | null;
}

export interface HopHttpResponse {
	code?: number;
	http_version?: string;
	headers?: Record<string, string | string[] | null>;
	all_headers?: Record<string, string | string[] | null>;
	ttfb_ms?: number;
	transfer_duration_ms?: number;
	offset_ms?: number;
	failure?: string | null;
}

export interface HopHttp {
	request?: HopHttpRequest;
	response?: HopHttpResponse;
}

export interface BodyShapeSignals {
	is_empty_or_minimal_html?: boolean;
	has_meta_refresh?: boolean;
	meta_refresh_target?: string | null;
	has_js_redirect?: boolean;
	js_redirect_target?: string | null;
	has_noscript_tag?: boolean;
	noscript_text_snippet?: string | null;
	unavailability_phrases_matched?: string[];
}

export interface HopBody {
	metadata?: {
		bytes_received?: number;
		encoded_bytes_received?: number;
		content_length_header?: number | null;
		transfer_encoding?: string;
		content_type_detected?: string | null;
		sha256_full_body?: string;
	};
	snippet?: string;
	snippet_truncated?: boolean;
	snippet_encoding?: 'utf8' | 'base64';
	shape_signals?: BodyShapeSignals;
	failure?: string | null;
}

// One record per redirect hop (PROBE_PAYLOAD.md "hops[] — one record per
// redirect"). Every sub-op block is optional and null-safe — through a
// path, or on a failed probe, most of these collapse to absent/null.
export interface ProbeHop {
	sequence: number;
	url: string;
	dns?: HopDns;
	tcp?: TcpAttempt;
	tls?: HopTls;
	http?: HopHttp;
	body?: HopBody;
	hop_duration_ms?: number;
	failure?: string | null;
}

export interface NetworkEvent {
	offset_ms: number;
	operation: string;
	failure: string | null;
	hop_index: number;
}

export interface RedirectChainEntry {
	url: string;
	// null for intermediate hops: the browser's high-level API doesn't expose
	// their redirect code, and PROBE_PAYLOAD.md forbids fabricating it.
	status: number | null;
}

export interface ProbeRollup {
	final_url?: string;
	final_status_code?: number | null;
	redirect_chain?: RedirectChainEntry[];
	timing_ms?: {
		dns?: number;
		tcp_connect?: number;
		tls_handshake?: number;
		ttfb?: number;
		transfer?: number;
		total?: number;
	};
}

export interface SubresourceEntry {
	url: string;
	type: 'script' | 'stylesheet' | 'font' | 'image' | 'fetch' | 'other';
	reached_stage: ReachedStage;
	first_failure_code: string | null;
	encoded_bytes_received?: number;
	content_length_header?: number | null;
}

export interface ProbeSubresources {
	scope: 'first_party';
	total: number;
	complete: number;
	stalled: number;
	failed: number;
	worst_first_failure_code: string | null;
	stalled_or_failed: SubresourceEntry[];
}

// `data` — check-type-specific measurement content. M1 only produces
// `http_get`; `dns_lookup`/`tcp_connect` data shapes (queries[],
// tcp_connect[]) are later-milestone scope and not modelled yet.
export interface ProbeData {
	config?: ProbeConfig;
	reached_stage: ReachedStage;
	termination_mode?: TerminationMode;
	hops?: ProbeHop[];
	network_events?: NetworkEvent[];
	rollup?: ProbeRollup;
	subresources?: ProbeSubresources;
}

// The `nba-v0` envelope (PROBE_PAYLOAD.md "Common envelope").
export interface ProbePayload {
	schema_version: 'nba-v0';
	check_type: CheckType;
	started_at: string; // ISO 8601 UTC, ms precision
	runtime_ms: number;
	url: string;
	path: ProbePath;
	data: ProbeData;
}

// The flat `probes` row (STORAGE_SCHEMA.md), minus the autoincrement `id`.
export interface ProbeInsert {
	target_name: string;
	path_name: string;
	path_role: PathRole;
	check_type: CheckType;
	started_at: string;
	runtime_ms: number;
	reached_stage: ReachedStage;
	first_failure_code: string | null;
	final_status_code: number | null;
	impersonation_profile: string | null;
	payload: string;
}

// The subset consumed by metrics seeding (T7) and read back via
// `latestProbesPerCell`.
export interface ProbeMetricInput {
	target_name: string;
	path_name: string;
	check_type: CheckType;
	reached_stage: ReachedStage;
	first_failure_code: string | null;
	runtime_ms: number;
	started_at: string;
}
