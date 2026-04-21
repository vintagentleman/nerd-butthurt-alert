# Reference Path Deployments

## What this document is

A companion to `ARCHITECTURE.md`. It specifies the **path contract**
the main application expects, then catalogues a cookbook of
**reference deployment recipes** — worked examples for standing up
the kinds of proxies a user is likely to want as paths for the
Connectivity Monitor.

An earlier pre-pivot draft hardcoded a corporate-targeted triad of
paths (RU OpenConnect, SpoofDPI, EU OpenConnect). The current
design treats paths as generic and user-defined; this document's
job is to make "user-defined" concretely achievable with a handful
of known-good recipes.

The presentational default is **docker-compose**, because it gives
clean network-namespace isolation and is easy to reproduce. The
architecture nevertheless permits any SOCKS5 URL — a bare
`ssh -D 1080 jumpbox`, a system-installed proxy, a proxy on a
remote host — all of those are valid paths. The cookbook focuses on
Docker because that's the shape most users will reach for.

## The path contract

From the application's perspective, a path is the following record:

```
name         — short identifier, unique within the config
proxy_url    — SOCKS5 URL, or null for the direct baseline
role         — one of: direct | vantage | obfuscation
tags         — freeform strings (zero or more)
description  — optional human-readable note
```

### `proxy_url` semantics

- **`null`** (or absent, depending on the chosen config format) means
  the probe runs without a proxy, using the host's default routing
  and DNS. Exactly one path in a well-formed config should be
  `null` — the direct baseline.
- Otherwise, a **SOCKS5 URL** such as `socks5h://localhost:10801`.
  The recommended scheme is `socks5h://`: DNS resolution is
  performed through the proxy, making DNS-manipulation signals
  attributable to the specific path rather than masked by the host
  resolver. Use plain `socks5://` only for deliberate DNS-vs-
  transport comparisons.
- **HTTP-only proxies** (tinyproxy, squid as an HTTP forward proxy)
  are intentionally unsupported in v1. SOCKS5 is the single
  transport the application speaks. Most modern proxy stacks either
  expose SOCKS5 natively or pair easily with a `microsocks`
  front-end.

### What the application does and does not do

It **does**:

- Open TCP connections to the SOCKS5 URL as dictated by the
  scheduler.
- Log probe outcomes tagged with the `name` of the path used.
- Pass `role` and `tags` to the signals engine for rule-based
  reasoning.

It **does not**:

- Start, stop, restart, or health-check the proxy process.
- Manage secrets the proxy needs (VPN credentials, transport keys,
  TOTP seeds).
- Assume anything about the underlying transport — the proxy could
  be an OpenConnect tunnel, a WireGuard sidecar, a remote
  `ssh -D 1080 jumpbox`, a Hysteria QUIC client, a shadowsocks
  server, or a tin can and string.

Lifecycle and secrets are **the user's responsibility**, resolved
with whatever tooling fits their host (systemd units, compose,
a one-shot script, etc.).

## The `role` enum

Every path declares exactly one `role`. Roles exist to give the
signals engine — and any future agentic reasoning — a minimal
semantic handle for comparing paths to each other.

- **`direct`** — no proxy; the host's default routing. Baseline
  against which every other path is compared. Typically one per
  config.
- **`vantage`** — the path reaches the internet from a different
  network location. Corporate VPN, cloud VPS tunnel, remote
  jumpbox via `ssh -D`, residential-proxy vendor, a foreign-exit
  QUIC tunnel (Hysteria / VLESS / etc.) — whatever the underlying
  mechanism, the exit's *location* is the point. *Question this
  path answers:* "What does this site look like from over there?"
- **`obfuscation`** — the path's exit remains in the same network
  location as direct; its distinguishing feature is defeating some
  form of local interference, by any mechanism: packet boundaries,
  TLS fingerprint, SNI handling, traffic shape, or even switching
  the wire-level protocol (a domestic QUIC tunnel used to sidestep
  TCP-specific DPI qualifies as `obfuscation`). Examples: SpoofDPI,
  Zapret, GoodbyeDPI, GreenTunnel, naïveproxy, Reality/XTLS; and,
  in TCP-only DPI environments, domestic UDP/QUIC tunnels.
  *Question this path answers:* "Is local interference the reason
  this site is misbehaving, and does working around it restore
  access?"

