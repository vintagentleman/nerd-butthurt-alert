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

## Overview: three check types

Every probe is typed. Three check types exist in v1:

- **`http_get`** — the rich probe. Fetches the target URL through the
  configured path, capturing DNS, TCP, TLS, HTTP, body, and
  termination details *per hop* (each redirect is its own hop).
  Backed by Playwright (headless Chromium / Firefox / WebKit) so the
  emitted traffic is that of a real browser, not a spoofing layer.
- **`dns_lookup`** — standalone DNS resolution. No TCP, no TLS, no
  HTTP. Cheap, isolates DNS-manipulation attribution from anything
  downstream. Backed by Bun's `node:dns`.
- **`tcp_connect`** — TCP handshake only (optionally preceded by DNS
  if `url` references a hostname rather than an IP). No TLS, no HTTP.
  Cheap, isolates reachability attribution. Backed by Bun's
  `node:net`.

Each target is typically probed with one or more check types per
scheduler tick; cadences are independent per check type. A reasonable
default: `http_get` at the target's configured cadence,
`dns_lookup` and `tcp_connect` at an equal or finer cadence for extra
attribution granularity when something's flapping.

Overlapping evidence is a feature, not a bug. `http_get` performs DNS
and TCP-connect steps internally and captures them, but the dedicated
check types cover cases where the browser path is compromised but
lower-layer reachability still matters.

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
                                      // connection_reset | body_incomplete
  "hops": [ /* per-hop records; see below */ ],
  "network_events": [ /* optional low-level events; see below */ ],
  "rollup": { /* precomputed summaries; see below */ }
}
```

Note there is no `outcome` field. Probe records state raw facts
(`reached_stage`, `termination_mode`, per-operation `failure`); signal
rules compose their own predicates over those fields. See
`memory/project_open_questions.md` for the abstraction rationale.

### `config` — what was asked for

```jsonc
"config": {
  "target_url": "https://example.com/",
  "method": "GET",
  "impersonation_profile": "chromium-124",  // null for baseline
  "follow_redirects": true,
  "max_redirects": 5,
  "timeout_ms": 10000,
  "body_snippet_cap_bytes": 32768,
  "response_headers_captured": ["content-type", "content-length", "location",
                                 "server", "strict-transport-security"],
  "pinned_http_version": null               // null | "1.1" | "2" | "3"
}
```

The config echo means any configuration drift is visible in probe
history. All of these fields except `target_url` and `method` may be
overridden per target via the configuration file.

### `hops[]` — one record per redirect

Each hop is one complete connect + handshake + request round-trip. An
`http_get` that receives no redirects has exactly one hop; one that
follows three redirects has four hops (initial request plus three
redirect destinations).

```jsonc
"hops": [
  {
    "sequence": 0,
    "url": "https://example.com/",

    "dns": {
      "hostname": "example.com",
      "resolver_address": "socks5h-tunnel-side",
      "resolver_type": "socks5h-tunnel-side",  // system | udp53 | dot | doh |
                                                // socks5h-tunnel-side
      "engine": "playwright-cdp",
      "answers": [
        { "answer_type": "A", "ipv4": "93.184.216.34", "ttl": 3600 },
        { "answer_type": "AAAA", "ipv6": "2606:2800:220:...", "ttl": 3600 }
      ],
      "failure": null,
      "offset_ms": 12                          // integer ms from started_at
    },

    "tcp": {
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
          "data": "<base64 DER>",              // raw cert; OONI-aligned
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
          "set-cookie-names": ["session_id", "csrf_token"]    // names-only
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
        "bytes_received": 1256,                // uncapped actual count
        "content_length_header": 1256,
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
on-demand, but precomputing at probe time means dashboard queries and
simple signal rules do not have to walk the hops array.

## Check type: `dns_lookup`

`url`: the hostname to resolve.

`data` is flat — no hops concept:

```jsonc
"data": {
  "config": {
    "hostname": "example.com",
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
      "engine": "bun-node-dns",
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

The per-query record shape is the same schema element as appears
inside `http_get.hops[].dns`. Same goes for `failure` codes and
timing conventions.

## Check type: `tcp_connect`

`url`: `"host:port"` — either hostname-based (`example.com:443`) or
IP-based (`93.184.216.34:443`, or `[2606:2800:...]:443` for IPv6).
The probe detects which and optionally runs DNS first.

`data` is flat — no hops concept:

```jsonc
"data": {
  "config": {
    "target": "example.com:443",
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

### Termination-specific

- `tls_close_notify_missing` — TLS session ended without close_notify
- `body_incomplete` — body transfer didn't complete cleanly

### Redirect handling

- `redirect_loop_detected` — the redirect chain cycles
- `too_many_redirects` — exceeded `max_redirects`

### Proxy / path-level

- `proxy_connection_failed` — couldn't reach the SOCKS5 proxy itself
  (the path is down, distinct from target being down)
- `proxy_auth_failed` — SOCKS5 authentication rejected
- `proxy_command_not_supported` — SOCKS5 command unsupported by this
  proxy (relevant if UDP-probe-style check types are added later)

### Fallback

- `unknown_failure` — anything not fitting the above; raw error text
  preserved in `network_events` when available

New codes are added as failure modes surface. A cross-reference table
mapping these to OONI's standardized failure strings (where
equivalents exist) will live alongside the probe engine implementation
for cross-project debugging.

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
  *"451"*, *"service unavailable"*, *"blocked"*, *"Access Denied"*,
  plus localisations. The list is configurable in the global config
  file.

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
  into the per-hop records. One browser context per path, reused
  across probes for that path; one page per probe, closed after.
- **`dns_lookup` is backed by Bun's `node:dns`.** The `dns.Resolver`
  class is configured per probe with the chosen resolver; queries
  are issued and results transformed. Roughly 20 lines of code.
- **`tcp_connect` is backed by Bun's `node:net`.** A direct
  `net.createConnection` with timeout and error-to-`failure` mapping.
  Roughly 30 lines of code.
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
  indexing, retention, rollups) is the storage-schema sub-document.
- **Signal rule catalogue** — which predicates signal rules compose
  over these fields — is the signal-rule-catalogue sub-document. See
  `memory/project_open_questions.md` for the outcome-semantics /
  signal-predicate discussion that anchors it.
- **Browser-context pooling, crash recovery, resource budgets** —
  implementation concerns, not spec.
- **Body-snippet cap default.** Proposed at 32 KB; exact value may be
  revisited once we see real body sizes for the target set.
- **Which config fields accept per-target overrides** — belongs in
  the configuration-file-format sub-document. Assumption here: most
  `config.*` fields are overridable.
- **Cross-probe signals** (comparisons across paths, across time,
  across impersonation profiles) — signal-rule-catalogue.
- **Full OONI failure-string cross-reference table.** Not in v0; to
  be produced alongside probe engine implementation.

---

*Status: v0 draft.*
