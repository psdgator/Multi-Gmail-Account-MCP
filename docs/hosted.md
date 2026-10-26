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

Connectors added on the web also appear in the Claude mobile apps. On Team and Enterprise plans an owner may need to add the connector for the organisation first.

Claude's OAuth callback is `https://claude.ai/api/mcp/auth_callback` (and, in future, `https://claude.com/api/mcp/auth_callback`). Both are allowed by default.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness; returns name and version only |
| `GET /.well-known/oauth-protected-resource/mcp` (also without `/mcp`) | none | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 server metadata |
| `POST /register` | none (rate-limited, redirect allow-list) | Dynamic client registration |
| `GET /authorize` | none | Shows the password page |
| `POST /oauth/approve` | CSRF + password | Issues a one-time code |
| `POST /token`, `POST /revoke` | client credentials | Tokens, refresh, revocation |
| `POST/GET/DELETE /mcp` | **Bearer token** | MCP (Streamable HTTP, sessions) |

## Security model

- **Nothing is reachable without the password.** Anyone can register an OAuth client, but only someone who knows `GMAIL_MCP_HTTP_PASSWORD` can approve it. The server refuses to start if the password is missing or shorter than 12 characters.
- **Brute force:**
  - The password is compared in constant time.
  - 5 wrong attempts from one IP lock that IP for 15 minutes; 25 failures overall lock the form for everyone for 15 minutes.
  - Each failure is answered slowly.
  - The SDK also rate-limits the OAuth endpoints.
- **OAuth 2.1:**
  - PKCE (S256) is mandatory.
  - Authorization codes are single-use and expire after 5 minutes. Replaying a code revokes the tokens it produced.
  - Access tokens are random 256-bit values that last 1 hour.
  - Refresh tokens last 30 days and **rotate** on every use. Reusing an old refresh token revokes the whole session.
  - Tokens are bound to this server's `/mcp` resource (RFC 8707), so tokens issued for any other resource are refused.
- **Storage:**
  - Tokens are stored only as SHA-256 hashes. The token/client file (`/data/http-auth.json`) and all mail logins are encrypted with AES-256-GCM using `GMAIL_MCP_MASTER_KEY`.
  - **Back up that key.** Without it the stored logins can't be decrypted. If it leaks, rotate it and sign in again.
- **Redirects:** only Claude's callback URLs and loopback addresses (for local tools) may be registered. Override with `GMAIL_MCP_HTTP_ALLOWED_REDIRECTS` (exact URIs, or prefixes ending in `*`). Use `--no-loopback-redirects` to drop loopback.
- **Browser protections:**
  - The `Host` header must be your domain, which protects against DNS rebinding.
  - Browser `Origin`s other than your domain and claude.ai/claude.com are refused.
  - The login page sends strict CSP, `frame-ancestors 'none'` and `no-store` headers, plus a SameSite=Strict, HttpOnly CSRF cookie.
- **Sessions:** each MCP session belongs to the client that opened it. Another client's token can't use it. Idle sessions close after 30 minutes.
- **Reduced tools:** `save_attachment` (it would write to the server's disk) and `authenticate` are not offered in hosted mode. Use `read_attachment` and the CLI instead.
- **Audit log:** every tool call is logged to `/data/audit.log` with `"via":"http"`. Ask Claude for `view_audit_log`, or run `docker compose run --rm app audit`.
- **Signing everything out:** run `docker compose run --rm app http-logout --clients`. You can also change the password and restart.
- **Mode:** keep `drafts` (never sends) or `readonly` unless you really want Claude to send mail from the web.

Email content is untrusted. A malicious email can contain instructions aimed at the AI. The server tells Claude to ignore those, and `drafts` mode keeps the damage limited to drafts you review.

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
| "Too many wrong passwords" | Wait 15 minutes, or restart the app |
| Tools work, but an account fails | `docker compose run --rm app doctor`; re-run `auth … --manual` for that account |
| Everything signed out after a restart | `GMAIL_MCP_MASTER_KEY` changed; restore the old key |