Wire-protocol facts (QUIC, UDP, HTTP/3, ICMP-tunnel, etc.) belong
in `tags`, not in `role`. The role distinction is about the
*question the path helps answer* — not about the underlying
transport. A path that both changes exit location *and* happens to
use an unusual transport resolves by primary intent: if you chose
the path because the exit is elsewhere, it's `vantage`; if you
chose it because it defeats local interference, it's `obfuscation`. The
`tags` carry the protocol-level detail orthogonally.

## `tags` (freeform)

Arbitrary short strings per path. Intended for user organisation
and for future signal rules that want a discriminator finer than
`role`. Example tag vocabulary:

- Geographic: `home`, `eu`, `ru`, `us-east`
- Network: `home-wifi`, `corporate`, `residential`
- Wire protocol: `quic`, `udp`, `http3`, `icmp-tunnel`
- Cost: `expensive-bandwidth`, `unlimited`
- Status: `experimental`, `deprecated`

No tag is special-cased by the application in v1.

## DNS policy

The application does nothing beyond what SOCKS5 specifies:

- `socks5h://` — domain name is forwarded to the proxy; the proxy
  resolves. **Recommended default for every non-direct path.**
- `socks5://` — application resolves the domain locally (host
  resolver), then connects to the resulting IP through the proxy.
  Useful only for explicit DNS-vs-transport comparison.
- For a `direct` path (`proxy_url` null), DNS goes through the host
  resolver as normal.

## Secrets handling

Three patterns are recognised, each with different ergonomic and
security tradeoffs. None is mandated. Per-recipe defaults are
suggestions; any recipe may be adapted to a different pattern.

### Pattern A — plaintext `.env`

A `.env` file in the compose directory holds secrets as plain
environment variables. Compose reads it automatically.

- **Optimises for:** first-setup simplicity, single-line quickstarts.
- **Downsides:** plaintext secrets on disk; easy to accidentally
  commit or back up.
- **Reach for it when:** bootstrapping a recipe for the first time,
  or when the host itself is considered trusted and unshared.

### Pattern B — `secret-tool` wrapper

A host-side shell script calls `secret-tool lookup …` (libsecret) to
fetch each secret from the desktop keyring, exports them as env
vars, then invokes `docker compose up`. Nothing touches disk in
plaintext form.

- **Optimises for:** no plaintext at rest; unified secret store with
  the rest of the desktop session.
- **Downsides:** needs an active desktop / `gnome-keyring` session
  (or equivalent PAM-unlocked keyring) when bringing containers up;
  awkward on headless servers.
- **Reach for it when:** running on a personal workstation or
  laptop where the keyring is already part of the session.

### Pattern C — Docker secrets

Compose's native `secrets:` block mounts secret files into the
container at `/run/secrets/<name>`. Entrypoint scripts read them
from there.

- **Optimises for:** native compose integration; works headless;
  plays with swarm-style deployment if ever relevant.
- **Downsides:** more boilerplate per recipe; the backing files for
  the secrets still live somewhere and need origin management.
- **Reach for it when:** already using compose secrets elsewhere, or
  deploying to a headless server without a keyring session.

## Networking requirements (capabilities & isolation)

Two broad classes of path recipe:

- **VPN-based** (OpenConnect, WireGuard userspace, etc.). Require
  `cap_add: NET_ADMIN` and `devices: /dev/net/tun` inside the
  container to create the tunnel interface. Each container owns
  its own network namespace; routing changes stay inside that
  namespace and do not affect the host. **Never use
  `network_mode: host`** — the whole point of containerising these
  is namespace isolation.
