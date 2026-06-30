# Probe Payload Specification (v0)

## What this document is

A companion to `ARCHITECTURE.md`. It specifies the JSON shape of probe
outcomes — what the probe engine emits and what the storage layer
persists. Every scheduler tick produces one probe record per
`(target, path, check_type)` triple; this document says what that
record looks like.

OONI's `web_connectivity` nettest schema (`github.com/ooni/spec`) was
a point of reference during design. The envelope is our own; OONI
influence survives only in the **per-operation record** vocabulary —
`failure` strings, `peer_certificates`, `negotiated_protocol`.
Structure follows Playwright's natural per-request event emission
(per-hop records) rather than OONI's cross-op parallel-array layout,
because reshaping CDP events into OONI arrays would cost real
transformation effort for no interop gain. The payload is **not
OONI-compliant** by design; the `schema_version` string (`"nba-v0"`)
makes that explicit.

## What CDP actually exposes

The `http_get` evidence model below is constrained by what Chromium's
CDP genuinely emits — verified empirically, direct *and* through a
SOCKS5 proxy. Two findings shape everything downstream:

1. **CDP exposes no resolver answer set.** There is no DNS answers /
   TTL data anywhere in CDP — only a single connected `remoteIPAddress`.
   And **through a SOCKS5 path that IP is the proxy's, not the
   target's** (Chromium does proxy-side resolution; `dnsStart`/`dnsEnd`
   come back `-1` and the connect phase is opaque). So an `http_get`
   hop cannot carry DNS answers, and through a path it cannot carry the
   target IP or a DNS/TCP timing split at all. Real per-path DNS
   evidence comes from the dedicated `dns_lookup` check, not from
   `http_get`.

2. **Everything from TLS upward survives a path**, because TLS is
   end-to-end through the tunnel: TLS version, cipher, key exchange,
   ALPN (`negotiated_protocol`), the full peer-certificate chain as DER
   (via the CDP `Network.getCertificate({origin})` method — note
   `securityDetails` alone is parsed-only, `certificateId: 0`), HTTP
   status, full response headers (incl. an overflow dict via
   `Network.responseReceivedExtraInfo`), body, redirect hops (via
   `redirectResponse`), and total wall-clock timing.

Capability matrix (✅ available, ❌ not):

| Evidence | Direct `http_get` | `http_get` via path |
|---|---|---|
| HTTP status, redirect hops, headers, body | ✅ | ✅ |
| TLS version / cipher / ALPN | ✅ | ✅ |
| Peer-cert chain (DER, via `getCertificate`) | ✅ | ✅ |
| Total timing | ✅ | ✅ |
| DNS / TCP / TLS timing *phases* | ✅ | ❌ (collapsed) |
| Connected target IP | ✅ | ❌ (= the proxy) |
| DNS answer set + TTLs | ❌ | ❌ |

The hop-schema fields this table marks ❌ are populated best-effort and
are `null` / empty when CDP doesn't supply them — the schema describes
the *maximum* shape, not a per-probe guarantee.

## Overview: three check types

Every probe is typed. Three check types exist in v1:

- **`http_get`** — the rich probe. Fetches the target URL through the
  configured path, capturing TLS, HTTP, body, and termination details
  *per hop* (each redirect is its own hop), plus whatever DNS/TCP
  detail CDP exposes (timing + connected IP on a direct probe; little
  to nothing through a path — see the capability matrix above). Backed
  by Playwright (headless Chromium / Firefox / WebKit) so the emitted
  traffic is that of a real browser, not a spoofing layer.
- **`dns_lookup`** — standalone DNS resolution. No TCP, no TLS, no
  HTTP. Cheap, isolates DNS-manipulation attribution from anything
  downstream. Direct: `node:dns`; over a path: DoT/DoH tunnelled through
  the path's SOCKS5 CONNECT (see below).
- **`tcp_connect`** — TCP handshake only (optionally preceded by DNS
  if `url` references a hostname rather than an IP). No TLS, no HTTP.
  Cheap, isolates reachability attribution. Direct: `node:net`; over a
  path: a SOCKS5 CONNECT whose reply code is the result.

