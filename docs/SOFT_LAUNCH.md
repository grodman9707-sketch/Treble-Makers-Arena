# Soft launch guide

Invite-only online testing before full public launch. Testers register; you approve them in **Arena Access**.

## Recommended host

**DigitalOcean Droplet or Hetzner Cloud VPS** (2 vCPU / 2–4 GB RAM) + **Caddy** (HTTPS) + **PM2** + **Cloudflare** DNS (orange-cloud proxy optional; enable WebSockets).

Avoid Vercel/Netlify — this app needs long-lived WebSockets and a persistent `data.json` disk.

## One-time VPS setup

```bash
# On the VPS (Ubuntu example)
sudo apt update && sudo apt install -y nodejs npm
# Or install Node 20+ from NodeSource

sudo npm install -g pm2 caddy   # or install Caddy via their apt repo

git clone <your-repo-url> /opt/treble-makers
cd /opt/treble-makers
cp .env.example .env
# Edit .env: SOFT_LAUNCH=1, TRUST_PROXY=1, NODE_ENV=production,
# ADMIN_PASSWORD=<strong password>, optional TURN / Sentry / offsite backup

npm install
npm run build
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

Point DNS `A` record at the VPS. Edit `Caddyfile` domain, then:

```bash
sudo caddy run --config /opt/treble-makers/Caddyfile
# or: sudo systemctl enable --now caddy  (if installed as a service)
```

Health check: `https://your-domain/healthz`

## Soft-launch checklist

1. `SOFT_LAUNCH=1` → arena defaults to **invite-only** (guests disabled).
2. Log in as admin → **Arena Access** → confirm Invite-only + soft-launch message.
3. Change admin password if prompted (legacy `admin123` forces a change).
4. Share the URL with a few testers → they **Register** → you **Approve** pending users.
5. Point an uptime monitor at `/healthz`.
6. Set `BACKUP_OFFSITE_DIR` or `BACKUP_OFFSITE_CMD` (or cron `npm run backup:offsite`).
7. Optional: TURN credentials for webcam; `SENTRY_DSN` + `npm install @sentry/node`.

## What testers can do

- Play released games (X01, Cricket, etc.) vs humans/bots in the lobby
- Bot tournament brackets
- Profile + webcam (TURN recommended for reliability)

## Still admin-only / disabled

- Under-construction games (Snakes & Ladders, Around the Clock, Killer, Shanghai, High Score)
- Human vs human tournament bracket matches

## Opening for full launch later

1. Set `SOFT_LAUNCH=0` in `.env` and restart PM2.
2. In Arena Access, switch mode to **Open**.
3. Optionally enable guests.

## Cloudflare notes

- Proxy (orange cloud) is fine; enable **WebSockets** in network settings.
- Set `TRUST_PROXY=1` so rate limits see real client IPs.