- **Userspace proxies** (SpoofDPI, Hysteria, VLESS/Xray,
  shadowsocks). No special capabilities; ordinary processes that
  listen on a port. The container just needs the tool plus a
  SOCKS5-speaking front-end (either the tool speaks SOCKS5
  natively, or a small SOCKS5 server like `microsocks` runs
  alongside).

In both classes, the container listens on an internal port and
`compose.yaml` maps that to a host port in the reserved `108xx`
range used by the application's config (`10801`, `10802`, `10803`,
…). The application connects to `localhost:<port>` as SOCKS5.

## Cookbook

The following subsections are concrete recipes. Each recipe is
self-contained: it covers the container image, the compose fragment,
any entrypoint scripting, the secrets pattern used, and the resulting
path-config entry.

### OpenConnect + oathtool + libsecret

A `vantage`-role path that tunnels through a Cisco AnyConnect-style
gateway guarded by a TOTP-SHA512 second factor. The container runs
`openconnect` in its own namespace to establish the tunnel, generates
the one-time code headlessly with `oathtool`, and fronts the tunnel
with `microsocks` so the application sees an ordinary SOCKS5 port.
Use this path to answer *"what does this site look like from the other
side of the VPN gateway?"* — whether the gateway is a corporate
egress, a university network, or a private point-of-presence you
maintain. `microsocks` is chosen over `dante-server` because it's a
single ~40 KB binary with no config file, which is all we need.

**Dockerfile** (`openconnect/Dockerfile`):

```dockerfile
FROM alpine:3.20

RUN apk add --no-cache \
      openconnect \
      oath-toolkit-oathtool \
      microsocks \
      iproute2 \
      bash \
      ca-certificates

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 1080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**Compose fragment** (`compose.yaml`):

```yaml
services:
  openconnect-vantage:
    build: ./openconnect
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    ports:
      - "10801:1080"
    environment:
      VPN_SERVER: ${VPN_SERVER}
      VPN_USER: ${VPN_USER}
      VPN_PASSWORD: ${VPN_PASSWORD}
      VPN_OTP_SECRET: ${VPN_OTP_SECRET}
      VPN_AUTHGROUP: ${VPN_AUTHGROUP:-}
    restart: unless-stopped
```

**Entrypoint** (`openconnect/entrypoint.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${VPN_SERVER:?missing}"
: "${VPN_USER:?missing}"
: "${VPN_PASSWORD:?missing}"
: "${VPN_OTP_SECRET:?missing}"

# microsocks binds to the container's default interface; once
# openconnect brings up tun0 and replaces the default route, its
# outbound traffic follows the tunnel.
microsocks -i 0.0.0.0 -p 1080 &
MICROSOCKS_PID=$!

cleanup() { kill "$MICROSOCKS_PID" 2>/dev/null || true; }
trap cleanup EXIT

OTP_CODE=$(oathtool --totp=SHA512 -b "$VPN_OTP_SECRET")

# Cisco AnyConnect with a TOTP secondary factor reads two lines from
# stdin: the password, then the OTP. --authgroup is optional.
{
  printf '%s\n' "$VPN_PASSWORD"
  printf '%s\n' "$OTP_CODE"
} | exec openconnect \
    --protocol=anyconnect \
    --user="$VPN_USER" \
    ${VPN_AUTHGROUP:+--authgroup="$VPN_AUTHGROUP"} \
    --passwd-on-stdin \
    --non-inter \
    --script-tun --script='/usr/share/vpnc-scripts/vpnc-script' \
    "$VPN_SERVER"
```

In practice you can drop `--script-tun` and let openconnect use the
default vpnc-script that ships with the Alpine package — we keep it
explicit here so the behaviour does not silently change if the
package's default shifts.

**Secrets — Pattern B (`secret-tool` wrapper)** is a natural fit
here: the credentials are long-lived, the host is typically a
workstation with a keyring session, and the TOTP *secret* is exactly
the sort of value you don't want sitting in a plaintext `.env`.

Seed the keyring once:

```bash
secret-tool store --label='openconnect server'   path openconnect field server
secret-tool store --label='openconnect user'     path openconnect field user
secret-tool store --label='openconnect password' path openconnect field password
secret-tool store --label='openconnect otp seed' path openconnect field otp
```

Wrapper script (`up-openconnect.sh`) run in place of `docker compose up`:

```bash
#!/usr/bin/env bash
set -euo pipefail