Each target is typically probed with one or more check types per
scheduler tick; cadences are independent per check type. A reasonable
default: `http_get` at the target's configured cadence,
`dns_lookup` and `tcp_connect` at an equal or finer cadence for extra
attribution granularity when something's flapping.

The dedicated check types are not just overlapping insurance — for DNS
they are the *only* source of answer-level evidence, since `http_get`
can't expose resolver answers (see grounding above). They also isolate
lower-layer reachability when the browser path is compromised. Where
evidence genuinely overlaps (a direct `http_get`'s connected IP vs. a
`tcp_connect`'s), the redundancy is a feature.

## Common envelope

Every probe record, regardless of check type, carries the same
envelope:

```jsonc
{
  "schema_version": "nba-v0",
  "check_type": "http_get",                // or "dns_lookup" | "tcp_connect"
  "started_at": "2026-04-20T12:34:56.789Z",
  "runtime_ms": 223,                       // integer ms
  "url": "...",                            // check-type-specific; see each section
  "path": {
    "name": "corp-vantage",
    "role": "vantage",                      // direct | vantage | obfuscation
    "tags": ["vpn", "openconnect"]
  },
  "data": { /* check-type-specific */ }
}
```

The `data` object holds the actual measurement content, and its shape
varies per check type.

## Check type: `http_get`

`url`: the target URL.

The `data` object carries probe configuration, the ordered sequence
of redirect hops, optional low-level network events, and a precomputed
rollup for quick queries.

### Top-level fields inside `data`

```jsonc
"data": {
  "config": { /* probe configuration echo; see below */ },
  "reached_stage": "complete",       // dns | tcp_connect | tls_handshake |
                                      // http_request | http_response |
                                      // body_transfer | complete
  "termination_mode": "clean_fin",   // clean_fin | rst | timeout |
                                      // tls_close_notify_missing |
                                      // body_incomplete
  "hops": [ /* per-hop records; see below */ ],
  "network_events": [ /* optional low-level events; see below */ ],
  "rollup": { /* precomputed summaries; see below */ },
  "subresources": { /* first-party asset health; see below */ }
}
```

Note there is no `outcome` field. Probe records state raw facts
(`reached_stage`, `termination_mode`, per-operation `failure`); signal
rules compose their own predicates over those fields. See
`memory/project_open_questions.md` for the abstraction rationale.

`reached_stage` and `termination_mode` are **derived**, not read off
the wire. On success they follow from which CDP timing phases completed
and how the stream closed; on a *failed* probe — where CDP emits a
single `Network.loadingFailed.errorText` (`net::ERR_*`) and no
hop/timing detail at all — both are derived solely from that error
string, per the mapping in the error taxonomy below.

### `config` — what was asked for

```jsonc
"config": {
  "method": "GET",
  "impersonation_profile": "chromium-124",  // null for baseline
  "follow_redirects": true,
  "max_redirects": 5,
  "timeout_ms": 10000,
  "body_snippet_cap_bytes": 32768,
  "response_headers_captured": ["content-type", "content-length", "location",
                                 "server", "strict-transport-security",
                                 "set-cookie"],
  "pinned_http_version": null               // null | "1.1" | "2" | "3"
}
```

The config echo means any configuration drift is visible in probe
history. All of these fields except `method` may be overridden per
target via the configuration file. The probed URL itself isn't echoed
here — it lives at envelope-level `url`.

### `hops[]` — one record per redirect

Each hop is one complete connect + handshake + request round-trip. An
`http_get` that receives no redirects has exactly one hop; one that
follows three redirects has four hops (initial request plus three
redirect destinations).

The example below shows the **maximum** shape — what a *direct* probe
can fill. Per "What CDP actually exposes", the `dns` block never carries
an answer set, and through a path the `dns` and `tcp` blocks are largely
`null` (the proxy resolves and connects; CDP reports `dnsStart`/`dnsEnd`
`= -1` and the connected IP is the proxy's). Fields CDP can't supply are
`null` or empty, never fabricated.

```jsonc
"hops": [
  {
    "sequence": 0,
    "url": "https://example.com/",

    "dns": {
      "hostname": "example.com",
      "connected_ip": "93.184.216.34",         // target IP on a direct probe;
                                               // the proxy's address via a path
      "engine": "playwright-cdp",
      "answers": [],                           // always empty: CDP supplies none
      "failure": null,
      "offset_ms": 12                          // integer ms from started_at; null via a path
    },

    "tcp": {
      // Direct probe: real target IP + isolated connect timing. Via a
      // path: `ip`/`port` are the PROXY's, and `connect_duration_ms`
      // folds the proxy's own resolve + connect-to-target into one
      // opaque span (CDP gives no separable target-connect timing
      // through SOCKS5).
      "ip": "93.184.216.34",
      "port": 443,
      "status": { "success": true, "failure": null },
      "connect_duration_ms": 18,
      "offset_ms": 30
    },

    "tls": {
      "server_name": "example.com",            // SNI sent
      "tls_version": "TLSv1.3",
      "cipher_suite": "TLS_AES_128_GCM_SHA256",
      "negotiated_protocol": "h2",             // ALPN selected
      "alpn_offered": ["h2", "http/1.1"],
      "peer_certificates": [
        {
          "data": "<base64 DER>",              // raw cert chain, fetched via the CDP
                                               // Network.getCertificate({origin}) method
          "subject_cn": "example.com",
          "subject_alt_names": ["example.com", "www.example.com"],
          "issuer_cn": "DigiCert Global Root CA",
          "not_before": "2026-01-01T00:00:00Z",
          "not_after": "2027-01-01T00:00:00Z",
          "serial": "0123...",
          "sha256_fingerprint": "ab12...cd34"
        }
        // intermediate + root if the server presented them
      ],
      "handshake_duration_ms": 47,
      "failure": null,
      "offset_ms": 77
    },

    "http": {
      "request": {
        "method": "GET",
        "http_version": "2",
        "header_names": ["user-agent", "accept", "accept-language", "accept-encoding"]
        // values omitted: impersonation_profile determines them deterministically
      },
      "response": {
        "code": 200,
        "http_version": "2",
        "headers": {
          // selected subset per config.response_headers_captured:
          "content-type": "text/html; charset=UTF-8",
          "content-length": "1256",
          "location": null,
          "server": "...",
          "strict-transport-security": "max-age=31536000",
          "set-cookie-names": ["session_id", "csrf_token"]    // set-cookie captured names-only; values redacted
        },
        "all_headers": {
          // overflow dict: full response headers for future LLM-assisted
          // interpretation. On by default. set-cookie values still redacted.
        },
        "ttfb_ms": 98,
        "transfer_duration_ms": 8,
        "offset_ms": 175
      }
    },

    "body": {
      "metadata": {
        "bytes_received": 1256,                // decoded body size (uncapped)
        "encoded_bytes_received": 1256,        // on-the-wire bytes; compare to content_length_header
        "content_length_header": 1256,         // wire size (compressed if content-encoding set)
        "transfer_encoding": "identity",
        "content_type_detected": "text/html",  // magic-bytes detection
        "sha256_full_body": "..."               // hash of full received body
      },
      "snippet": "<html>...",                  // first body_snippet_cap_bytes
      "snippet_truncated": false,
      "snippet_encoding": "utf8",              // utf8 | base64 (smart-picked)
      "shape_signals": {
        "is_empty_or_minimal_html": false,
        "has_meta_refresh": false,
        "meta_refresh_target": null,
        "has_js_redirect": false,
        "js_redirect_target": null,
        "has_noscript_tag": true,
        "noscript_text_snippet": "Please enable JavaScript",
        "unavailability_phrases_matched": []
      }
    },

    "hop_duration_ms": 183,
    "failure": null                            // populated if this hop failed
                                                // (the relevant sub-op's failure
                                                // is the authoritative source)
  }
]
```

### `network_events[]` — optional low-level events

When Playwright's CDP emits interesting low-level events
(`Network.loadingFailed` with specific error codes, `Security.certificateError`,
etc.), they're accumulated here. Shape matches OONI's `network_events`
convention plus our hop correlation:

```jsonc
"network_events": [
  {
    "offset_ms": 210,
    "operation": "tls_handshake_done",
    "failure": null,
    "hop_index": 0
  }
]
```

May be absent or empty when the probe ran cleanly.

### `rollup` — precomputed summaries

```jsonc
"rollup": {
  "final_url": "https://example.com/",
  "final_status_code": 200,
  "redirect_chain": [
    { "url": "https://example.com/", "status": 200 }
  ],
  "timing_ms": {
    "dns": 12,             // sum across hops
    "tcp_connect": 18,     // sum across hops
    "tls_handshake": 47,   // sum across hops
    "ttfb": 98,            // final hop's TTFB
    "transfer": 8,         // final hop's transfer duration
    "total": 223           // wall-clock end-to-end
  }
}
```

The rollup is derived from `hops[]`; consumers could compute it
on-demand, but precomputing at probe time means metric derivation,
Grafana queries, and simple signal rules do not have to walk the hops
array.

### Completion is the target document, not the page `load` event

`reached_stage: "complete"` means the **target document** (the final
redirect hop) finished transferring — *not* that the browser's full-page
`load` event fired. The two diverge constantly: a page pulls dozens of
subresources (first-party CSS/JS, and especially third-party
ad / tracking / RTB / cookie-sync endpoints), and those routinely hang.
If the probe waited on `load`, it would report a stall on virtually
every ad-supported site whose trackers are slow or blocked — a flood of
false positives unrelated to the target's reachability.

So `reached_stage` (and the per-op `failure` records from which
`STORAGE_SCHEMA.md` derives `first_failure_code`) track the **main
document request** only — keyed on its `Network.loadingFinished` (with
the body idle-timeout that defines `http_body_stalled`), never the page
`load` event. But "is the target working" is more than the document, so the
engine *also* tracks the target's **first-party** subresources (same
registrable domain — eTLD+1) and records their health in `subresources`
(below). **Third-party** subresources — ad / tracking / RTB /
cookie-sync, which hang on essentially every ad-supported site — are
ignored entirely; counting them would drown the signal in false
positives.

The probe is "done" once the main document and all first-party
subresources have each reached a terminal state (finished / failed /
idle-stall); it never waits on third-party requests. The payoff is
catching the case a document-only judgement misses: a small HTML shell
that completes (under the body-stall cutoff) while the site's larger
first-party bundle is DPI-stalled over it. The document reads
`complete`, but `subresources` records the stall — see the
`first_party_resource_stalled` rule in `SIGNAL_RULES.md`. (A page broken
only because a *third-party* asset hung still, by design, probes as a
healthy target.)

### `subresources` — first-party asset health

A bounded summary of the target's own (eTLD+1) subresources — kept small
because third-party requests, however numerous, are excluded. Absent for
non-`http_get` check types.

```jsonc
"subresources": {
  "scope": "first_party",            // same registrable domain (eTLD+1) as the target
  "total": 3,
  "complete": 1,
  "stalled": 1,                      // first_failure_code == "http_body_stalled"
  "failed": 1,                       // any other non-null first_failure_code
  "worst_first_failure_code": "http_body_stalled",
  "stalled_or_failed": [             // only the unhealthy ones are listed
    {
      "url": "https://example.com/assets/app.js",
      "type": "script",             // script | stylesheet | font | image | fetch | other
      "reached_stage": "body_transfer",
      "first_failure_code": "http_body_stalled",
      "encoded_bytes_received": 16384,
      "content_length_header": 412900
    }
  ]
}
```

Each entry reuses the per-operation `reached_stage` / `first_failure_code`
vocabulary, so the same interference taxonomy applies to assets as to the
document. **Limitation:** a critical asset served from a *third-party*
CDN (a separate eTLD+1) is not counted — domain alone can't separate a
critical CDN from an ad tracker. v1 scopes to first-party; revisit if it
proves limiting.

## Check type: `dns_lookup`

`url`: the hostname to resolve.

This is the **authoritative source of per-path DNS evidence** — the one
`http_get` can't provide (CDP exposes no answer set; see "What CDP
actually exposes").

### How a `dns_lookup` reaches its resolver

The probe issues the query to a configured resolver and sends it
**through the path**, so the lookup egresses at the path's exit —
bypassing local DNS interception and reflecting the path's vantage.
Transport depends on `resolver_type`:

- **`dot` / `doh`** — DNS-over-TLS (TCP/853) or DNS-over-HTTPS, carried
  over the path's SOCKS5 **CONNECT**. Works through any standard proxy
  and is tamper-resistant at the egress. **Default for non-direct
  paths**. `dot`/`doh` add a `resolver_sni` config field (the TLS
  server name, e.g. `"one.one.one.one"`).
- **`udp53`** — plain UDP DNS. **Direct path only**: over a proxy it
  needs SOCKS5 UDP ASSOCIATE, unsupported by most proxies
  (→ `proxy_command_not_supported`). Plain TCP/53 is the CONNECT-able
  fallback but isn't tamper-resistant, so DoT/DoH is preferred.
- **`system`** — the host stub resolver (`node:dns`). **Direct only** —
  not routable through a path; use it for the direct baseline.

`http_get`'s invisible egress resolver and this check answer different
questions: `http_get` reflects whatever the path resolved (without
showing it); `dns_lookup` *pins* a resolver and *returns the answers*.
They can legitimately disagree (different resolver, geo CDN) — that
disagreement is signal, not error.

`data` is flat — no hops concept:

```jsonc
"data": {
  "config": {
    "query_types": ["A", "AAAA"],         // array; both queried by default
    "resolver_address": "1.1.1.1",
    "resolver_type": "udp53",              // system | udp53 | dot | doh
    "timeout_ms": 5000
  },
  "reached_stage": "complete",             // dns | complete
  "queries": [
    {
      "hostname": "example.com",
      "query_type": "A",
      "resolver_address": "1.1.1.1",
      "resolver_type": "udp53",
      "engine": "socks5-tunnel",            // socks5-tunnel via a path; node-dns direct
      "answers": [
        { "answer_type": "A", "ipv4": "93.184.216.34", "ttl": 3600 }
      ],
      "failure": null,
      "offset_ms": 12
    },
    {
      "hostname": "example.com",
      "query_type": "AAAA",
      "answers": [ /* ... */ ],
      "failure": null,
      "offset_ms": 18
    }
  ]
}
```

The per-answer element (`{ answer_type, ipv4 | ipv6, ttl }`) is shared
with `http_get.hops[].dns.answers` — but recall that for `http_get`
that array is always empty (CDP can't supply it), so in practice only
`dns_lookup` populates answers. `failure` codes (`dns_nxdomain`,
`dns_servfail`, `dns_refused`, `dns_timeout`) and timing conventions
are shared across both checks.

## Check type: `tcp_connect`

`url`: `"host:port"` — either hostname-based (`example.com:443`) or
IP-based (`93.184.216.34:443`, or `[2606:2800:...]:443` for IPv6).
The probe detects which and optionally runs DNS first.

`data` is flat — no hops concept:

```jsonc
"data": {
  "config": {
    "timeout_ms": 5000,
    "attempt_all_ips": true                  // try every IP returned, not just first
  },
  "reached_stage": "complete",               // dns | tcp_connect | complete
  "queries": [
    // present only when target was hostname-based
    { /* per-query record; same schema element as above */ }
  ],
  "tcp_connect": [
    {
      "ip": "93.184.216.34",
      "port": 443,
      "status": { "success": true, "failure": null },
      "connect_duration_ms": 18,
      "offset_ms": 30
    }
    // additional entries if DNS returned multiple IPs
    // and attempt_all_ips is true
  ]
}
```

The per-TCP-attempt record is the same schema element as appears
inside `http_get.hops[].tcp`. `attempt_all_ips` defaults to `true` so
IPv4 and IPv6 are both exercised when the target has dual-stack DNS.

Over a path, `tcp_connect` is itself a SOCKS5 **CONNECT** (`node:net`
can't traverse a proxy directly): reachability is read from the SOCKS5
reply code, the target `ip` is `null` (the proxy resolves and connects),
and `attempt_all_ips` doesn't apply (the proxy picks the IP). On a
direct path it's a plain `node:net` connect with the full per-IP detail
shown above.

## Error taxonomy

Every per-operation record (a query, a TCP attempt, a TLS handshake,
an HTTP request, a body transfer) carries a `failure` field: `null`
on success, or one of the following strings on failure. Inspired by
OONI's failure-string convention; the specific vocabulary here is
ours and extensible.

### DNS stage

- `dns_nxdomain` — authoritative NXDOMAIN response
- `dns_timeout` — no response within timeout
- `dns_servfail` — resolver returned SERVFAIL
- `dns_refused` — resolver returned REFUSED

### TCP stage

- `connection_refused` — RST on SYN
- `connection_timeout` — SYN without response within timeout
- `network_unreachable` — ICMP network-unreachable
- `host_unreachable` — ICMP host-unreachable

### TLS stage

- `tls_handshake_timeout` — handshake didn't complete within timeout
- `tls_handshake_failed` — generic handshake failure not fitting more
  specific codes below
- `tls_cert_invalid` — cert validation failed; reason non-specific
- `tls_cert_hostname_mismatch` — cert valid but not for SNI hostname
- `tls_cert_expired` — cert validity window violated
- `tls_cert_unknown_ca` — CA not trusted
- `tls_protocol_version_mismatch` — server rejected offered TLS version
- `tls_closed_during_handshake` — RST mid-handshake; a DPI signature

### HTTP stage

- `http_request_timeout` — couldn't send request within timeout
- `http_response_timeout` — no response headers within timeout
- `http_invalid_response` — malformed HTTP response
- `http_connection_reset` — RST mid-request or mid-response
- `http_body_truncated` — connection closed with
  `bytes_received < content_length_header`
- `http_body_stalled` — body transfer stopped advancing (no further
  bytes for the body **idle** timeout) while the connection stayed open
  — throughput dropped to ~zero, the stealthy DPI / throttling variant.
  Detected by an **inter-byte idle timeout, not total duration**, so it
  is distinct both from `http_body_truncated` (an active *close*
  mid-body) and from a merely *slow* transfer that keeps making progress
  until a total-time cap. `termination_mode` is `timeout`;
  `bytes_received < content_length_header` when a length was advertised
  (but a stall can occur on a chunked response with no length at all).

### Termination-specific

These are **`termination_mode` values, not per-operation `failure`
strings** — they describe how an otherwise-progressing stream ended:

- `tls_close_notify_missing` — TLS session ended without `close_notify`.
  Can occur on a probe that still `reached_stage: "complete"` with a
  full body; it does **not** set `first_failure_code` (the request
  succeeded) and lives only in `termination_mode`, preserving the
  `complete ⇔ first_failure_code IS NULL` invariant.
- `body_incomplete` — body transfer didn't complete cleanly. This *does*
  cap `reached_stage` at `body_transfer` (not `complete`) and surfaces
  as the per-op `failure` `http_body_truncated`, so the invariant holds
  from the other side.

### Redirect handling

- `redirect_loop_detected` — the redirect chain cycles
- `too_many_redirects` — exceeded `max_redirects`

### Proxy / path-level

- `proxy_connection_failed` — couldn't reach the SOCKS5 proxy itself
  (the path is down, distinct from target being down)
- `proxy_auth_failed` — SOCKS5 authentication rejected
- `proxy_command_not_supported` — SOCKS5 command unsupported by this
  proxy. Concrete trigger: a `dns_lookup` with `resolver_type =
  "udp53"` over a path needs SOCKS5 UDP ASSOCIATE, which many proxies
  (microsocks, most `ssh -D` tunnels) don't implement — which is why
  DoT/DoH-over-CONNECT is the default transport for non-direct paths
  (see the `dns_lookup` section).

### Fallback

- `unknown_failure` — anything not fitting the above; raw error text
  preserved in `network_events` when available

New codes are added as failure modes surface. A cross-reference table
mapping these to OONI's standardized failure strings (where
equivalents exist) will live alongside the probe engine implementation
for cross-project debugging.

### Deriving the taxonomy from CDP (`http_get`)

For `http_get`, failures arrive as a Chromium `net::ERR_*` string on
`Network.loadingFailed`. The engine translates the error string into
`first_failure_code` and infers `reached_stage` from it (there is no
partial hop/timing record on a pre-response failure):

| `net::ERR_*` | `first_failure_code` | inferred `reached_stage` |
|---|---|---|
| `ERR_PROXY_CONNECTION_FAILED` | `proxy_connection_failed` | (never reached proxy) |
| `ERR_NAME_NOT_RESOLVED` | `dns_nxdomain` | `dns` |
| `ERR_CONNECTION_REFUSED` | `connection_refused` | `tcp_connect` |
| `ERR_CONNECTION_TIMED_OUT` / `ERR_TIMED_OUT` | `connection_timeout` | `tcp_connect` |
| `ERR_CONNECTION_RESET` (pre-response) | `tls_closed_during_handshake` *or* `http_connection_reset` | `tls_handshake` / `http_request` |
| `ERR_SSL_PROTOCOL_ERROR` | `tls_handshake_failed` | `tls_handshake` |
| `ERR_CERT_DATE_INVALID` | `tls_cert_expired` | `tls_handshake` |
| `ERR_CERT_AUTHORITY_INVALID` | `tls_cert_unknown_ca` | `tls_handshake` |
| `ERR_CERT_COMMON_NAME_INVALID` | `tls_cert_hostname_mismatch` | `tls_handshake` |
| `ERR_EMPTY_RESPONSE` / `ERR_CONNECTION_RESET` (post-headers) | `http_body_truncated` | `body_transfer` |
| anything else | `unknown_failure` (raw `errorText` kept) | best-effort |

Not every failure is a `net::ERR_*`. A **body stall** is the notable
case: `responseReceived` (e.g. `200`) arrives, then `Network.dataReceived`
stops and no `loadingFinished` ever fires — CDP emits **no
`loadingFailed`** at all. The engine detects it via its own
body-transfer timeout: if the transfer hasn't completed and
`bytes_received < content_length_header`, it records
`reached_stage: "body_transfer"`, `first_failure_code:
"http_body_stalled"`, `termination_mode: "timeout"` (counting
`Network.dataReceived` for the byte total).

**Granularity ceiling (accepted).** Chromium collapses some
distinctions the taxonomy draws. A hang (`ERR_TIMED_OUT`) is cleanly
separable from a reset (`ERR_CONNECTION_RESET`), but *where* a reset
happened — RST mid-handshake vs. mid-body, the classic DPI tell — is
only recoverable when a response had already been received (mid-body
truncation = headers present + `loadingFailed`; a pre-response reset
yields only the error string). So `tls_closed_during_handshake` is a
best-effort label inferred from the absence of any prior response, not
a guarantee; rules keyed on it should treat it as suggestive.

**Restricted ports.** Chromium refuses to connect to its
restricted-port blocklist (ports 1, 7, 9, 19, …), surfacing
`ERR_UNSAFE_PORT`. An `http_get` against such a target port can never
succeed in-browser; a `tcp_connect` (`node:net`) has no such
restriction and is the correct check there. The engine should surface
`ERR_UNSAFE_PORT` distinctly rather than as a generic reachability
failure.

## Body shape signals

`http_get.hops[].body.shape_signals` holds precomputed booleans and
short extracted strings. The probe engine runs these detections once
at probe time so signal rules can filter on them without re-parsing
bodies.

- **`is_empty_or_minimal_html`** — the body is empty, or is an HTML
  shell with no meaningful content (less than roughly 500 bytes of
  text after tag stripping). Flags pages acting as placeholders.
- **`has_meta_refresh`** / **`meta_refresh_target`** — detects
  `<meta http-equiv="refresh" content="0; url=...">`. Target URL
  extracted when found.
- **`has_js_redirect`** / **`js_redirect_target`** — detects common
  JavaScript redirect patterns: `window.location = …`,
  `window.location.href = …`, `window.location.replace(…)`. Target
  URL extracted when statically determinable from a string literal;
  `null` when the redirect target is dynamic.
- **`has_noscript_tag`** / **`noscript_text_snippet`** — detects
  `<noscript>…</noscript>` blocks and extracts up to 200 chars of
  tag-stripped text. Often the most informative text on
  JS-redirected pages.
- **`unavailability_phrases_matched`** — array of matched substrings
  from a configurable phrase list. Defaults include
  *"unavailable in your region"*, *"not available in your country"*,
  *"unavailable for legal reasons"*, *"service unavailable"*,
  *"blocked"*, *"Access Denied"*, plus localisations. Matching is
  case-insensitive substring, so phrases must be specific enough not to
  false-match — bare tokens like *"451"* are avoided (they hit ray IDs,
  hashes, and arbitrary numbers). The list is configurable in the global
  config file.

Detection is deliberately conservative: false positives are worse
than false negatives here, since false positives would trigger
misleading signals. When a rule wants deeper body analysis it reads
the raw `snippet` itself.

## Implementation notes

- **`http_get` is backed by Playwright** (headless Chromium / Firefox
  / WebKit). The `impersonation_profile` config value maps to the
  browser engine launched: `chromium-<version>` → Chromium,
  `firefox-<version>` → Firefox, `webkit-<version>` → WebKit, `null`
  → a default Chromium baseline. CDP events (`Network.*`,
  `Security.*`, `Page.frameNavigated`) are captured and transformed
  into the per-hop records; the peer-cert chain comes from the
  `Network.getCertificate({origin})` method (not `securityDetails`).
  One browser context per path, reused across probes for that path;
  one page per probe, closed after. What CDP does and doesn't supply
  per hop is documented in "What CDP actually exposes".
- **`dns_lookup` resolves through the path.** For the direct baseline
  it uses `node:dns`. Over a non-direct path it opens a SOCKS5 no-auth
  CONNECT to the resolver and speaks DNS over the resulting socket —
  DNS-over-TCP (RFC 7766: a 2-byte big-endian length prefix in front of
  the DNS message), or that same framing inside a TLS wrap for `dot`.
  No native bindings or DNS library are required: the SOCKS5 CONNECT
  handshake plus a minimal A/AAAA encode/decode is on the order of ~75
  lines; `dns-packet` is a convenient off-the-shelf codec if preferred.
- **`tcp_connect` is backed by `node:net`** for direct paths (a
  `net.createConnection` with timeout and error-to-`failure` mapping),
  and by a SOCKS5 **CONNECT** for non-direct paths (reachability read
  from the SOCKS reply). Roughly 30 lines plus the shared SOCKS client.
- **OONI inspiration is at the per-operation record level, not the
  envelope.** The payload is not ingestable by OONI's tooling. Field
  names and conventions are borrowed where they fit (`failure`
  strings, `peer_certificates`, `negotiated_protocol`); per-hop
  organisation replaces OONI's cross-op parallel arrays because
  Playwright emits per-request naturally, and reshaping is cost for
  no benefit in our context.

## Deferred / open

The following are acknowledged but belong in other sub-documents or
later iterations:

- **Storage layout** (JSON-blob column vs. column extraction,
  indexing, retention, rollups) is `STORAGE_SCHEMA.md`.
- **Signal rule catalogue** — which predicates signal rules compose
  over these fields — is `SIGNAL_RULES.md`. See
  `memory/project_open_questions.md` for the outcome-semantics /
  signal-predicate discussion that anchors it.
- **Browser-context pooling, crash recovery, resource budgets** —
  implementation concerns, not spec.
- **Body-snippet cap default.** Proposed at 32 KB; exact value may be
  revisited once we see real body sizes for the target set.
- **Which config fields accept per-target overrides** — belongs in
  `CONFIG_FILE.md`. Assumption here: most `config.*` fields are
  overridable.
- **Cross-probe signals** (comparisons across paths, across time,
  across impersonation profiles) — `SIGNAL_RULES.md`.
- **Full OONI failure-string cross-reference table.** Not in v0; to
  be produced alongside probe engine implementation.
- **Alternative `http_get` backends.** Playwright is the v0
  choice. The CDP transformation layer is the durable design; the
  harness around it (Playwright vs. a future headless-Chrome
  driver, vs. anything else that speaks CDP per-context with
  independent network state) is replaceable.

---

*Status: v0 draft. The `http_get` evidence model, cert retrieval,
failure taxonomy, and the per-path `dns_lookup` design are revised to
reflect what Chromium's CDP actually exposes, direct and via a SOCKS5
proxy.*
