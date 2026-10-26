# Hosted mode (claude.ai on web and mobile)

By default gmail-mcp-multi runs on your computer and talks to the Claude desktop app over stdio. **Hosted mode** runs the same server on a machine on the internet, so you can add it in **claude.ai as a custom connector** and use your mailboxes from the browser and the Claude mobile apps too.

```
Claude (web / mobile / desktop)
        │ HTTPS  (OAuth 2.1 bearer token)
        ▼
  Caddy (TLS, Let's Encrypt)  ──►  gmail-mcp-multi serve-http  ──►  Gmail API / IMAP
        your server                      /data: encrypted logins, tokens, audit log
```

Anthropic's servers call your connector, so it must be reachable over **public HTTPS**. Nothing can use it without the access password you set.

## What you need

- A small Linux server with a public IP that can run Docker and keep a process running. Ports 80 and 443 must be open.
  - A Hetzner **Cloud** VPS (CX22 or similar) is ideal.
  - Hetzner **managed** web hosting (`*.your-server.de`) usually can't run Docker or long-running Node processes, so it won't work here.
  - A homelab box behind a tunnel works too; see [Homelab via Cloudflare Tunnel](#homelab-via-cloudflare-tunnel).
- A host name, e.g. `mail-mcp.example.com`, with a DNS **A/AAAA record** pointing to the server.
- The Google OAuth client JSON you already use (the same *Desktop app* client works).
- A Claude plan that supports custom connectors (Pro, Max, Team or Enterprise).

## Set up with Docker + Caddy

```bash
git clone https://github.com/psdgator/Multi-Gmail-Account-MCP.git gmail-mcp
cd gmail-mcp

cp deploy/env.example .env
#   MCP_DOMAIN=mail-mcp.example.com
#   GMAIL_MCP_HTTP_PASSWORD=$(openssl rand -base64 24)    # you'll type this once per device
#   GMAIL_MCP_MASTER_KEY=$(openssl rand -base64 32)       # BACK THIS UP
#   GMAIL_MCP_MODE=drafts
nano .env

mkdir -p secrets
cp /path/to/client_secret_XXXX.apps.googleusercontent.com.json secrets/oauth-keys.json

docker compose up -d --build
curl https://mail-mcp.example.com/healthz          # {"ok":true,...}
```

Caddy gets the certificate automatically on first start. If `healthz` fails, check `docker compose logs caddy` (DNS not pointing to the server yet, or ports 80/443 blocked).

### Add mail accounts on the server

There is no browser on the server, so Gmail sign-in uses a copy-paste step:

```bash
docker compose run --rm app auth shop you@gmail.com --manual
```

1. Open the printed link on your own computer and approve access.
2. The browser then shows *"This site can't be reached"* at `127.0.0.1:…`. That is expected. Copy the **whole address** from the address bar.
3. Paste it into the terminal. The login is stored encrypted in the `/data` volume.

Repeat for each account. Then check the setup:

```bash
docker compose run --rm app accounts
docker compose run --rm app doctor
```

You can also copy an existing setup instead: the accounts and logins in `~/.gmail-mcp` can be moved, but they are encrypted with your PC's key. It's simpler to run `auth` again on the server.

### Connect Claude

1. In claude.ai, open **Settings → Connectors → Add custom connector**.
2. Name: `Gmail (all accounts)`. URL: `https://mail-mcp.example.com/mcp`.
3. Click **Connect**. A page from your server asks for the **access password**. Enter it and click **Allow**.
4. Enable the connector in a chat (the tools menu) and ask: *"What's unread across all my accounts?"*
5. Check that the server saw your real address (the brute-force protections depend on it; see [Real client addresses](#real-client-addresses-proxies-and-containers)):

   ```bash
   docker compose logs app | grep "sign-in:"
   # [gmail-mcp-multi] sign-in: approved from 203.0.113.7 for client "Claude"
   ```

Connectors added on the web also appear in the Claude mobile apps. On Team and Enterprise plans an owner may need to add the connector for the organisation first.

Claude's OAuth callback is `https://claude.ai/api/mcp/auth_callback` (and, in future, `https://claude.com/api/mcp/auth_callback`). Both are allowed by default.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness; returns name and version only |
| `GET /.well-known/oauth-protected-resource/mcp` (also without `/mcp`) | none | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 server metadata |
| `POST /register` | none (20 per hour per IPv4 address / IPv6 /48, body at most 8 kB, redirect allow-list) | Dynamic client registration |
| `GET /authorize` | none (30 per 15 min per IP / IPv6 /64, and 60 per IPv6 /48) | Shows the password page |
| `POST /oauth/approve` | CSRF + password (20 per 15 min per IP / IPv6 /64) | Issues a one-time code |
| `POST /token`, `POST /revoke` | client credentials | Tokens, refresh, revocation |
| `POST/GET/DELETE /mcp` | **Bearer token** | MCP (Streamable HTTP, sessions) |

## Security model

- **Nothing is reachable without the password.** Anyone can register an OAuth client, but only someone who knows `GMAIL_MCP_HTTP_PASSWORD` can approve it. The server refuses to start if the password is missing or shorter than 12 characters.
- **Brute force:**
  - The password is compared in constant time.
  - **One guess per sign-in request.** A wrong password cancels the request; another try means starting the connection again from the app (a new `/authorize`).
  - **Global speed limit.** Password checks run one at a time for the whole server, and each takes at least 0.4 seconds. That caps guessing at about 2.5 per second in total, however many addresses or connections an attacker uses. At most 20 checks wait in line, and one IPv4 address or IPv6 /64 can hold only 2 places in it (one IPv6 /48: 4), so a single attacker can't fill it. When the line (or the sender's share of it) is full, the page answers `429` with `Retry-After` at once; nothing is checked, so you can press **Allow** again after the wait. These "busy" answers don't count against the `/oauth/approve` rate limit below.
  - **Lockouts.** 5 wrong attempts from one IP (for IPv6: from one /64 network) lock that address. 50 failures across the /64s of one IPv6 /48 lock the whole /48. The first lock lasts 5 minutes, and each further lock doubles, up to 1 hour. Requests from a locked address are answered at once, without waiting in line or taking its 0.4 seconds. The lockout memory is bounded (10,000 networks; expired entries are dropped).
  - There is no global lock. Your correct password from another network is never refused because of someone else's attempts; at most it waits behind a few others in the line.
  - **Rate limits:** `/authorize` 30 requests per 15 minutes per IP (IPv6: per /64) and 60 per IPv6 /48; `/oauth/approve` 20 per 15 minutes per IP (IPv6: per /64); `/register` 20 per hour per IPv4 address or IPv6 /48. The SDK also rate-limits the other OAuth endpoints.
  - **Open sign-in requests** (password pages not yet answered) expire after 10 minutes. Each network (IPv4 address or IPv6 /48) keeps at most 20; a new one drops that network's oldest. At most 5,000 are open in total; when that is reached, the network with the most open requests loses its oldest, so one network can't push out yours.
  - Every password check is logged with the address the server sees: `sign-in: wrong password from …`, `… is locked for 5 min`, `sign-in: approved from …`. These protections only work if that is the client's real address; see [Real client addresses](#real-client-addresses-proxies-and-containers).
- **OAuth 2.1:**
  - PKCE (S256) is mandatory.
  - Authorization codes are single-use and expire after 5 minutes. Replaying a code revokes the tokens it produced.
  - Access tokens are random 256-bit values that last 1 hour.
  - Refresh tokens last 30 days and **rotate** on every use. Reusing an old refresh token revokes the whole session. The exception is a reuse within 60 seconds, which covers a lost response or two refreshes at once.
  - Tokens are bound to this server's `/mcp` resource (RFC 8707), so tokens issued for any other resource are refused.
- **Storage:**
  - Tokens are stored only as SHA-256 hashes. The token/client file (`/data/http-auth.json`) and all mail logins are encrypted with AES-256-GCM using `GMAIL_MCP_MASTER_KEY`.
  - `http-auth.json` is written to a temporary file that is then renamed over the old one, so it is never seen half-written. Before every operation the server re-reads it if it changed (for example after `http-logout`).
  - Every change (read, modify, write) holds a lock file, `http-auth.json.lock`, so the server and `http-logout` (or a second process) never write over each other: a sign-out can't be undone by a save that was in progress. The other side waits for the lock (up to 2 seconds, then the request fails with "try again" and nothing is changed). A lock file older than 10 seconds was left behind by a crashed process and is removed automatically.
  - If the changed file can't be read (damaged, or a different key), the server answers `500` and changes nothing until it can be read again. It never answers from, or writes back, its older copy. A save is also refused if the file changed while the request was handled (e.g. a backup restored by hand). `http-logout` replaces an unreadable file with an empty one.
  - **Back up that key.** Without it the stored logins can't be decrypted. If it leaks, rotate it and sign in again.
- **Redirects:** only Claude's callback URLs and loopback addresses (for local tools) may be registered.
  - Override with `GMAIL_MCP_HTTP_ALLOWED_REDIRECTS`: exact URIs, or prefixes ending in `*`.
  - A prefix only matches at a boundary (`/`, `?`, `#` or the end), so `https://app.example.com*` does not match `https://app.example.com.evil.net`.
  - Use `--no-loopback-redirects` to drop loopback.
- **Client registrations:**
  - The request body may be at most 8 kB. Only the metadata the server uses is kept: up to 5 redirect URIs of at most 500 characters each (all must be allowed, see above), the client name (cut to 100 characters; it is shown on the password page), and the short OAuth fields (auth method, grant and response types, scope). Everything else (logos, contacts, keys, …) is dropped, and a stored client is at most 4 kB, so even a full client list keeps `http-auth.json` small.
  - Clients that registered but never completed a sign-in ("never used") are dropped after 1 hour. Each network (IPv4 address or IPv6 /48) keeps at most 10 of them; registering another drops that network's oldest.
  - At most 500 clients are kept. When the limit is reached, room is made by dropping, in this order:
    - never-used clients, from the network with the most of them first, oldest first; each network's newest one is kept for its first 15 minutes (that is you, typing the password);
    - clients that hold no valid token and haven't obtained one for 90 days.

    A client that holds a valid token, or is between the password page and its token request, is never dropped. If nothing can be dropped, registration fails until room is made (at the latest after 15 minutes) or `http-logout --clients` is run.
  - claude.ai registers from Anthropic's servers, so all its registrations share these per-network limits. That is fine for one user, but someone else adding your server's URL to their own claude.ai many times can slow down your next registration.
- **Browser protections:**
  - The `Host` header must be your domain, which protects against DNS rebinding.
  - Browser `Origin`s other than your domain and claude.ai/claude.com are refused.
  - The login page sends strict CSP, `frame-ancestors 'none'` and `no-store` headers, plus a SameSite=Strict, HttpOnly CSRF cookie.
- **Sessions:** each MCP session belongs to the client that opened it. Another client's token can't use it. Idle sessions close after 30 minutes.
- **Reduced tools:** `save_attachment` (it would write to the server's disk) and `authenticate` are not offered in hosted mode. Use `read_attachment` and the CLI instead.
- **Audit log:** every tool call is logged to `/data/audit.log` with `"via":"http"`. Ask Claude for `view_audit_log`, or run `docker compose run --rm app audit`.
- **Signing everything out:**
  - Run `docker compose run --rm app http-logout` (add `--clients` to also forget registered apps). The running server picks this up at once; no restart needed.
  - **Changing the access password also signs everything out.** At startup the server compares the configured password with a fingerprint of the previous one (scrypt, stored in the encrypted `http-auth.json`; the password itself is never stored). If it changed, every token is revoked and Claude must connect again with the new password.
- **Mode:** keep `drafts` (never sends) or `readonly` unless you really want Claude to send mail from the web.

Email content is untrusted. A malicious email can contain instructions aimed at the AI. The server tells Claude to ignore those, and `drafts` mode keeps the damage limited to drafts you review.

## Real client addresses (proxies and containers)

The lockouts, rate limits and per-network caps above are all keyed on the client's IP address (IPv6: its /64 or /48). They only work if the server sees each client's **real** address. If every client appears as the same address (a proxy, a container gateway), they share one budget: a few wrong guesses by anyone can then lock you out for minutes, and one attacker's requests count as yours.

How to check: sign in once, then look at the log line the server writes:

```bash
docker compose logs app | grep "sign-in:"          # or: journalctl -u gmail-mcp-multi | grep "sign-in:"
# good: sign-in: approved from 203.0.113.7 …     (your public IPv4 or IPv6 address)
# bad:  sign-in: approved from 172.18.0.1 …      (a Docker gateway, 10.x, 127.0.0.1, ::1, or one address for everyone)
```

- **The setup in `deploy/` is correct as shipped:** Caddy adds the client address in `X-Forwarded-For`, and `GMAIL_MCP_TRUST_PROXY=uniquelocal` (in `docker-compose.yml`) makes the server believe that header only when it comes from a private address, i.e. from Caddy on the Docker network. Caddy itself does not trust `X-Forwarded-For` sent by clients, so it can't be forged from outside.
- Without Docker (systemd + Caddy/nginx on the same machine) keep the default `GMAIL_MCP_TRUST_PROXY=loopback`. Behind another proxy or load balancer, set it to that proxy's address or the number of proxy hops (Express "trust proxy" syntax); with no proxy at all, set `false`.
- **Rootless Docker or Podman** forward published ports through a user-space helper, and with the default settings that often hides the client address (rootless Docker's `builtin` port driver, Podman's `rootlesskit` port handler): every client appears as one internal address. Switch to a port driver that keeps source addresses (see your engine's rootless networking docs), use rootful Docker, or run Caddy on the host and proxy to the app.
- **IPv6 through Docker's userland proxy:** when the containers have no IPv6, Docker accepts IPv6 connections on the host and forwards them over IPv4 from its gateway address (e.g. `172.18.0.1`). All IPv6 clients then share that address. Enable IPv6 on the Docker network (`enable_ipv6` and an IPv6 subnet in `docker-compose.yml`, with `ip6tables` on, the default in recent Docker), remove the AAAA record, or run Caddy on the host.
- **Cloudflare Tunnel:** the server sees `cloudflared` on loopback; keep `loopback`. The client address then comes from the `X-Forwarded-For` header Cloudflare adds; check the log line as above.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_MCP_PUBLIC_URL` | (required) | Public origin, e.g. `https://mail-mcp.example.com` (no path) |
| `GMAIL_MCP_HTTP_PASSWORD` / `_FILE` | (required) | Access password, 12+ chars (or a file containing it) |
| `GMAIL_MCP_MASTER_KEY` | (required in Docker) | 32-byte key (base64/hex) encrypting logins and tokens |
| `GMAIL_MCP_MODE` | `drafts` | `readonly`, `drafts` or `full` |
| `GMAIL_MCP_HTTP_PORT` / `GMAIL_MCP_HTTP_HOST` | `8787` / `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `GMAIL_MCP_TRUST_PROXY` | `loopback` (`uniquelocal` in compose) | Which proxy may set `X-Forwarded-For` (Express syntax) |
| `GMAIL_MCP_HTTP_ALLOWED_REDIRECTS` | Claude callbacks | Comma-separated redirect URIs/prefixes |
| `GMAIL_MCP_HTTP_ALLOW_LOOPBACK` | `1` | `0` to refuse localhost redirect URIs |
| `GMAIL_MCP_HTTP_ALLOWED_HOSTS` | public host + loopback | Extra accepted `Host` names |
| `GMAIL_MCP_HTTP_ALLOWED_ORIGINS` | public origin + claude.ai/com | Extra accepted browser `Origin`s |
| `GMAIL_MCP_OAUTH_KEYS` | `/data/oauth-keys.json` | Path to the Google OAuth client JSON |
| `GMAIL_MCP_HOME` | `/data` | Config/logins/tokens/audit folder |

## Without Docker (systemd)

See [`deploy/systemd/gmail-mcp-multi.service`](../deploy/systemd/gmail-mcp-multi.service). It contains the install steps, a hardened unit and the env file layout. Put Caddy or nginx in front, proxying `https://your-host` to `127.0.0.1:8787` (disable response buffering for `/mcp`).

## Homelab via Cloudflare Tunnel

To avoid opening ports at home:

1. Run `gmail-mcp-multi serve-http --host 127.0.0.1 --public-url https://mail-mcp.example.com`.
2. Point a **Cloudflare Tunnel** public hostname at `http://localhost:8787`.
3. Keep `GMAIL_MCP_TRUST_PROXY=loopback`.

Note that TLS then ends at Cloudflare, which can see the traffic. A VPS with Caddy keeps the encryption end-to-end to your own machine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude says the connector failed to connect | `curl https://host/healthz` from outside; check DNS, ports 80/443, `docker compose logs` |
| `redirect_uri not allowed` | Add Claude's callback to `GMAIL_MCP_HTTP_ALLOWED_REDIRECTS` if it changed |
| `403 Invalid Host` | The request used a host name other than `GMAIL_MCP_PUBLIC_URL`; add it to `GMAIL_MCP_HTTP_ALLOWED_HOSTS` |
| "Wrong password" | The sign-in request was cancelled. Click **Connect** in Claude again and enter the right password |
| "Too many wrong passwords" | Wait the time shown (5 minutes for a first lock; it doubles for repeated locks from the same address), connect from another network, or restart the app. If it happens although you typed the right password, check that the server sees real client addresses ([see above](#real-client-addresses-proxies-and-containers)) |
| "The server is busy with other sign-in attempts" / `429 Too many requests` | Someone is trying many passwords. Wait the time shown and try again; see the logs and consider changing the password |
| `500` errors and `could not read …http-auth.json` in the logs | The token file is damaged or the encryption key changed. Restore the key (or file), or run `http-logout` to reset it; everyone then connects again |
| Tools work, but an account fails | `docker compose run --rm app doctor`; re-run `auth … --manual` for that account |
| Everything signed out after a restart | `GMAIL_MCP_MASTER_KEY` changed; restore the old key |