export VPN_SERVER=$(secret-tool lookup path openconnect field server)
export VPN_USER=$(secret-tool lookup path openconnect field user)
export VPN_PASSWORD=$(secret-tool lookup path openconnect field password)
export VPN_OTP_SECRET=$(secret-tool lookup path openconnect field otp)

exec docker compose up -d openconnect-vantage
```

Patterns A (plaintext `.env` with the same four variable names) and
C (four files under `secrets:` mounted at `/run/secrets/`, entrypoint
reads them with `cat`) apply equally — pick by host, not by recipe.

**Path-config entry**:

```toml
name        = "corp-vantage"
proxy_url   = "socks5h://localhost:10801"
role        = "vantage"
tags        = ["vpn", "openconnect", "corp-egress"]
description = "Cisco AnyConnect gateway, TOTP-SHA512"
```

**Verification & troubleshooting**:

```bash
# Tunnel is up and egress IP is the VPN's, not yours:
curl --socks5-hostname localhost:10801 https://ifconfig.me

# Follow auth and tunnel events:
docker compose logs -f openconnect-vantage
```

Common failure modes: `VPN authentication failed` after one attempt
usually means host clock skew against the TOTP server — install
`chrony` or `systemd-timesyncd` on the host. A tunnel that comes up
but `curl` hangs is almost always DNS: confirm the path URL uses
`socks5h://` so DNS goes through the tunnel. `ERRNO 1` from
openconnect on startup means `/dev/net/tun` wasn't mounted — check
the `devices:` line.

### SpoofDPI

An `obfuscation`-role baseline: a userspace tool that fragments TLS
ClientHello records and rewrites SNI framing to dodge common
in-country DPI boxes. The upstream `xvzc/SpoofDPI` image speaks
SOCKS5 natively, so no `microsocks` companion is needed and no
container build is required — we run the upstream image directly
with a compose fragment. Use this path to answer *"is local DPI
interference the reason this endpoint is misbehaving, and does
bypassing it restore access?"*

Because no custom image is needed, the "Dockerfile" step collapses
to "use the upstream image." If you want to pin a specific build,
tag a specific commit SHA (`ghcr.io/xvzc/spoofdpi:<sha>`) rather
than `:latest`.

**Compose fragment**:

```yaml
services:
  spoofdpi:
    image: ghcr.io/xvzc/spoofdpi:latest
    ports:
      - "10802:1080"
    command:
      - "-addr"
      - "0.0.0.0"
      - "-port"
      - "1080"
      - "-dns-addr"
      - "1.1.1.1"
      - "-dns-port"
      - "53"
      - "-window-size"
      - "0"
      - "-enable-doh"
    restart: unless-stopped
```

Flag notes: `-window-size 0` lets SpoofDPI pick per-connection
fragmentation heuristically (override with a small integer like `2`
or `8` if a specific DPI box needs a fixed boundary);
`-enable-doh` routes SpoofDPI's own upstream name resolution over
DNS-over-HTTPS so the local resolver isn't part of the picture;
`-dns-addr` sets the DoH resolver. No `cap_add`, no `devices`, no
privileged flags — it's a plain userspace listener.

**Entrypoint**: none. The upstream image's default entrypoint plus
the `command:` override above is the whole story. SpoofDPI is a
single static Go binary that does its own SOCKS5 accept loop.

**Secrets — Pattern A (plaintext `.env`)** is the honest choice here:
there are no secrets. SpoofDPI has no credentials, no keys, no user
state. An empty `.env` (or none at all) is fine. Listing this under
Pattern A is really just acknowledging that for recipes without
secrets, A degenerates to "nothing to do." Patterns B and C apply
equally to any future flags you might want to hide (an upstream DoH
endpoint URL treated as sensitive, for example) — pick by host.

