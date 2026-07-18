# Treble-Makers Arena

A World Darts League (WDL) darts arena web app. Players authenticate, create or join live matches (human, bot, or tournament brackets) with optional webcam feeds, and play X01, Cricket, Tactics, Halve-It, Shanghai, Golf Darts, Golf Checkouts, Football, Snakes & Ladders, Around the Clock, Killer, and High Score.

The landing page also shows live **WDL** and **Lazy Leagues** division standings via server-side proxies.

## Architecture

| Layer | What |
|-------|------|
| **Source** | `index.html` — hand-edited SPA with inline `<style>` and `<script>` |
| **Build** | `npm run build` → `public/` (`index.html` + minified `app.css` + `app.js` + WebP assets) |
| **Server** | `server.js` — Express (static + API) + WebSocket game server |
| **Database** | `data.json` — single JSON file (users, stats, tournaments) |

Only `public/` is web-exposed. `server.js`, `data.json`, `scripts/`, and source artwork never ship to browsers.

```
index.html  ──build.js──►  public/index.html
              │            public/app.css   (minified)
              │            public/app.js    (minified)
              │            public/**/*.webp (optimized assets)
              ▼
         server.js  ──►  data.json  (debounced atomic writes + backups/)
```

### Data store caveat

`data.json` is a simple file-backed database. It works well for a single-server deployment with moderate traffic. For higher scale (many concurrent writes, replication, audit trails), migrate to **SQLite** via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — synchronous, transactional, no extra process. The server already uses write-behind + atomic rename to minimize corruption risk at current scale.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (includes `npm`)

## Install

```bash
npm install
```

## Build & run

```bash
# Full production start: build client bundle, then serve
npm start

# Serve only (skip rebuild — use when public/ is already current)
npm run serve

# Rebuild client bundle without starting the server
npm run build
```

Open **http://localhost:3000** (or your configured `PORT`).

### Image pipeline

Run when artwork changes (not needed on every deploy):

```bash
# Resize + convert landing/crest backgrounds to WebP
npm run images

# Trim Golf Checkouts hole PNGs → golf_imgs/hole-N.webp
npm run golf-images

# Remove crest backgrounds (reads from */_originals/, writes transparent PNGs)
node scripts/remove-crest-bg.js

npm run build   # copy new WebP into public/
```

**Source-of-truth art** (keep in repo):

- `treble_arena_background.png` → `treble_arena_background.webp`
- `treblemak_crests/_originals/` → `remove-crest-bg.js` → `Treble-makers_Main_Crest.png` → WebP
- `wdl-images/_originals/` → same pipeline for WDL crests
- `lazy-images/_originals/` + `LazyLeagues_Crest_metal.png` → Lazy Leagues partner crest
- `Golf Darts/par-3-course.png` → WebP
- `golf_imgs/Hole N.png` → `trim-golf-courses.js` → `hole-N.webp`

`public/` is **generated** and gitignored — always run `npm run build` (or `npm start`) before deploy.

## Environment variables

Copy `.env.example` → `.env` and adjust. The server loads `.env` automatically via `dotenv`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP + WebSocket listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Shown in `/healthz` |
| `SOFT_LAUNCH` | off | `1` = invite-only soft launch defaults |
| `TRUST_PROXY` | `0` | Set `1` behind HTTPS reverse proxy |
| `ADMIN_USERNAME` | `GViking01` | Seeded admin username (first run) |
| `ADMIN_PASSWORD` | (random) | Seeded admin password (first run) |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost (8–15) |
| `SESSION_TTL_MS` | 30 days | Opaque session token lifetime |
| `BACKUP_INTERVAL_MS` | `21600000` (6 h) | How often to snapshot `data.json` |
| `MAX_BACKUPS` | `10` | Retained backup files in `backups/` |
| `BACKUP_OFFSITE_DIR` | — | Copy each backup to this directory |
| `BACKUP_OFFSITE_CMD` | — | Shell command; backup path is `$1` |
| `TURN_URLS` | — | Comma-separated TURN URLs for WebRTC |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | TURN auth |
| `SENTRY_DSN` | — | Optional; requires `@sentry/node` |
| `API_RATE_MAX` | `60` | `/api/*` requests per IP per minute |
| `MAX_WS_PER_IP` | `25` | Concurrent WebSocket connections per IP |
| `MAX_MSGS_PER_SEC` | `40` | WebSocket messages per socket per second |
| `AUTH_MAX_ATTEMPTS` | `15` | Register/login attempts per IP per 5 min |
| `RESEND_API_KEY` | — | Resend API key for password-reset emails |
| `EMAIL_FROM` | — | Verified Resend sender, e.g. `Treble-Makers <noreply@yourdomain.com>` |
| `APP_URL` | — | Public base URL for reset links (no trailing slash) |
| `PASSWORD_RESET_TTL_MS` | 1 hour | Password-reset token lifetime |
| `LAZY_LEAGUES_EMAIL` | — | Lazy Leagues Firebase sign-in (optional) |
| `LAZY_LEAGUES_PASSWORD` | — | Lazy Leagues Firebase sign-in (optional) |
| `LAZY_LEAGUES_TOKEN` | — | Pre-made Firebase ID token (overrides above) |

