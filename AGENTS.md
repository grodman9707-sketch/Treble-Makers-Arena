# AGENTS.md

## Cursor Cloud specific instructions

Treble-Makers Arena is a **single Node.js process** (`server.js`): Express serves the
built `public/` bundle, exposes a few `/api/*` routes, and runs the WebSocket game
server. Almost all app behavior (register, login, matches, gameplay) happens over
**WebSocket**, not REST — the only REST endpoints are `/healthz`,
`/api/wdl-standings`, and `/api/lazy-standings`. There is no external DB, no test
suite, and no lint config; state lives in a single JSON file. Standard commands are
in `README.md` / `package.json`.

### Running the app
- `npm start` (or `npm run dev`) builds `public/` then starts the server; `npm run serve`
  skips the build (only safe once `public/` exists). Build alone: `npm run build`.
- App listens on `http://localhost:3000` (default `PORT`).
- Health check: `GET /healthz` returns JSON `{status:"ok", ...}`.

### Non-obvious startup caveats
- **Data path is hardcoded to `/app/data/data.json`** (`DATA_FILE` in `server.js`, not
  overridable by env). The directory must exist and be writable by the run user or the
  server crashes on boot with `ENOENT: .../app/data/data.json`. The update script
  creates it; if you ever hit that error, run `sudo mkdir -p /app/data && sudo chown -R "$(id -u):$(id -g)" /app/data`.
- On first run (empty `/app/data`) an admin user is seeded: username `ADMIN_USERNAME`
  (default `GViking01`), password from `ADMIN_PASSWORD` or a **random one printed in the
  server log**. `data.json` is gitignored and persists between runs once created.
- `.env` is optional (loaded via dotenv, gitignored). With no `.env` the defaults work and
  registration is **open** (anyone can self-register — good for testing). Note that
  copying `.env.example` sets `SOFT_LAUNCH=1`, which makes the arena **invite-only**
  (new registrations need admin approval); set `SOFT_LAUNCH=0` for open testing.

### Testing gameplay in the browser (GUI)
- Starting any match **requires enabling the webcam** — the Create Match flow opens a
  "Camera Setup" modal and there is no skip/continue-without-camera path; `getUserMedia`
  must succeed before the game board loads. In a headless VM with no real camera, launch
  Chrome with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` so the
  camera auto-grants and shows a synthetic feed; then "Enable Camera" proceeds into the
  match. (The computer-use Chrome wrapper at `/usr/local/bin/google-chrome` can carry
  these flags.)
- Hello-world flow: register/login → Match Lobby → `+ MATCH` → pick game (e.g. X01) →
  OPPONENT = Bot Opponent → START MATCH → Enable Camera → type a visit score in the
  🎯 input and Submit; your score decrements from 501 and the bot responds.