**Path-config entry**:

```toml
name        = "spoofdpi-local"
proxy_url   = "socks5h://localhost:10802"
role        = "obfuscation"
tags        = ["userspace", "tls-fragment", "home"]
description = "SpoofDPI with default fragmentation + DoH upstream"
```

**Verification & troubleshooting**:

```bash
# Exit IP should match your direct baseline — SpoofDPI does not
# change your egress, only how the handshake is framed:
curl --socks5-hostname localhost:10802 https://ifconfig.me

# A site that fails direct but works via SpoofDPI is the signal:
curl --socks5-hostname localhost:10802 -sI https://<blocked-site>/ | head

# Live view of handshake decisions:
docker compose logs -f spoofdpi
```

Common failure modes: if direct works and SpoofDPI also works but
the *exit IP differs*, something's wrong — SpoofDPI should never
change egress; check that no other proxy is chained in front.
`dial tcp: lookup ... no such host` in the logs means DoH is
failing — swap `-dns-addr` to a different resolver
(`9.9.9.9`, `8.8.8.8`). Sites that still don't load via SpoofDPI
when they load via a `vantage` path are outside SpoofDPI's scope:
IP-level blocking can't be fragmented around.

### Tor

A `vantage`-role path whose exit is somewhere else — but *where*
somewhere else is changes per circuit, by design. The Tor daemon
speaks SOCKS5 natively on its default port, so no `microsocks`
companion is needed, and since Tor is anonymous by construction
there are no credentials to manage. Use this path to answer *"what
does this site look like from over there?"* where "there" is
deliberately a random Tor exit rather than a specific chosen egress.
The random-exit property is a feature for cross-geography
comparison and a limitation for any signal rule that assumes a
stable egress IP.

**Dockerfile** (`tor/Dockerfile`). Alpine ships an up-to-date `tor`
package; we install it and an entrypoint that emits a minimal
`torrc` from env vars, so a zero-config user gets a working path
and an operator who wants to narrow the exit set can pass
`TOR_EXIT_COUNTRY` without editing the image:

```dockerfile
FROM alpine:3.20

RUN apk add --no-cache \
      tor \
      bash \
      ca-certificates

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9050
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**Compose fragment**. No `cap_add`, no `devices` — Tor is pure
userspace, making outbound TCP connections to the Tor network and
listening on a local SOCKS5 port:

```yaml
services:
  tor-vantage:
    build: ./tor
    ports:
      - "10804:9050"
    environment:
      TOR_EXIT_COUNTRY: ${TOR_EXIT_COUNTRY:-}   # optional, e.g. {de},{nl}
    restart: unless-stopped
```

**Entrypoint** (`tor/entrypoint.sh`). Render a minimal torrc,
optionally constraining exits, then exec `tor` in the foreground:

```bash
#!/usr/bin/env bash
set -euo pipefail

cat >/etc/tor/torrc <<EOF
SocksPort 0.0.0.0:9050
DataDirectory /var/lib/tor
Log notice stdout
EOF

if [ -n "${TOR_EXIT_COUNTRY:-}" ]; then
  cat >>/etc/tor/torrc <<EOF
ExitNodes ${TOR_EXIT_COUNTRY}
StrictNodes 1
EOF
fi