If Lazy Leagues credentials are missing, `/api/lazy-standings` returns 502 gracefully; the rest of the app works normally. A local `lazy-credentials.json` (gitignored) is also supported as a dev fallback.

## Backups

On startup, every `BACKUP_INTERVAL_MS`, and on graceful shutdown, the server copies `data.json` to `backups/data-<timestamp>.json` and prunes to `MAX_BACKUPS` files. The `backups/` folder is gitignored — copy it off-server for disaster recovery.

## Production deployment

See **[docs/SOFT_LAUNCH.md](docs/SOFT_LAUNCH.md)** for the recommended soft-launch path (VPS + Caddy + PM2 + Cloudflare, invite-only testers).

1. **Build on deploy:** `npm install && npm run build`
2. **HTTPS:** Terminate TLS at Caddy (see `Caddyfile`), nginx, or your PaaS — do not expose Node directly on the public internet.
3. **Proxy trust:** Set `TRUST_PROXY=1` so rate limits and auth throttling see real client IPs.
4. **Soft launch:** Set `SOFT_LAUNCH=1` for invite-only testing (guests off; approve testers in Arena Access).
5. **Process manager:** Use PM2 or a PaaS Procfile:

   ```bash
   # PM2 (recommended for VPS)
   npm install -g pm2
   cp .env.example .env    # SOFT_LAUNCH=1, TRUST_PROXY=1, ADMIN_PASSWORD=...
   pm2 start ecosystem.config.js --env production
   pm2 save && pm2 startup

   # Heroku / Railway / Render (needs a persistent volume for data.json)
   # Procfile runs: npm start
   ```

6. **Health check:** Point your monitor at `GET /healthz` (returns JSON with `status: "ok"`, uptime, client/room counts, `softLaunch`).
7. **Admin password:** Set `ADMIN_PASSWORD` before first run, or change it immediately after login. Legacy `admin123` forces a password change.
8. **Offsite backups:** Set `BACKUP_OFFSITE_DIR` / `BACKUP_OFFSITE_CMD`, or cron `npm run backup:offsite`.

## Default admin account

On first run (when `data.json` does not exist), an admin is seeded:

- **Username:** `ADMIN_USERNAME` (default `GViking01`)
- **Password:** `ADMIN_PASSWORD` from env, or a random one-time password printed in the server log

**Change this password after first login.** Sessions use opaque tokens (passwords are never stored in the browser). Do not expose port 3000 without TLS in production.

## Project layout

```
index.html          Source SPA (edit this, then build)
server.js           Express + WebSocket server
data.json           Live database (users, tournaments) — back up regularly
build.js            Splits/minifies index.html → public/
scripts/
  optimize-images.js    PNG/JPG → WebP resize pipeline
  trim-golf-courses.js  Golf Checkouts hole art
  remove-crest-bg.js    Crest background removal (jimp)
public/             Generated client bundle (gitignored)
backups/            Timestamped data.json snapshots (gitignored)
docs/               Game rules reference
treblemak_crests/   Main crest source art + _originals/
wdl-images/         WDL crest source art + _originals/
lazy-images/        Lazy Leagues partner crest art + _originals/
golf_imgs/          Golf Checkouts hole source PNGs + WebP output
Golf Darts/         Golf Darts course illustration source
```

## Security notes

- `helmet` + CSP headers protect the externalized client bundle.
- Auth and WebSocket connections are rate-limited per IP.
- Login sessions use opaque tokens (hashed server-side); passwords are never stored in `localStorage`.
- Registration requires a unique email. Forgot-password sends a one-time reset link via Resend (`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`) — passwords are never emailed.
- `data.json` and `server.js` are **not** downloadable — requests fall through to the SPA shell without exposing secrets.
- Soft launch (`SOFT_LAUNCH=1`) keeps the arena invite-only until you open it for full launch.