exec tor -f /etc/tor/torrc
```

Binding `SocksPort` on `0.0.0.0` inside the container is safe
because the container's network namespace is private; the host
port map on `10804` is the access boundary. The default directory
authorities are used — no custom bridges, no `UseBridges 1`.

**Secrets — Pattern A (plaintext `.env`)** degenerates to "nothing
to do" here, same as the SpoofDPI recipe: Tor has no credentials,
no keys, no user state to protect. An empty `.env` (or none at
all) is fine. Patterns B and C apply equally to any future
non-secret config knob you might want to hide — for instance, an
`ExitNodes` country list you consider sensitive for
threat-model reasons — pick by host.

**Path-config entry**:

```toml
name        = "tor-random"
proxy_url   = "socks5h://localhost:10804"
role        = "vantage"
tags        = ["tor", "anonymous", "random-exit", "slow"]
description = "Tor daemon, default directory authorities"
```

**Verification & troubleshooting**:

```bash
# Authoritative check: Tor project's own "are you using Tor?" API.
# Returns {"IsTor": true, "IP": "<some-exit-ip>"}:
curl --socks5-hostname localhost:10804 https://check.torproject.org/api/ip

# Follow bootstrap and circuit events:
docker compose logs -f tor-vantage
```

Common failure modes: the first-time bootstrap takes roughly 10–30
seconds while Tor downloads a consensus and builds its first
circuits — verification calls made during that window fail with
`SOCKS5 connection failed` and are not a bug; wait for
`Bootstrapped 100%` in the logs. Some sites block Tor exit IPs
outright; this surfaces as HTTP 403 or a CAPTCHA wall rather than a
connection failure and is not fixable from the client side. Tor
rotates circuits roughly every 10 minutes by default, so the exit
IP — and thus the apparent geolocation — will change between probe
intervals; any signal rule comparing Tor results to a stable
`vantage` baseline needs to account for that, which is what
`random-exit` in the tags is there to flag.

## Adding your own recipe

If none of the above recipes matches your proxy of choice (Hysteria,
VLESS/Xray, shadowsocks-rust, a residential-proxy vendor's SDK,
something exotic), the generic pattern is:

1. **Pick a base image.** Alpine is usually fine; Debian-slim if the
   proxy tool ships only glibc binaries.
2. **Install the proxy tool**, plus `microsocks` (or equivalent) if
   the tool does not speak SOCKS5 natively. `microsocks` is ~40 KB
   and provides a dead-simple SOCKS5 server against the container's
   default interface.
3. **Write an entrypoint** that starts the underlying proxy tool
   in the background, waits for its interface or socket to be
   ready, then starts `microsocks` in the foreground on the
   container's listen port.
4. **Add capabilities** (`cap_add: NET_ADMIN`, `devices: /dev/net/tun`)
   only if the tool needs kernel-level networking (VPN tunnels, raw
   packet manipulation). Leave them off for pure userspace proxies.
5. **Map an unused `108xx` port** from the host to the container's
   SOCKS5 port in `compose.yaml`.
6. **Pick a secrets pattern** (A, B, or C) appropriate to the
   credential needs.
7. **Add a path entry** in the main config (illustrative shape,
   exact format pending the Configuration sub-document):

   ```
   name        = "my-custom-path"
   proxy_url   = "socks5h://localhost:108XX"
   role        = "obfuscation"     # or vantage
   tags        = ["my-tag"]
   description = "brief note to future-me"
   ```

That is the whole contract.

### Worked example: plugging in a pre-existing Hysteria VPS

Scenario: you already run a personal Hysteria v2 server on a
foreign VPS, listening on UDP/443 at `vps.example.net`, and you hold
the auth string it expects. You want the application to see that
server as a `vantage` path — a QUIC-transported tunnel to a
non-local exit. Walking through the 7-step pattern:

**1. Base image.** `alpine:3.20`. Hysteria ships a static linux-amd64
binary, so Alpine works without glibc gymnastics.

**2. Install the proxy tool + microsocks.** The Hysteria v2 client
does expose a SOCKS5 listener itself, so strictly speaking microsocks
is unnecessary — but keeping microsocks in the picture makes the
container shape identical to other `vantage` recipes (Hysteria talks
to localhost, microsocks is the thing bound on the host port) and
means swapping the underlying transport later touches only the
entrypoint.

**Dockerfile** (`hysteria/Dockerfile`). We fetch the release binary
directly with `wget` rather than using a multi-stage Go build — it's
one file, upstream signs it, and we avoid an unnecessary toolchain:

```dockerfile
FROM alpine:3.20

ARG HYSTERIA_VERSION=v2.6.0

RUN apk add --no-cache \
      ca-certificates \
      microsocks \
      bash \
      wget \
 && wget -O /usr/local/bin/hysteria \
      "https://github.com/apernet/hysteria/releases/download/app/${HYSTERIA_VERSION}/hysteria-linux-amd64" \
 && chmod +x /usr/local/bin/hysteria

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 1080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**3. Compose fragment.** No `cap_add`, no `devices` — Hysteria is
pure userspace, speaking QUIC over UDP outbound. Credentials come
in as Docker secrets (Pattern C, picked here to show the third
pattern end-to-end):

```yaml
services:
  hysteria-vantage:
    build: ./hysteria
    ports:
      - "10803:1080"
    environment:
      HY_SERVER: ${HY_SERVER}              # e.g. vps.example.net:443
      HY_SNI: ${HY_SNI:-}                  # optional override
    secrets:
      - hysteria_auth
    restart: unless-stopped

secrets:
  hysteria_auth:
    file: ./secrets/hysteria_auth
```

The `hysteria_auth` file on disk contains a single line: the auth
string the VPS expects. `chmod 600 ./secrets/hysteria_auth` and keep
that directory out of version control.

**4. Entrypoint** (`hysteria/entrypoint.sh`). Render a minimal
client config from env + the mounted secret, start the Hysteria
client listening on `127.0.0.1:1081`, wait for the socket to accept,
then exec microsocks in the foreground on `:1080`:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${HY_SERVER:?missing}"
AUTH=$(cat /run/secrets/hysteria_auth)

cat >/tmp/hysteria.yaml <<EOF
server: ${HY_SERVER}
auth: ${AUTH}
tls:
  sni: ${HY_SNI:-${HY_SERVER%%:*}}
  insecure: false
socks5:
  listen: 127.0.0.1:1081
EOF

hysteria client -c /tmp/hysteria.yaml &
HY_PID=$!

cleanup() { kill "$HY_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Wait up to 20s for the local SOCKS listener to accept.
for _ in $(seq 1 40); do
  if (echo > /dev/tcp/127.0.0.1/1081) 2>/dev/null; then
    break
  fi
  sleep 0.5
done

exec microsocks -i 0.0.0.0 -p 1080 -1
```

The `-1` on microsocks is optional: it disables its built-in auth
so the container listens unauthenticated on its internal port — the
host-port binding on `10803` is the access boundary.

**5. Secrets pattern.** Pattern C, as above: the auth string lives
in `./secrets/hysteria_auth`, compose mounts it at
`/run/secrets/hysteria_auth`, the entrypoint reads it with `cat`.
Nothing Hysteria-related is in any environment variable that
`docker inspect` would leak. Patterns A (auth string as
`HY_AUTH` in `.env`) and B (wrapper script pulling it from
`secret-tool`) apply equally.

**6. Path-config entry**:

```toml
name        = "hysteria-vps"
proxy_url   = "socks5h://localhost:10803"
role        = "vantage"
tags        = ["my-vps", "quic", "udp", "foreign-exit"]
description = "Personal Hysteria v2 client → foreign VPS"
```

**7. Verification & troubleshooting**:

```bash
# Egress IP should be your VPS's public IP:
curl --socks5-hostname localhost:10803 https://ifconfig.me

# Follow handshake + QUIC session events:
docker compose logs -f hysteria-vantage
```

Common failure modes: `connection refused` from `curl` while logs
show `client up and running` means microsocks raced the Hysteria
listener — bump the readiness loop or check that
`socks5.listen` in the generated config matches what the wait
loop is polling. `tls: handshake failure` usually means `HY_SNI`
doesn't match the VPS's certificate — set it explicitly. If the
tunnel connects but traffic is sluggish, the VPS's
bandwidth/congestion-control settings in its server config are
the usual culprit, not the client.

---

*Status: v0 draft. Cookbook recipes complete.*
