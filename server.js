/**
 * TREBLE-MAKERS FUNHOUSE — WDL Platform Server
 * Run: node server.js
 * Then open: http://localhost:3000
 */

// Load .env (optional — never required to run). See .env.example for vars.
try { require('dotenv').config(); } catch { /* dotenv not installed: rely on real env */ }

const { createGameInitHandlers, initGameStateForGame } = require('./games/server/init-handlers');

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config (env-driven, sensible defaults) ───
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
// Soft launch: invite-only by default when enabled (testers register → admin approves).
const SOFT_LAUNCH = ['1', 'true', 'yes'].includes(String(process.env.SOFT_LAUNCH || '').toLowerCase());
// bcrypt cost factor. 10 is a sound default; bump via env on faster hardware.
const BCRYPT_ROUNDS = Math.min(15, Math.max(8, parseInt(process.env.BCRYPT_ROUNDS, 10) || 10));
// Trust N reverse-proxy hops (e.g. behind nginx/Heroku) so req.ip / rate-limit
// see the real client IP. Default 0 = no proxy. Set TRUST_PROXY=1 in prod.
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY, 10) || 0;
// Periodic data.json backups (timestamped copies in backups/, pruned to N).
const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS, 10) || 6 * 60 * 60 * 1000;
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS, 10) || 10;
// Opaque session tokens (remember-me / reconnect). Default 30 days.
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS, 10) || 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER, 10) || 8;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'GViking01').trim() || 'GViking01';
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || '';
// Optional offsite backup: shell command that receives the backup file path as $1 / %1.
// Example: BACKUP_OFFSITE_CMD="rclone copy $1 remote:treble-makers-backups/"
const BACKUP_OFFSITE_CMD = (process.env.BACKUP_OFFSITE_CMD || '').trim();
const BACKUP_OFFSITE_DIR = (process.env.BACKUP_OFFSITE_DIR || '').trim();
// Optional TURN for WebRTC (comma-separated URLs).
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const SENTRY_DSN = (process.env.SENTRY_DSN || '').trim();
// Password-reset email via Resend (optional — forgot-password disabled until configured).
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
const PASSWORD_RESET_TTL_MS = parseInt(process.env.PASSWORD_RESET_TTL_MS, 10) || 60 * 60 * 1000; // 1 hour

// Optional Sentry — install with `npm install @sentry/node` when SENTRY_DSN is set.
let Sentry = null;
if (SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: SENTRY_DSN, environment: NODE_ENV });
  } catch {
    console.warn('[warn] SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node');
  }
}

const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
// Client assets live in public/ and are the ONLY thing served statically, so
// source/secrets (server.js, data.json with password hashes, scripts/, smoke
// artifacts) are never downloadable. Run `npm run build` to (re)generate it.
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const WAITING_ROOM_TTL_MS = 3 * 60 * 1000;

if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

// ─── Lightweight structured logger (timestamp + level). Intentionally NOT used
// in per-message hot paths to avoid I/O overhead under load. ───
function log(level, ...args) {
  const ts = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${ts} [${level.toUpperCase()}]`, ...args);
}

// ─────────────────────────────────────────────
//  DATA PERSISTENCE (simple JSON file)
//
//  Write strategy (cheap + robust):
//   - In-memory `db` is the source of truth during runtime.
//   - saveData() just marks the store dirty and schedules a debounced,
//     coalesced flush (at most one disk write per SAVE_DEBOUNCE_MS) so the
//     hot path (every score submit / game over) never blocks on disk I/O.
//   - flushData() writes compact JSON to a temp file then atomically renames
//     it over data.json, so a crash mid-write can never corrupt the DB.
//   - A synchronous flush runs on process exit (SIGINT/SIGTERM/beforeExit) so
//     no pending changes are lost on shutdown.
//
//  TODO(scale): if user/tournament volume grows large, migrate this JSON file
//  to SQLite via better-sqlite3 (synchronous, transactional, no extra process).
//  Deferred for now — the write-behind + atomic-rename approach below is
//  sufficient and far simpler for the current scale.
// ─────────────────────────────────────────────
const SAVE_DEBOUNCE_MS = 1500;
const TMP_FILE = DATA_FILE + '.tmp';

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = resolveSeedAdminPassword();
    const initial = {
      users: {
        [ADMIN_USERNAME]: {
          id: uuidv4(),
          username: ADMIN_USERNAME,
          passwordHash: bcrypt.hashSync(seeded.password, BCRYPT_ROUNDS),
          admin: true,
          approved: true,
          mustChangePassword: seeded.mustChange,
          stats: { wins: 0, losses: 0, highScore: 0, gamesPlayed: 0, tournamentsWon: 0, threeDartAvg: 0, highestCheckout: 0, oneEighties: 0, x01VisitCount: 0, x01PointsTotal: 0 },
          profile: { country: '', league: '', equipment: '', avatarUrl: '' },
          createdAt: Date.now()
        }
      },
      tournaments: [],
      leaderboard: [],
      sessions: {},
      passwordResets: {},
      arena: {
        mode: SOFT_LAUNCH ? 'invite' : 'open',
        message: SOFT_LAUNCH
          ? 'Treble-Makers Arena soft launch — register for an account and an admin will approve your access.'
          : '',
      },
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial));
    log('info', `Seeded admin "${ADMIN_USERNAME}"${seeded.mustChange ? ` with one-time password: ${seeded.password}` : ' from ADMIN_PASSWORD'}`);
    if (seeded.mustChange) {
      log('warn', 'Change the admin password immediately after first login.');
    }
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function resolveSeedAdminPassword() {
  if (ADMIN_PASSWORD_ENV && ADMIN_PASSWORD_ENV.length >= 8) {
    return { password: ADMIN_PASSWORD_ENV, mustChange: false };
  }
  if (ADMIN_PASSWORD_ENV && ADMIN_PASSWORD_ENV.length > 0 && ADMIN_PASSWORD_ENV.length < 8) {
    log('warn', 'ADMIN_PASSWORD is shorter than 8 characters — generating a random admin password instead.');
  }
  return { password: crypto.randomBytes(12).toString('base64url'), mustChange: true };
}

let db = loadData();

// ─── Arena access control (open | invite | maintenance) ───
const ARENA_MODES = new Set(['open', 'invite', 'maintenance']);

function ensureArenaSettings() {
  if (!db.arena || typeof db.arena !== 'object') db.arena = {};
  if (!ARENA_MODES.has(db.arena.mode)) {
    db.arena.mode = SOFT_LAUNCH ? 'invite' : 'open';
  }
  if (typeof db.arena.message !== 'string') {
    db.arena.message = SOFT_LAUNCH
      ? 'Treble-Makers Arena soft launch — register for an account and an admin will approve your access.'
      : '';
  }
  return db.arena;
}

function migrateDbSecurity() {
  let dirty = false;
  if (!db.sessions || typeof db.sessions !== 'object') {
    db.sessions = {};
    dirty = true;
  }
  if (!db.passwordResets || typeof db.passwordResets !== 'object') {
    db.passwordResets = {};
    dirty = true;
  }
  for (const user of Object.values(db.users || {})) {
    if (!user || typeof user !== 'object') continue;
    if (user.approved === undefined) {
      user.approved = true;
      dirty = true;
    }
    if (typeof user.email === 'string' && user.email) {
      const normalized = normalizeEmail(user.email);
      if (normalized !== user.email) {
        user.email = normalized;
        dirty = true;
      }
    } else if (user.email == null) {
      user.email = '';
      dirty = true;
    }
    // Flag legacy default password so soft-launch admins must rotate it.
    if (user.admin && user.mustChangePassword !== true && user.passwordHash) {
      try {
        if (bcrypt.compareSync('admin123', user.passwordHash)) {
          user.mustChangePassword = true;
          dirty = true;
          log('warn', `Admin "${user.username}" still uses the legacy default password — password change required on next login.`);
        }
      } catch { /* ignore */ }
    }
  }
  if (SOFT_LAUNCH) {
    const arena = ensureArenaSettings();
    if (arena.mode === 'open') {
      arena.mode = 'invite';
      dirty = true;
      log('info', 'Soft launch enabled — arena set to invite-only.');
    }
    if (arena.mode === 'invite') {
      const softMsg = 'Treble-Makers Arena soft launch — register for an account and an admin will approve your access.';
      if (!arena.message || /offline for (updates|maintenance)/i.test(arena.message)) {
        arena.message = softMsg;
        dirty = true;
      }
    }
  }
  return dirty;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Same hasher for password-reset tokens (opaque random secrets, never stored raw).
function hashResetToken(token) {
  return hashSessionToken(token);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = normalizeEmail(email);
  if (!e || e.length > 254) return false;
  return EMAIL_RE.test(e);
}

function findUserByEmail(email) {
  const needle = normalizeEmail(email);
  if (!needle) return null;
  for (const user of Object.values(db.users || {})) {
    if (user && normalizeEmail(user.email) === needle) return user;
  }
  return null;
}

function findUserByUsernameOrEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (db.users[raw]) return db.users[raw];
  // Case-insensitive username match (login still uses exact key; lookup is for reset).
  const lower = raw.toLowerCase();
  for (const user of Object.values(db.users || {})) {
    if (user && String(user.username || '').toLowerCase() === lower) return user;
  }
  return findUserByEmail(raw);
}

function emailConfigured() {
  return !!(RESEND_API_KEY && EMAIL_FROM && APP_URL);
}

async function sendResendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    const err = new Error('Password reset email is not configured.');
    err.code = 'email_unconfigured';
    throw err;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const err = new Error(`Resend API error (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.code = 'email_send_failed';
    throw err;
  }
  return true;
}

function pruneExpiredPasswordResets() {
  if (!db.passwordResets) return false;
  const now = Date.now();
  let removed = 0;
  for (const [hash, rec] of Object.entries(db.passwordResets)) {
    if (!rec || typeof rec.expiresAt !== 'number' || rec.expiresAt <= now) {
      delete db.passwordResets[hash];
      removed++;
    }
  }
  return removed > 0;
}

function clearPasswordResetsForUser(username) {
  if (!db.passwordResets) return;
  for (const [hash, rec] of Object.entries(db.passwordResets)) {
    if (rec?.username === username) delete db.passwordResets[hash];
  }
}

function createPasswordResetToken(username) {
  pruneExpiredPasswordResets();
  clearPasswordResetsForUser(username);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashResetToken(token);
  const now = Date.now();
  db.passwordResets[hash] = {
    username,
    createdAt: now,
    expiresAt: now + PASSWORD_RESET_TTL_MS,
  };
  saveData();
  return token;
}

function consumePasswordResetToken(token) {
  if (!token || typeof token !== 'string' || !db.passwordResets) return null;
  pruneExpiredPasswordResets();
  const hash = hashResetToken(token);
  const rec = db.passwordResets[hash];
  if (!rec) return null;
  if (typeof rec.expiresAt !== 'number' || rec.expiresAt <= Date.now()) {
    delete db.passwordResets[hash];
    saveData();
    return null;
  }
  const user = db.users[rec.username];
  delete db.passwordResets[hash];
  if (!user) {
    saveData();
    return null;
  }
  // Invalidate any other outstanding resets for this account.
  clearPasswordResetsForUser(user.username);
  saveData();
  return user;
}

function pruneExpiredSessions() {
  if (!db.sessions) return false;
  const now = Date.now();
  let removed = 0;
  for (const [hash, sess] of Object.entries(db.sessions)) {
    if (!sess || typeof sess.expiresAt !== 'number' || sess.expiresAt <= now) {
      delete db.sessions[hash];
      removed++;
    }
  }
  return removed > 0;
}

async function createSession(username, userId) {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashSessionToken(token);
  const now = Date.now();
  // Cap sessions per user (oldest first).
  const existing = Object.entries(db.sessions)
    .filter(([, s]) => s && s.username === username)
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  while (existing.length >= MAX_SESSIONS_PER_USER) {
    const [oldHash] = existing.shift();
    delete db.sessions[oldHash];
  }
  db.sessions[hash] = {
    username,
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  saveDirty = true;
  // Session tokens must be durable before we hand them to the client —
  // otherwise a restart/deploy right after login silently logs everyone out.
  await flushData();
  return token;
}

function revokeSessionToken(token) {
  if (!token || !db.sessions) return;
  const hash = hashSessionToken(token);
  if (db.sessions[hash]) {
    delete db.sessions[hash];
    saveData();
  }
}

function revokeUserSessions(username, exceptHash) {
  if (!db.sessions) return;
  let removed = 0;
  for (const [hash, sess] of Object.entries(db.sessions)) {
    if (sess?.username === username && hash !== exceptHash) {
      delete db.sessions[hash];
      removed++;
    }
  }
  if (removed) saveData();
}

function lookupSession(token) {
  if (!token || typeof token !== 'string' || !db.sessions) return null;
  const hash = hashSessionToken(token);
  const sess = db.sessions[hash];
  if (!sess) return null;
  if (typeof sess.expiresAt !== 'number' || sess.expiresAt <= Date.now()) {
    delete db.sessions[hash];
    saveData();
    return null;
  }
  const user = db.users[sess.username];
  if (!user || user.id !== sess.userId) {
    delete db.sessions[hash];
    saveData();
    return null;
  }
  return { hash, sess, user };
}

function bindClientSession(client, user, token) {
  client.userId = user.id;
  client.username = user.username;
  client.sessionToken = token || null;
}

function authOkPayload(user, token) {
  const payload = publicProfilePayload(user);
  return {
    type: 'auth_ok',
    username: user.username,
    admin: !!user.admin,
    stats: payload.stats,
    profile: payload.profile,
    token: token || undefined,
    mustChangePassword: !!user.mustChangePassword,
    softLaunch: SOFT_LAUNCH,
  };
}

function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_URLS.length) {
    const turn = { urls: TURN_URLS.length === 1 ? TURN_URLS[0] : TURN_URLS };
    if (TURN_USERNAME) turn.username = TURN_USERNAME;
    if (TURN_CREDENTIAL) turn.credential = TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}

function isUserApproved(user) {
  if (!user) return false;
  if (user.admin) return true;
  return user.approved !== false; // legacy accounts without the field stay approved
}

function arenaStatusPayload() {
  const arena = ensureArenaSettings();
  const pendingCount = Object.values(db.users).filter(u => u.approved === false).length;
  const defaults = {
    maintenance: 'The arena is offline for updates. Please check back soon.',
    invite: SOFT_LAUNCH
      ? 'Treble-Makers Arena soft launch — register for an account and an admin will approve your access.'
      : 'Treble-Makers Arena is in closed testing. Register for an account — an admin will approve your access.',
    open: '',
  };
  return {
    mode: arena.mode,
    message: arena.message || defaults[arena.mode] || '',
    registrationOpen: arena.mode !== 'maintenance',
    guestAllowed: arena.mode === 'open',
    pendingCount,
    softLaunch: SOFT_LAUNCH,
  };
}

function broadcastArenaStatus() {
  broadcastAll({ type: 'arena_status', ...arenaStatusPayload() });
}

// ─── Under-construction games (admin-only until release) ───
const UNDER_CONSTRUCTION_GAMES = new Set([
  'Snakes & Ladders',
  'Around the Clock',
  'Killer',
  'Shanghai',
  'High Score',
]);

function canPlayGame(game, username) {
  if (!UNDER_CONSTRUCTION_GAMES.has(game)) return true;
  const user = db.users[username];
  return !!user?.admin;
}

function underConstructionMessage() {
  return 'This game is under construction. Admin access only.';
}

function defaultUserStats() {
  return {
    wins: 0, losses: 0, highScore: 0, gamesPlayed: 0, tournamentsWon: 0,
    threeDartAvg: 0, highestCheckout: 0, oneEighties: 0, x01VisitCount: 0, x01PointsTotal: 0,
  };
}

function ensureUserStats(user) {
  if (!user) return defaultUserStats();
  if (!user.stats || typeof user.stats !== 'object') user.stats = defaultUserStats();
  const s = user.stats;
  for (const [k, v] of Object.entries(defaultUserStats())) {
    if (typeof s[k] !== 'number') s[k] = v;
  }
  return s;
}

function defaultUserProfile() {
  return { country: '', league: '', equipment: '', avatarUrl: '' };
}

function ensureUserProfile(user) {
  if (!user) return defaultUserProfile();
  if (!user.profile || typeof user.profile !== 'object') user.profile = defaultUserProfile();
  const p = user.profile;
  for (const [k, v] of Object.entries(defaultUserProfile())) {
    if (typeof p[k] !== 'string') p[k] = v;
  }
  return p;
}

function publicProfilePayload(user, { includeEmail = false } = {}) {
  const profile = ensureUserProfile(user);
  const stats = ensureUserStats(user);
  const payload = {
    profile: {
      country: profile.country,
      league: profile.league,
      equipment: profile.equipment,
      avatarUrl: profile.avatarUrl,
    },
    stats: {
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      gamesPlayed: stats.gamesPlayed || 0,
      highScore: stats.highScore || 0,
      tournamentsWon: stats.tournamentsWon || 0,
      threeDartAvg: stats.threeDartAvg || 0,
      highestCheckout: stats.highestCheckout || 0,
      oneEighties: stats.oneEighties || 0,
    },
  };
  if (includeEmail && user) {
    payload.email = typeof user.email === 'string' ? user.email : '';
  }
  return payload;
}

function sanitizeAvatarDataUrl(raw) {
  if (raw === '' || raw == null) return '';
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('data:image/jpeg;base64,') &&
      !raw.startsWith('data:image/png;base64,') &&
      !raw.startsWith('data:image/webp;base64,')) {
    return null;
  }
  // ~180KB base64 budget (~256x256 JPEG)
  if (raw.length > 240000) return null;
  return raw;
}

function botPreviewStats(skill) {
  const table = {
    easy: { threeDartAvg: 42, highestCheckout: 80, oneEighties: 0 },
    medium: { threeDartAvg: 58, highestCheckout: 100, oneEighties: 1 },
    hard: { threeDartAvg: 72, highestCheckout: 132, oneEighties: 3 },
    adaptive: { threeDartAvg: 65, highestCheckout: 120, oneEighties: 2 },
  };
  return table[skill] || table.easy;
}

function playerPreviewProfile(username) {
  if (isBotPlayer(username)) {
    const skill = botSkillFromName(username);
    const botStats = botPreviewStats(skill);
    return {
      username,
      isBot: true,
      avatar: '🤖',
      avatarUrl: '',
      threeDartAvg: botStats.threeDartAvg,
      highestCheckout: botStats.highestCheckout,
      oneEighties: botStats.oneEighties,
      tournamentsWon: 0,
    };
  }
  const user = db.users[username];
  const s = ensureUserStats(user);
  const profile = ensureUserProfile(user);
  return {
    username: username || 'Player',
    isBot: false,
    avatar: (username || '?').charAt(0).toUpperCase(),
    avatarUrl: profile.avatarUrl || '',
    country: profile.country || '',
    league: profile.league || '',
    equipment: profile.equipment || '',
    threeDartAvg: s.threeDartAvg || 0,
    highestCheckout: s.highestCheckout || 0,
    oneEighties: s.oneEighties || 0,
    tournamentsWon: s.tournamentsWon || 0,
  };
}

function buildMatchPreview(game, hostName, guestName) {
  return {
    game,
    players: [playerPreviewProfile(hostName), playerPreviewProfile(guestName)],
  };
}

function recordCareerVisitStats(username, displayScore, extras = {}) {
  if (!username || isBotPlayer(username) || !db.users[username]) return;
  const s = ensureUserStats(db.users[username]);
  const total = typeof displayScore === 'number'
    ? displayScore
    : (typeof displayScore === 'string' && displayScore !== 'BUST' ? parseInt(displayScore, 10) : NaN);
  if (!Number.isNaN(total) && total >= 0 && total <= 180) {
    s.x01VisitCount += 1;
    s.x01PointsTotal += total;
    s.threeDartAvg = Math.round((s.x01PointsTotal / s.x01VisitCount) * 100) / 100;
    if (total === 180) s.oneEighties += 1;
  }
  const checkout = parseInt(extras.checkout, 10);
  if (checkout > 0 && checkout > (s.highestCheckout || 0)) s.highestCheckout = checkout;
  saveData(db);
}

function kickNonAdminSessions(reason) {
  clients.forEach((client, wsId) => {
    if (!client.username) return;
    const user = db.users[client.username];
    if (user?.admin) return;
    send(wsId, { type: 'force_logout', message: reason || 'Arena access has changed.' });
  });
}

let saveDirty = false;
let saveTimer = null;
let flushing = null; // in-flight flush promise (single-flight)

// Mark the store dirty and schedule a coalesced flush. Cheap + non-blocking.
function saveData() {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushData(); }, SAVE_DEBOUNCE_MS);
}

// Atomic async write (temp file -> rename). Coalesces concurrent calls.
async function flushData() {
  if (flushing) { saveDirty = true; return flushing; }
  if (!saveDirty) return;
  saveDirty = false;
  const payload = JSON.stringify(db);
  flushing = (async () => {
    try {
      await fs.promises.writeFile(TMP_FILE, payload);
      await fs.promises.rename(TMP_FILE, DATA_FILE);
    } catch (err) {
      console.error('Data flush failed:', err.message);
      saveDirty = true; // retry on next scheduled flush
    } finally {
      flushing = null;
    }
  })();
  await flushing;
  // If more changes landed mid-flush, schedule another pass.
  if (saveDirty && !saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = null; flushData(); }, SAVE_DEBOUNCE_MS);
  }
}

// Synchronous best-effort flush for process exit (atomic temp + rename).
function flushDataSync() {
  if (!saveDirty) return;
  saveDirty = false;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(db));
    fs.renameSync(TMP_FILE, DATA_FILE);
  } catch (err) {
    console.error('Data flush (sync) failed:', err.message);
  }
}

// Run security migrations once persistence helpers exist.
{
  const dirty = migrateDbSecurity() || pruneExpiredSessions() || pruneExpiredPasswordResets();
  if (dirty) saveData();
}
if (!emailConfigured()) {
  log('warn', 'Password reset email is not configured (set RESEND_API_KEY, EMAIL_FROM, APP_URL). Forgot-password will be unavailable.');
}

// ─── Backups: the whole DB is one JSON file, so keep timestamped copies so
// live player data is recoverable after an accident/corruption. Best-effort. ───
function runOffsiteBackup(localPath) {
  if (BACKUP_OFFSITE_DIR) {
    try {
      fs.mkdirSync(BACKUP_OFFSITE_DIR, { recursive: true });
      fs.copyFileSync(localPath, path.join(BACKUP_OFFSITE_DIR, path.basename(localPath)));
      log('info', `Offsite backup copied to ${BACKUP_OFFSITE_DIR}`);
    } catch (err) {
      log('warn', 'Offsite dir backup failed:', err.message);
    }
  }
  if (!BACKUP_OFFSITE_CMD) return;
  try {
    const child = spawn(BACKUP_OFFSITE_CMD, [localPath], {
      shell: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => log('warn', 'Offsite backup command failed:', err.message));
    child.on('exit', (code) => {
      if (code !== 0) log('warn', `Offsite backup command exited with code ${code}`);
    });
  } catch (err) {
    log('warn', 'Offsite backup command failed:', err.message);
  }
}

function backupData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `data-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    // Prune to the most recent MAX_BACKUPS.
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^data-.*\.json$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
    runOffsiteBackup(dest);
  } catch (err) {
    log('warn', 'Backup failed:', err.message);
  }
}
let backupTimer = null;

let shuttingDown = false;
function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) log('info', `Received ${signal} — shutting down gracefully…`);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  flushDataSync();   // persist any pending writes
  backupData();      // snapshot on the way out

  // Stop accepting new work, then close sockets + HTTP server.
  let exited = false;
  const done = () => { if (exited) return; exited = true; if (signal) process.exit(0); };
  try {
    wss.clients.forEach(c => { try { c.close(1001, 'server shutting down'); } catch {} });
    wss.close(() => {});
  } catch {}
  try { server.close(done); } catch { done(); }
  // Hard fallback so a stuck socket can't block shutdown forever.
  if (signal) setTimeout(() => process.exit(0), 5000).unref();
}
process.on('beforeExit', () => gracefulExit(null));
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

// Last-resort guards: log and keep serving rather than crashing the whole
// process (which would disconnect every player and drop their sessions).
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err);
  try { Sentry?.captureException?.(err); } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept alive):', reason);
  try { Sentry?.captureException?.(reason instanceof Error ? reason : new Error(String(reason))); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────
//  IN-MEMORY STATE
// ─────────────────────────────────────────────
const clients = new Map();    // wsId -> { ws, userId, username, roomId }
const rooms = new Map();      // roomId -> room object
const spectators = new Map(); // roomId -> Set of wsIds

function createRoom(hostWsId, config) {
  const room = {
    id: uuidv4(),
    hostWsId,
    guestWsId: null,
    config,         // { game, hostName, guestName, tournamentId?, bot?, botSkill? }
    status: config.bot ? 'active' : 'waiting', // waiting | active | finished
    gameState: {},
    scores: [0, 0],
    turn: 0,
    round: 0,
    history: [],
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(room.id, room);
  spectators.set(room.id, new Set());
  return room;
}

function generateHalveItTargets() {
  const specialRounds = { 5: 'D', 11: 'T', 14: 'Bull' };
  const used = new Set();
  const targets = [];
  for (let i = 0; i < 15; i++) {
    if (specialRounds[i]) {
      targets.push(specialRounds[i]);
      continue;
    }
    let num;
    do { num = Math.floor(Math.random() * 20) + 1; } while (used.has(num));
    used.add(num);
    targets.push(num);
  }
  return targets;
}

const X01_GAMES = ['X01', '501', '301', '701', '1001'];
const X01_DEFAULT_BEST_OF = 5;
function isX01Game(game) { return X01_GAMES.includes(game); }

const CRICKET_GAMES = ['Cricket', 'Tactics'];
function isCricketGame(game) { return CRICKET_GAMES.includes(game); }

const GOLF_CHECKOUT_COURSE_A = [
  { target: 144, par: 9 }, { target: 233, par: 12 }, { target: 52, par: 4 },
  { target: 141, par: 9 }, { target: 230, par: 12 }, { target: 49, par: 4 },
  { target: 138, par: 9 }, { target: 153, par: 9 }, { target: 242, par: 12 },
  { target: 130, par: 9 }, { target: 41, par: 4 }, { target: 222, par: 12 },
  { target: 133, par: 9 }, { target: 216, par: 12 }, { target: 127, par: 9 },
  { target: 38, par: 3 }, { target: 219, par: 12 }, { target: 228, par: 12 }
];
const GOLF_CHECKOUT_COURSE_B = [
  { target: 28, par: 3 }, { target: 117, par: 9 }, { target: 206, par: 12 },
  { target: 123, par: 9 }, { target: 212, par: 12 }, { target: 31, par: 3 },
  { target: 120, par: 9 }, { target: 37, par: 3 }, { target: 126, par: 9 },
  { target: 16, par: 3 }, { target: 197, par: 12 }, { target: 108, par: 9 },
  { target: 19, par: 3 }, { target: 200, par: 12 }, { target: 111, par: 9 },
  { target: 22, par: 3 }, { target: 203, par: 12 }, { target: 188, par: 12 }
];

function buildGolfCheckoutHoles(courseKey, capEnabled) {
  const raw = courseKey === 'A' ? GOLF_CHECKOUT_COURSE_A : GOLF_CHECKOUT_COURSE_B;
  return raw.map(h => ({
    target: h.target,
    par: h.par,
    cap: capEnabled ? h.par * 2 : null
  }));
}

function initGolfCheckoutsState(config = {}) {
  const course = config.golfCourse || 'B';
  const capEnabled = config.capEnabled !== false;
  const holes = buildGolfCheckoutHoles(course, capEnabled);
  const firstTarget = holes[0].target;
  const mkProgress = () => ({
    hole: 0,
    remaining: firstTarget,
    currentHoleDarts: 0,
    totalDarts: 0,
    holeResults: [],
    finished: false,
    holeDone: false
  });
  return {
    golfCourse: course,
    capEnabled,
    syncHole: 0,
    holes,
    playerProgress: [mkProgress(), mkProgress()]
  };
}

const GAME_INIT_HANDLERS = createGameInitHandlers({ generateHalveItTargets, initGolfCheckoutsState });

function initGameState(game, config) {
  return initGameStateForGame(game, config, GAME_INIT_HANDLERS, {
    isX01Game,
    isCricketGame,
    initX01State,
    initCricketState,
    initGolfCheckoutsState
  });
}

function gcEffectiveHole(gs, playerIdx) {
  if (gs.capEnabled !== false) return gs.syncHole ?? 0;
  return gs.playerProgress?.[playerIdx]?.hole ?? 0;
}

function gcPlayerCanThrow(gs, playerIdx) {
  const progress = gs.playerProgress?.[playerIdx];
  if (!progress || progress.finished) return false;
  if (gs.capEnabled !== false && progress.holeDone) return false;
  return true;
}

const GC_DARTS_PER_TURN = 3;

const GC_ONE_DART_SCORES = (() => {
  const s = new Set([25, 50]);
  for (let i = 1; i <= 20; i++) {
    s.add(i);
    s.add(i * 2);
    s.add(i * 3);
  }
  return s;
})();

function gcMinDartsForScore(score) {
  if (!Number.isInteger(score) || score < 0) return 3;
  if (score === 0) return 0;
  if (GC_ONE_DART_SCORES.has(score)) return 1;
  for (const a of GC_ONE_DART_SCORES) {
    if (GC_ONE_DART_SCORES.has(score - a)) return 2;
  }
  return 3;
}

function gcSyncAdvanceBoth(gs) {
  const nextHole = (gs.syncHole ?? 0) + 1;
  gs.syncHole = nextHole;
  for (let i = 0; i < 2; i++) {
    const p = gs.playerProgress[i];
    if (!p) continue;
    p.holeDone = false;
    p.hole = nextHole;
    p.currentHoleDarts = 0;
    if (nextHole >= gs.holes.length) {
      p.finished = true;
      p.remaining = 0;
    } else {
      p.remaining = gs.holes[nextHole].target;
    }
  }
}

// Applies a whole turn total (X01-style entry). Mutates gs.
function gcApplyTurnTotal(gs, playerIdx, total, visitDarts = GC_DARTS_PER_TURN) {
  const capOn = gs.capEnabled !== false;
  const progress = gs.playerProgress[playerIdx];
  if (!progress || progress.finished) {
    return { blocked: true, note: 'Player finished all holes', turnEnded: true, keepTurn: false, delta: 0 };
  }
  if (capOn && progress.holeDone) {
    return { blocked: true, note: 'Waiting for opponent', turnEnded: true, keepTurn: false, delta: 0 };
  }
  if (!Number.isInteger(total) || total < 0 || total > 180) {
    return { blocked: true, note: 'Enter turn total 0–180', turnEnded: false, keepTurn: true, delta: 0 };
  }
  const dartsThisVisit = Math.min(3, Math.max(1, Number(visitDarts) || GC_DARTS_PER_TURN));
  const holeIdx = gcEffectiveHole(gs, playerIdx);
  const holeDef = gs.holes[holeIdx] || { target: 0, par: 0, cap: 999 };
  const remainingBefore = progress.remaining;
  progress.currentHoleDarts = (progress.currentHoleDarts || 0) + dartsThisVisit;
  progress.totalDarts = (progress.totalDarts || 0) + dartsThisVisit;
  let note;
  if (total === 0) {
    note = `Miss · ${progress.remaining} left`;
  } else if (total > progress.remaining) {
    note = `Bust · ${progress.remaining} left`;
  } else {
    progress.remaining -= total;
    note = `${total} · ${progress.remaining} left`;
  }
  let holeComplete = false;
  let capped = false;
  if (progress.remaining === 0) {
    holeComplete = true;
  } else if (capOn && holeDef.cap && progress.currentHoleDarts >= holeDef.cap) {
    holeComplete = true;
    capped = true;
  }
  if (holeComplete) {
    const dartsUsed = capped ? holeDef.cap : progress.currentHoleDarts;
    const parDiff = dartsUsed - holeDef.par;
    const result = capped ? 'CAP'
      : dartsUsed === holeDef.par ? 'PAR'
      : dartsUsed < holeDef.par ? 'BIRDIE' : 'BOGEY';
    progress.holeResults.push({
      hole: holeIdx + 1, target: holeDef.target, dartsUsed, parDiff, result
    });
    progress.currentHoleDarts = 0;
    if (capOn) {
      progress.holeDone = true;
      const other = gs.playerProgress[1 - playerIdx];
      if (other?.holeDone || other?.finished) {
        gcSyncAdvanceBoth(gs);
        note = `Hole ${holeIdx + 1} complete · ${progress.finished ? 'All holes done' : 'Next hole ready'}`;
      } else {
        progress.hole = gs.syncHole ?? holeIdx;
        note = `Hole ${holeIdx + 1} done · Waiting for opponent`;
      }
    } else {
      progress.hole += 1;
      if (progress.hole >= gs.holes.length) {
        progress.finished = true;
        progress.remaining = 0;
      } else {
        progress.remaining = gs.holes[progress.hole].target;
      }
      note = `Hole ${holeIdx + 1} complete · ${progress.finished ? 'All holes done' : 'Next hole ready'}`;
    }
    if (!capped && remainingBefore > 0 && remainingBefore < 170 && dartsThisVisit < GC_DARTS_PER_TURN) {
      note = `Checkout ${remainingBefore} in ${dartsThisVisit} · ${note}`;
    }
  }
  const turnEnded = true;
  return { blocked: false, note, delta: dartsThisVisit, turnEnded, keepTurn: false };
}

function gcSkipWaitingTurn(turn, gs) {
  if (!gs?.playerProgress) return turn;
  const capOn = gs.capEnabled !== false;
  let safety = 0;
  while (safety++ < 4) {
    const prog = gs.playerProgress[turn];
    if (!prog) break;
    const waitingOnHole = capOn && prog.holeDone && !prog.finished;
    if (!prog.finished && !waitingOnHole) break;
    turn = 1 - turn;
  }
  return turn;
}


// ─────────────────────────────────────────────
//  X01 ENGINE (mirrors client index.html)
// ─────────────────────────────────────────────
function initX01State(cfg, game) {
  let base = parseInt(cfg.x01Base, 10);
  if (!base) {
    const fromName = parseInt(game, 10);
    base = Number.isNaN(fromName) ? 501 : fromName;
  }
  const bestOf = parseInt(cfg.legs, 10) || X01_DEFAULT_BEST_OF;
  const reopen = cfg.startRule && cfg.startRule !== 'straight-in';
  const visitTimerSeconds = parseInt(cfg.visitTimerSeconds, 10) || 0;
  return {
    kind: 'x01',
    base,
    startRule: cfg.startRule || 'straight-in',
    finishRule: cfg.finishRule || 'double-out',
    bestOf,
    visitTimerSeconds,
    legsToWin: Math.ceil(bestOf / 2),
    remaining: [base, base],
    legs: [0, 0],
    points: [0, 0],
    dartsThrown: [0, 0],
    lastScore: [null, null],
    opened: [!reopen, !reopen],
    legStarter: 0,
    currentLeg: 1,
    legLog: [[]],
    turnEnded: false,
    nextTurn: null
  };
}

function x01IsValidCheckout(rem, finishRule) {
  if (rem < 2) return false;
  if (finishRule === 'straight-out') return rem <= 180;
  if (finishRule === 'master-out') return rem <= 180;
  const bogey = [169, 168, 166, 165, 163, 162, 159];
  return rem <= 170 && !bogey.includes(rem);
}

function x01PushLog(gs, p, total, bust) {
  if (!gs.legLog || !gs.legLog.length) gs.legLog = [[]];
  gs.legLog[gs.legLog.length - 1].push({ p, v: total, bust });
}

function x01ApplyTurn(gs, p, total) {
  const startRem = gs.remaining[p];
  const finish = gs.finishRule;
  let bust = false, legWon = false, matchOver = false;

  if (!gs.opened[p]) {
    if (total <= 0) {
      gs.lastScore[p] = 0;
      gs.dartsThrown[p] += 3;
      x01PushLog(gs, p, 0, false);
      gs.turnEnded = true;
      gs.nextTurn = 1 - p;
      return { bust: false, legWon: false, matchOver: false };
    }
    gs.opened[p] = true;
  }

  gs.dartsThrown[p] += 3;
  let after = startRem - total;

  if (total > startRem) {
    bust = true;
  } else if (after === 0) {
    if (!x01IsValidCheckout(startRem, finish)) bust = true;
    else legWon = true;
  } else if (after === 1 && (finish === 'double-out' || finish === 'master-out')) {
    bust = true;
  }

  if (bust) {
    gs.lastScore[p] = 0;
    x01PushLog(gs, p, total, true);
  } else {
    gs.remaining[p] = after;
    gs.points[p] += total;
    gs.lastScore[p] = total;
    x01PushLog(gs, p, total, false);
  }

  if (legWon) {
    gs.legs[p] += 1;
    if (gs.legs[p] >= gs.legsToWin) {
      matchOver = true;
    } else {
      gs.legStarter = 1 - gs.legStarter;
      gs.currentLeg += 1;
      gs.remaining = [gs.base, gs.base];
      gs.lastScore = [null, null];
      const reopen = gs.startRule && gs.startRule !== 'straight-in';
      gs.opened = [!reopen, !reopen];
      gs.legLog.push([]);
    }
  }

  gs.turnEnded = true;
  gs.nextTurn = matchOver ? null : (legWon ? gs.legStarter : 1 - p);
  return { bust, legWon, matchOver };
}

function applyX01EditToRoom(room, msg, { fromEdit = false } = {}) {
  if (msg.gameState) room.gameState = structuredClone(msg.gameState);
  if (Array.isArray(msg.scores)) room.scores = msg.scores.slice(0, 2);
  if (typeof msg.turn === 'number') room.turn = msg.turn;
  room.pendingX01Edit = null;
  room.lastActivity = Date.now();

  const update = {
    type: 'score_update',
    scores: room.scores,
    turn: room.turn,
    round: room.round,
    history: [],
    gameState: room.gameState,
    fromX01Edit: !!fromEdit
  };
  broadcastToRoom(room, update);

  if (msg.gameOver) {
    room.status = 'finished';
    room.lastActivity = Date.now();
    const winnerName = msg.winner;
    const loserName = winnerName === room.config.hostName ? room.config.guestName : room.config.hostName;
    if (winnerName) updateStats(winnerName, loserName, msg.highScore || 0);
    const endMsg = buildGameOverMessage(room, winnerName, msg.matchStats);
    broadcastToRoom(room, endMsg);
    if (room.config.tournamentId && room.config.bracketMatchId && winnerName) {
      recordTournamentMatchResult(room.config.tournamentId, room.config.bracketMatchId, winnerName);
    }
    broadcastLobbyUpdate();
  } else if (room.config.bot && room.turn === 1) {
    scheduleBotMove(room.id);
  }
}

function halveItGameOver(gs) {
  const len = gs.targets?.length || 15;
  const p0 = gs.roundProgress?.[0]?.round || 0;
  const p1 = gs.roundProgress?.[1]?.round || 0;
  return p0 >= len && p1 >= len;
}

function halveItWinner(room) {
  if (room.scores[0] === room.scores[1]) return null;
  return room.scores[0] > room.scores[1] ? room.config.hostName : room.config.guestName;
}

// ─────────────────────────────────────────────
//  CRICKET / TACTICS ENGINE (mirrors client index.html)
// ─────────────────────────────────────────────
const CRICKET_BULL = 25; // target key for the Bull (outer=25/1mk, inner=50/2mk)

function cricketTargetsFor(game) {
  return game === 'Tactics'
    ? [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, CRICKET_BULL]
    : [20, 19, 18, 17, 16, 15, CRICKET_BULL];
}

function cricketNormalizeVariation(v) {
  const s = String(v || 'standard').toLowerCase();
  if (s === 'cut-throat' || s === 'cutthroat' || s === 'cut_throat') return 'cut-throat';
  if (s === 'no-score' || s === 'noscore' || s === 'no_score') return 'no-score';
  return 'standard';
}

function initCricketState(cfg, game) {
  const targets = cricketTargetsFor(game);
  const blank = () => { const m = {}; targets.forEach(t => { m[t] = 0; }); return m; };
  const bestOf = Math.max(1, parseInt(cfg.legs, 10) || 1);
  return {
    kind: 'cricket',
    game,
    variation: cricketNormalizeVariation(cfg.variation),
    targets,
    marks: [blank(), blank()],
    score: [0, 0],
    lastVisit: [null, null],
    starter: 0,
    winner: null,
    turnEnded: false,
    nextTurn: null,
    // Legs (best-of) + Marks Per Round tracking
    bestOf,
    legsToWin: Math.ceil(bestOf / 2),
    legs: [0, 0],
    marksTotal: [0, 0],
    roundsPlayed: [0, 0],
    currentLeg: 1,
    legStarter: 0
  };
}

function ensureCricketState(gs, cfg, game) {
  if (!gs || gs.kind !== 'cricket' || !Array.isArray(gs.targets) || !gs.targets.length ||
      !Array.isArray(gs.marks) || !gs.marks[0] || !gs.marks[1]) {
    return initCricketState(cfg || {}, game);
  }
  if (!Array.isArray(gs.legs)) gs.legs = [0, 0];
  if (!Array.isArray(gs.marksTotal)) gs.marksTotal = [0, 0];
  if (!Array.isArray(gs.roundsPlayed)) gs.roundsPlayed = [0, 0];
  if (!gs.bestOf) {
    gs.bestOf = Math.max(1, parseInt(cfg?.legs, 10) || 1);
    gs.legsToWin = Math.ceil(gs.bestOf / 2);
  }
  if (gs.legsToWin == null) gs.legsToWin = Math.ceil((gs.bestOf || 1) / 2);
  return gs;
}

// Parse a single dart token into cricket terms.
// Returns { miss, dead, target, marks, label }.
function parseCricketDart(raw, targets) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (s === '' || s === '0' || s === 'MISS' || s === 'X' || s === '-') {
    return { miss: true, dead: false, target: null, marks: 0, label: 'Miss' };
  }
  const tset = new Set(targets);
  const isBull = tset.has(CRICKET_BULL);
  // Bull synonyms
  if (['25', 'OB', 'SB', 'OBULL', 'SBULL'].includes(s)) {
    return isBull
      ? { miss: false, dead: false, target: CRICKET_BULL, marks: 1, label: 'OB' }
      : { miss: false, dead: true, target: null, marks: 0, label: 'OB✗' };
  }
  if (['50', 'IB', 'DB', 'BULL', 'DBULL', 'BULLSEYE', 'IBULL'].includes(s)) {
    return isBull
      ? { miss: false, dead: false, target: CRICKET_BULL, marks: 2, label: 'IB' }
      : { miss: false, dead: true, target: null, marks: 0, label: 'IB✗' };
  }
  const m = s.match(/^(SI|SO|S|D|T)?(\d{1,2})$/);
  if (m) {
    const tag = m[1] || 'S';
    const num = parseInt(m[2], 10);
    if (num >= 1 && num <= 20) {
      const marks = tag === 'T' ? 3 : tag === 'D' ? 2 : 1;
      const tagLabel = tag === 'T' ? 'T' : tag === 'D' ? 'D' : '';
      if (tset.has(num)) {
        return { miss: false, dead: false, target: num, marks, label: `${tagLabel}${num}` };
      }
      return { miss: false, dead: true, target: null, marks: 0, label: `${tagLabel}${num}✗` };
    }
  }
  return { miss: false, dead: true, target: null, marks: 0, label: `${s}✗` };
}

function cricketClosedAll(gs, p) {
  if (!gs?.targets?.length || !gs.marks?.[p]) return false;
  return gs.targets.every(t => (gs.marks[p][t] || 0) >= 3);
}

// Returns winning player index (0/1) or null.
function cricketWinnerIdx(gs) {
  const closed = [cricketClosedAll(gs, 0), cricketClosedAll(gs, 1)];
  const sc = gs.score;
  if (gs.variation === 'no-score') {
    if (closed[0] && closed[1]) return sc[0] === sc[1] ? 0 : null; // both closed: tie-break n/a
    if (closed[0]) return 0;
    if (closed[1]) return 1;
    return null;
  }
  const cand = [];
  for (let p = 0; p < 2; p++) {
    if (!closed[p]) continue;
    if (gs.variation === 'cut-throat') { if (sc[p] <= sc[1 - p]) cand.push(p); }
    else { if (sc[p] >= sc[1 - p]) cand.push(p); }
  }
  if (!cand.length) return null;
  if (cand.length === 1) return cand[0];
  // Both qualify: standard -> higher score; cut-throat -> lower score.
  if (gs.variation === 'cut-throat') return sc[0] <= sc[1] ? 0 : 1;
  return sc[0] >= sc[1] ? 0 : 1;
}

function cricketResetLegBoard(gs) {
  const blank = () => { const m = {}; gs.targets.forEach(t => { m[t] = 0; }); return m; };
  gs.marks = [blank(), blank()];
  gs.score = [0, 0];
  gs.lastVisit = [null, null];
  gs.winner = null;
}

// Apply a full visit (1-3 darts) for player p. Mutates gs. Returns summary.
function applyCricketVisit(gs, p, darts) {
  const opp = 1 - p;
  const labels = [];
  let visitPoints = 0;       // points credited to the scorer (or to opp in cut-throat)
  let marksGained = 0;
  if (!gs.marks?.[p] || !gs.marks?.[opp]) {
    throw new Error('Cricket marks missing for player');
  }
  (darts || []).slice(0, 3).forEach(d => {
    labels.push(d.label || (d.miss ? 'Miss' : '?'));
    if (d.miss || d.dead || !d.target) return;
    const t = d.target;
    const unit = t; // numbers => N, bull key 25 => 25
    const before = gs.marks[p][t] || 0;
    const needed = 3 - before;
    const applied = Math.max(0, Math.min(d.marks, needed));
    const overflow = d.marks - applied;
    gs.marks[p][t] = before + applied;
    marksGained += applied;
    if (overflow > 0 && gs.variation !== 'no-score') {
      const oppClosed = (gs.marks[opp][t] || 0) >= 3;
      if (!oppClosed) {
        const pts = overflow * unit;
        if (gs.variation === 'cut-throat') gs.score[opp] += pts;
        else gs.score[p] += pts;
        visitPoints += pts;
      }
    }
  });
  gs.lastVisit[p] = { darts: labels, points: visitPoints, marks: marksGained };
  if (!Array.isArray(gs.marksTotal)) gs.marksTotal = [0, 0];
  if (!Array.isArray(gs.roundsPlayed)) gs.roundsPlayed = [0, 0];
  gs.marksTotal[p] = (gs.marksTotal[p] || 0) + marksGained;
  gs.roundsPlayed[p] = (gs.roundsPlayed[p] || 0) + 1;

  const w = cricketWinnerIdx(gs);
  let matchOver = false;
  let legWon = false;
  let legWinnerIdx = null;
  if (w !== null && w !== undefined) {
    legWon = true;
    legWinnerIdx = w;
    if (!Array.isArray(gs.legs)) gs.legs = [0, 0];
    gs.legs[w] = (gs.legs[w] || 0) + 1;
    const need = gs.legsToWin || 1;
    if (gs.legs[w] >= need) {
      matchOver = true;
      gs.winner = w;
      gs.nextTurn = null;
    } else {
      // Start next leg — alternate from legStarter like X01.
      const nextStarter = (gs.legStarter === 0 || gs.legStarter === 1) ? 1 - gs.legStarter : opp;
      gs.legStarter = nextStarter;
      gs.currentLeg = (gs.currentLeg || 1) + 1;
      cricketResetLegBoard(gs);
      gs.nextTurn = nextStarter;
    }
  } else {
    gs.winner = null;
    gs.nextTurn = opp;
  }
  gs.turnEnded = true;
  return {
    winnerIdx: matchOver ? w : null,
    legWinnerIdx,
    legWon,
    matchOver,
    points: visitPoints,
    marks: marksGained,
    labels
  };
}

// Server-side fallback game-over check (authoritative safety net).
function cricketGameOver(room) {
  const gs = room.gameState;
  if (!gs || gs.kind !== 'cricket') return { gameOver: false, winner: null };
  const need = gs.legsToWin || 1;
  if (Array.isArray(gs.legs)) {
    if (gs.legs[0] >= need) return { gameOver: true, winner: room.config.hostName };
    if (gs.legs[1] >= need) return { gameOver: true, winner: room.config.guestName };
  }
  // Single-leg / legacy: board closed with a declared winner and no legs progress.
  if ((gs.bestOf || 1) <= 1) {
    const w = cricketWinnerIdx(gs);
    if (w === null || w === undefined) return { gameOver: false, winner: null };
    return { gameOver: true, winner: w === 0 ? room.config.hostName : room.config.guestName };
  }
  return { gameOver: false, winner: null };
}

function cleanupRooms() {
  const now = Date.now();
  let removed = false;
  rooms.forEach((room, roomId) => {
    const spectatorsCount = spectators.get(roomId)?.size || 0;
    if (room.status === 'waiting' && !room.config.bot && now - room.createdAt > WAITING_ROOM_TTL_MS) {
      if (clients.has(room.hostWsId)) {
        const host = clients.get(room.hostWsId);
        if (host) host.roomId = null;
        send(room.hostWsId, { type: 'room_cancelled', roomId, reason: 'expired' });
      }
      rooms.delete(roomId);
      spectators.delete(roomId);
      removed = true;
      return;
    }
    if (room.status === 'finished' && now - room.lastActivity > 60 * 1000 && spectatorsCount === 0) {
      rooms.delete(roomId);
      spectators.delete(roomId);
      removed = true;
      return;
    }
    if (room.status === 'active' && !room.config.bot && !clients.has(room.hostWsId) && !clients.has(room.guestWsId)) {
      rooms.delete(roomId);
      spectators.delete(roomId);
      removed = true;
      return;
    }
    if (room.status === 'waiting' && room.config.bot && now - room.lastActivity > 60 * 1000) {
      rooms.delete(roomId);
      spectators.delete(roomId);
      removed = true;
      return;
    }
  });
  if (removed) broadcastLobbyUpdate();
}

setInterval(cleanupRooms, 30 * 1000);

// ─────────────────────────────────────────────
//  WEBSOCKET HANDLING
// ─────────────────────────────────────────────
// ─── WS abuse mitigation ───
const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP, 10) || 25; // concurrent sockets / IP
const MAX_MSGS_PER_SEC = parseInt(process.env.MAX_MSGS_PER_SEC, 10) || 40; // per socket
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = parseInt(process.env.AUTH_MAX_ATTEMPTS, 10) || 15; // register+login / IP / window
const wsConnByIp = new Map();   // ip -> live socket count
const authAttemptsByIp = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY > 0 && xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Returns true if this IP is allowed another auth attempt (and counts it).
function allowAuthAttempt(ip) {
  const now = Date.now();
  let rec = authAttemptsByIp.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + AUTH_WINDOW_MS }; authAttemptsByIp.set(ip, rec); }
  rec.count++;
  return rec.count <= AUTH_MAX_ATTEMPTS;
}

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
function validatePassword(password) {
  if (typeof password !== 'string') return 'Invalid password.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 72) return 'Password must be 72 characters or fewer.'; // bcrypt truncates beyond 72 bytes
  return null;
}

function validateRegistration(username, password, email) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Invalid username or password.';
  if (!USERNAME_RE.test(username)) return 'Username must be 3–20 characters: letters, numbers, _ or -.';
  const badPw = validatePassword(password);
  if (badPw) return badPw;
  if (!isValidEmail(email)) return 'A valid email address is required.';
  return null;
}

const RESET_REQUEST_OK =
  'If an account matches, a password reset link has been sent. Check your email.';

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (wsConnByIp.get(ip) || 0) + 1;
  if (n > MAX_WS_PER_IP) {
    wsConnByIp.set(ip, n - 1);
    try { ws.close(1013, 'Too many connections'); } catch {}
    return;
  }
  wsConnByIp.set(ip, n);

  const wsId = uuidv4();
  clients.set(wsId, { ws, userId: null, username: null, roomId: null, sessionToken: null, ip, msgWindow: 0, msgWindowStart: 0 });

  ws.on('message', (raw) => {
    // Per-socket flood guard: cap messages/sec, drop the rest silently.
    const c = clients.get(wsId);
    if (c) {
      const now = Date.now();
      if (now - c.msgWindowStart > 1000) { c.msgWindowStart = now; c.msgWindow = 0; }
      if (++c.msgWindow > MAX_MSGS_PER_SEC) return;
    }
    if (raw && raw.length > 64 * 1024) return; // reject absurdly large frames
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Never let a single bad message take down the whole process — that would
    // drop every connected player's session (they'd reconnect logged-out and
    // hit "Must be logged in." on their next action).
    Promise.resolve()
      .then(() => handleMessage(wsId, msg))
      .catch((err) => {
        log('error', `handleMessage error (type=${msg && msg.type}):`, err);
        try { Sentry?.captureException?.(err); } catch { /* ignore */ }
        try { send(wsId, { type: 'error', message: 'Something went wrong handling that action.' }); } catch {}
      });
  });

  ws.on('close', () => {
    const cnt = (wsConnByIp.get(ip) || 1) - 1;
    if (cnt <= 0) wsConnByIp.delete(ip); else wsConnByIp.set(ip, cnt);
    handleDisconnect(wsId);
  });
  ws.on('error', () => handleDisconnect(wsId));

  send(wsId, { type: 'connected', wsId, iceServers: getIceServers(), softLaunch: SOFT_LAUNCH });
  send(wsId, { type: 'arena_status', ...arenaStatusPayload() });
});

async function handleMessage(wsId, msg) {
  const client = clients.get(wsId);
  if (!client) return;

  switch (msg.type) {

    // ── HEARTBEAT ─────────────────────────────
    case 'ping': {
      send(wsId, { type: 'pong', ts: msg.ts });
      break;
    }

    // ── AUTH ──────────────────────────────────
    case 'guest_login': {
      const arena = ensureArenaSettings();
      if (arena.mode !== 'open') {
        return send(wsId, { type: 'auth_error', message: 'Guest access is currently disabled.' });
      }
      if (!client.username) {
        let username;
        do {
          username = `Guest_${Math.floor(Math.random() * 9000 + 1000)}`;
        } while ([...clients.values()].some(c => c.username === username));
        client.username = username;
        client.userId = null;
        client.sessionToken = null;
      }
      send(wsId, {
        type: 'auth_ok',
        username: client.username,
        admin: false,
        softLaunch: SOFT_LAUNCH,
        ...publicProfilePayload(null),
      });
      break;
    }

    case 'register': {
      const { username, password } = msg;
      const email = normalizeEmail(msg.email);
      if (!allowAuthAttempt(client.ip)) {
        return send(wsId, { type: 'auth_error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      const arena = ensureArenaSettings();
      if (arena.mode === 'maintenance') {
        return send(wsId, { type: 'auth_error', message: 'The arena is offline for maintenance. Registration is closed.' });
      }
      const invalid = validateRegistration(username, password, email);
      if (invalid) {
        return send(wsId, { type: 'auth_error', message: invalid });
      }
      if (db.users[username]) {
        return send(wsId, { type: 'auth_error', message: 'Username already taken.' });
      }
      if (findUserByEmail(email)) {
        return send(wsId, { type: 'auth_error', message: 'An account with that email already exists.' });
      }
      const needsApproval = arena.mode === 'invite';
      const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
      db.users[username] = {
        id: uuidv4(), username, email, passwordHash: hash,
        admin: false,
        approved: !needsApproval,
        mustChangePassword: false,
        stats: { wins: 0, losses: 0, highScore: 0, gamesPlayed: 0, tournamentsWon: 0, threeDartAvg: 0, highestCheckout: 0, oneEighties: 0, x01VisitCount: 0, x01PointsTotal: 0 },
        profile: defaultUserProfile(),
        createdAt: Date.now()
      };
      saveData(db);
      if (needsApproval) {
        broadcastArenaStatus();
        return send(wsId, {
          type: 'auth_pending',
          username,
          message: SOFT_LAUNCH
            ? 'Account created! Soft launch is invite-only — an admin will approve your access soon.'
            : 'Account created! An admin must approve your access before you can enter the arena.',
        });
      }
      {
        const user = db.users[username];
        const token = await createSession(username, user.id);
        bindClientSession(client, user, token);
        send(wsId, authOkPayload(user, token));
      }
      break;
    }

    case 'login': {
      const { username, password } = msg;
      if (!allowAuthAttempt(client.ip)) {
        return send(wsId, { type: 'auth_error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      if (typeof username !== 'string' || typeof password !== 'string') {
        return send(wsId, { type: 'auth_error', message: 'Invalid username or password.' });
      }
      const user = db.users[username];
      if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        return send(wsId, { type: 'auth_error', message: 'Invalid username or password.' });
      }
      const arena = ensureArenaSettings();
      if (arena.mode === 'maintenance' && !user.admin) {
        return send(wsId, {
          type: 'auth_error',
          message: arena.message || 'The arena is offline for maintenance.',
        });
      }
      if (!isUserApproved(user)) {
        return send(wsId, { type: 'auth_error', message: 'Your account is awaiting admin approval.' });
      }
      {
        const token = await createSession(username, user.id);
        bindClientSession(client, user, token);
        send(wsId, authOkPayload(user, token));
      }
      break;
    }

    case 'resume_session': {
      const token = msg.token;
      if (!allowAuthAttempt(client.ip)) {
        return send(wsId, { type: 'auth_error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      const found = lookupSession(token);
      if (!found) {
        return send(wsId, { type: 'auth_error', message: 'Session expired. Please sign in again.', code: 'session_expired' });
      }
      const { user } = found;
      const arena = ensureArenaSettings();
      if (arena.mode === 'maintenance' && !user.admin) {
        return send(wsId, {
          type: 'auth_error',
          message: arena.message || 'The arena is offline for maintenance.',
        });
      }
      if (!isUserApproved(user)) {
        return send(wsId, { type: 'auth_error', message: 'Your account is awaiting admin approval.' });
      }
      // Slide expiry forward on successful resume.
      found.sess.expiresAt = Date.now() + SESSION_TTL_MS;
      saveDirty = true;
      // Ensure the refreshed expiry is durable before we confirm the resume —
      // otherwise a restart right after reconnect can revert to a stale TTL.
      await flushData();
      bindClientSession(client, user, token);
      send(wsId, authOkPayload(user, token));
      break;
    }

    case 'logout': {
      const token = msg.token || client.sessionToken;
      revokeSessionToken(token);
      client.userId = null;
      client.username = null;
      client.sessionToken = null;
      send(wsId, { type: 'logout_ok' });
      break;
    }

    case 'change_password': {
      if (!client.username) {
        return send(wsId, { type: 'password_error', message: 'Must be logged in.' });
      }
      const user = db.users[client.username];
      if (!user) return send(wsId, { type: 'password_error', message: 'Account not found.' });
      const currentPassword = msg.currentPassword;
      const newPassword = msg.newPassword;
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return send(wsId, { type: 'password_error', message: 'Invalid password.' });
      }
      if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
        return send(wsId, { type: 'password_error', message: 'Current password is incorrect.' });
      }
      const badPw = validatePassword(newPassword);
      if (badPw) {
        return send(wsId, { type: 'password_error', message: badPw });
      }
      if (newPassword === currentPassword) {
        return send(wsId, { type: 'password_error', message: 'New password must be different from the current password.' });
      }
      user.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
      user.mustChangePassword = false;
      clearPasswordResetsForUser(user.username);
      // Rotate sessions: keep this socket's token, revoke others.
      const keepHash = client.sessionToken ? hashSessionToken(client.sessionToken) : null;
      revokeUserSessions(user.username, keepHash);
      saveDirty = true;
      // The new password hash must be on disk before we tell the client it
      // succeeded — otherwise a restart right after this reverts to the
      // one-time password and mustChangePassword flips back to true.
      await flushData();
      send(wsId, { type: 'password_ok', message: 'Password updated.' });
      break;
    }

    case 'request_password_reset': {
      if (!allowAuthAttempt(client.ip)) {
        return send(wsId, { type: 'auth_error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      if (!emailConfigured()) {
        return send(wsId, {
          type: 'auth_error',
          message: 'Password reset email is unavailable right now. Contact an admin for help.',
        });
      }
      const usernameOrEmail = String(msg.usernameOrEmail || '').trim();
      if (!usernameOrEmail) {
        return send(wsId, { type: 'auth_error', message: 'Enter your username or email.' });
      }
      // Always respond with the same success text to avoid account enumeration.
      // Only send mail when we have a matching account with an email on file.
      const user = findUserByUsernameOrEmail(usernameOrEmail);
      const replyOk = () => send(wsId, { type: 'reset_request_ok', message: RESET_REQUEST_OK });
      if (!user || !isValidEmail(user.email)) {
        return replyOk();
      }
      try {
        const token = createPasswordResetToken(user.username);
        const resetUrl = `${APP_URL}/?reset=${encodeURIComponent(token)}`;
        const subject = 'Reset your Treble-Makers password';
        const text = [
          `Hi ${user.username},`,
          '',
          'We received a request to reset your Treble-Makers Arena password.',
          'Open this link to choose a new password (expires in 1 hour):',
          resetUrl,
          '',
          'If you did not request this, you can ignore this email.',
        ].join('\n');
        const html = `
          <p>Hi <strong>${user.username}</strong>,</p>
          <p>We received a request to reset your Treble-Makers Arena password.</p>
          <p><a href="${resetUrl}">Choose a new password</a> (link expires in 1 hour).</p>
          <p>If you did not request this, you can ignore this email.</p>
        `.trim();
        sendResendEmail({ to: user.email, subject, text, html })
          .then(() => replyOk())
          .catch((err) => {
            log('error', 'Password reset email failed:', err.message || err);
            // Roll back unused token so retries can mint a fresh one.
            clearPasswordResetsForUser(user.username);
            saveData();
            send(wsId, {
              type: 'auth_error',
              message: 'Could not send the reset email. Please try again later.',
            });
          });
      } catch (err) {
        log('error', 'Password reset request failed:', err.message || err);
        send(wsId, {
          type: 'auth_error',
          message: 'Could not send the reset email. Please try again later.',
        });
      }
      break;
    }

    case 'reset_password': {
      if (!allowAuthAttempt(client.ip)) {
        return send(wsId, { type: 'auth_error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      const token = msg.token;
      const newPassword = msg.newPassword;
      if (typeof token !== 'string' || !token) {
        return send(wsId, { type: 'auth_error', message: 'Invalid or expired reset link.' });
      }
      const badPw = validatePassword(newPassword);
      if (badPw) {
        return send(wsId, { type: 'auth_error', message: badPw });
      }
      const user = consumePasswordResetToken(token);
      if (!user) {
        return send(wsId, { type: 'auth_error', message: 'Invalid or expired reset link. Request a new one.' });
      }
      user.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
      user.mustChangePassword = false;
      revokeUserSessions(user.username);
      saveDirty = true;
      // Same durability guarantee as change_password: persist before confirming.
      await flushData();
      send(wsId, { type: 'password_ok', message: 'Password updated. You can sign in with your new password.', code: 'password_reset' });
      break;
    }

    case 'get_leaderboard': {
      const lb = Object.values(db.users)
        .map(u => ({ username: u.username, ...u.stats }))
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 20);
      send(wsId, { type: 'leaderboard', data: lb });
      break;
    }

    // ── ADMIN ─────────────────────────────────
    case 'set_admin': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Unauthorized.' });
      }
      const target = db.users[msg.username];
      if (!target) return send(wsId, { type: 'error', message: 'User not found.' });
      target.admin = !!msg.value;
      saveData(db);
      send(wsId, { type: 'admin_updated', username: msg.username, admin: target.admin });
      break;
    }

    case 'get_arena_status': {
      send(wsId, { type: 'arena_status', ...arenaStatusPayload() });
      break;
    }

    case 'set_arena_mode': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const mode = msg.mode;
      if (!ARENA_MODES.has(mode)) {
        return send(wsId, { type: 'error', message: 'Invalid arena mode.' });
      }
      const arena = ensureArenaSettings();
      arena.mode = mode;
      if (typeof msg.message === 'string') arena.message = msg.message.slice(0, 500);
      saveData(db);
      broadcastArenaStatus();
      if (mode === 'maintenance') {
        kickNonAdminSessions(arena.message || 'The arena is offline for maintenance.');
      }
      send(wsId, { type: 'arena_mode_updated', ...arenaStatusPayload() });
      break;
    }

    case 'approve_user': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const username = String(msg.username || '').trim();
      const target = db.users[username];
      if (!target) return send(wsId, { type: 'error', message: 'User not found.' });
      if (target.approved !== false) {
        return send(wsId, { type: 'error', message: 'User is already approved.' });
      }
      target.approved = true;
      saveData(db);
      broadcastArenaStatus();
      send(wsId, { type: 'user_approved', username });
      break;
    }

    case 'reject_user': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const username = String(msg.username || '').trim();
      const target = db.users[username];
      if (!target) return send(wsId, { type: 'error', message: 'User not found.' });
      if (target.admin) return send(wsId, { type: 'error', message: 'Cannot remove an admin account.' });
      if (target.approved !== false) {
        return send(wsId, { type: 'error', message: 'Only pending accounts can be rejected.' });
      }
      clearPasswordResetsForUser(username);
      revokeUserSessions(username);
      delete db.users[username];
      saveData(db);
      broadcastArenaStatus();
      send(wsId, { type: 'user_rejected', username });
      break;
    }

    // ── LOBBY ─────────────────────────────────
    case 'get_lobby': {
      const isAdmin = !!db.users[client.username]?.admin;
      const openRooms = [...rooms.values()]
        .filter(r => (r.status === 'waiting' || r.status === 'active') && !r.config.bot)
        .filter(r => isAdmin || !UNDER_CONSTRUCTION_GAMES.has(r.config.game))
        .map(r => ({
          id: r.id, game: r.config.game, hostName: r.config.hostName,
          status: r.status, createdAt: r.createdAt,
          spectators: spectators.get(r.id)?.size || 0
        }));
      send(wsId, { type: 'lobby', rooms: openRooms });
      break;
    }

    case 'create_room': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      if (!canPlayGame(msg.game, client.username)) {
        return send(wsId, { type: 'error', message: underConstructionMessage() });
      }
      const room = createRoom(wsId, {
        game: msg.game, hostName: client.username,
        guestName: null, tournamentId: msg.tournamentId || null,
        variation: msg.variation || null, startRule: msg.startRule || null,
        finishRule: msg.finishRule || null, x01Base: msg.x01Base || null,
        legs: msg.legs || null,
        visitTimerSeconds: parseInt(msg.visitTimerSeconds, 10) || 0,
        golfCourse: msg.golfCourse || 'B',
        capEnabled: msg.capEnabled !== false
      });
      client.roomId = room.id;
      send(wsId, { type: 'room_created', roomId: room.id, game: msg.game });
      broadcastLobbyUpdate();
      break;
    }

    case 'cancel_room': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      const room = rooms.get(msg.roomId || client.roomId);
      if (!room || room.status !== 'waiting' || room.config.bot) {
        return send(wsId, { type: 'error', message: 'Only open waiting matches can be cancelled.' });
      }
      if (room.hostWsId !== wsId) {
        return send(wsId, { type: 'error', message: 'Only the host can cancel this match.' });
      }
      rooms.delete(room.id);
      spectators.delete(room.id);
      client.roomId = null;
      broadcastLobbyUpdate();
      send(wsId, { type: 'room_cancelled', roomId: room.id });
      break;
    }

    case 'create_bot_room': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      if (!canPlayGame(msg.game, client.username)) {
        return send(wsId, { type: 'error', message: underConstructionMessage() });
      }
      const room = createRoom(wsId, {
        game: msg.game, hostName: client.username,
        guestName: `Bot (${msg.botSkill || 'easy'})`, bot: true, botSkill: msg.botSkill || 'easy',
        variation: msg.variation || null, startRule: msg.startRule || null,
        finishRule: msg.finishRule || null, x01Base: msg.x01Base || null,
        legs: msg.legs || null,
        visitTimerSeconds: parseInt(msg.visitTimerSeconds, 10) || 0,
        golfCourse: msg.golfCourse || 'B',
        capEnabled: msg.capEnabled !== false
      });
      room.gameState = initGameState(msg.game, room.config);
      client.roomId = room.id;
      send(wsId, {
        type: 'bot_room_started', roomId: room.id, game: msg.game,
        opponentName: room.config.guestName, gameState: room.gameState,
        matchPreview: buildMatchPreview(msg.game, room.config.hostName, room.config.guestName),
      });
      break;
    }

    case 'join_room': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      const room = rooms.get(msg.roomId);
      if (!room || room.status !== 'waiting') return send(wsId, { type: 'error', message: 'Room not available.' });
      if (!canPlayGame(room.config.game, client.username)) {
        return send(wsId, { type: 'error', message: underConstructionMessage() });
      }
      room.guestWsId = wsId;
      room.status = 'active';
      room.config.guestName = client.username;
      room.gameState = initGameState(room.config.game, room.config);
      room.lastActivity = Date.now();
      client.roomId = room.id;
      const matchPreview = buildMatchPreview(room.config.game, room.config.hostName, room.config.guestName);
      // Notify both players
      send(room.hostWsId, {
        type: 'opponent_joined', opponentName: client.username, roomId: room.id,
        gameState: room.gameState, matchPreview,
      });
      send(wsId, {
        type: 'joined_room', roomId: room.id, game: room.config.game,
        opponentName: room.config.hostName, youAre: 'guest', gameState: room.gameState,
        matchPreview,
      });
      broadcastLobbyUpdate();
      break;
    }

    case 'spectate': {
      const room = rooms.get(msg.roomId);
      if (!room) return;
      if (!canPlayGame(room.config.game, client.username)) {
        return send(wsId, { type: 'error', message: underConstructionMessage() });
      }
      spectators.get(room.id)?.add(wsId);
      client.roomId = msg.roomId;
      send(wsId, { type: 'spectating', roomId: room.id, game: room.config.game,
        hostName: room.config.hostName, guestName: room.config.guestName,
        scores: room.scores, history: room.history, turn: room.turn });
      break;
    }

    // ── WHO STARTS (closest to bull / coin / pick) ──
    case 'starter_method': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      if (room.hostWsId !== wsId) {
        return send(wsId, { type: 'error', message: 'Only the match creator can choose who starts.' });
      }
      if (room.starterLocked) return;
      const method = msg.method;
      if (!['bull', 'coin', 'pick'].includes(method)) {
        return send(wsId, { type: 'error', message: 'Invalid starter method.' });
      }
      room.starterMethod = method;
      broadcastToRoom(room, { type: 'starter_method', method, roomId: room.id });
      break;
    }

    case 'bull_throw': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      if (room.starterLocked) return;
      const playerIdx = room.hostWsId === wsId ? 0 : 1;
      // Host may also relay the bot's mark (playerIdx 1)
      const idx = (room.config.bot && room.hostWsId === wsId && msg.playerIdx === 1) ? 1 : playerIdx;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.sqrt(x * x + y * y) > 200) return;
      broadcastToRoom(room, { type: 'bull_throw', roomId: room.id, playerIdx: idx, x, y });
      break;
    }

    case 'coin_toss': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      if (room.hostWsId !== wsId) return;
      if (room.starterLocked) return;
      const starterIdx = msg.starterIdx === 1 ? 1 : 0;
      const endDeg = parseInt(msg.endDeg, 10) || (starterIdx ? 1980 : 1800);
      broadcastToRoom(room, { type: 'coin_toss', roomId: room.id, starterIdx, endDeg });
      break;
    }

    case 'set_match_starter': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      if (room.hostWsId !== wsId) {
        return send(wsId, { type: 'error', message: 'Only the match creator can set who starts.' });
      }
      if (room.starterLocked) return;
      const starterIdx = msg.starterIdx === 1 ? 1 : 0;
      room.turn = starterIdx;
      room.starterLocked = true;
      room.starterMethod = msg.method || room.starterMethod || null;
      if (room.gameState && typeof room.gameState === 'object') {
        if (room.gameState.legStarter !== undefined) room.gameState.legStarter = starterIdx;
        if ('nextTurn' in room.gameState) room.gameState.nextTurn = starterIdx;
      }
      if (room.config.game === 'Golf Checkouts') {
        room.turn = gcSkipWaitingTurn(room.turn, room.gameState);
      }
      const names = [room.config.hostName, room.config.guestName];
      const starterName = msg.starterName || names[starterIdx] || 'Player';
      broadcastToRoom(room, {
        type: 'match_starter_set',
        roomId: room.id,
        starterIdx: room.turn,
        starterName,
        method: room.starterMethod,
        turn: room.turn,
        gameState: room.gameState,
      });
      break;
    }

    case 'match_ui_ready': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      if (room.hostWsId !== wsId) return;
      if (room.uiReady) return;
      room.uiReady = true;
      if (room.config.bot && room.turn === 1) {
        scheduleBotMove(room.id);
      }
      break;
    }

    case 'get_profile': {
      if (!client.username || !db.users[client.username]) {
        return send(wsId, { type: 'profile_error', message: 'Must be logged in.' });
      }
      const payload = publicProfilePayload(db.users[client.username], { includeEmail: true });
      send(wsId, { type: 'profile_ok', username: client.username, ...payload, saved: false });
      break;
    }

    case 'get_user_profile': {
      const target = String(msg.username || '').trim();
      if (!target || !db.users[target]) {
        return send(wsId, { type: 'profile_error', message: 'Player not found.' });
      }
      const payload = publicProfilePayload(db.users[target]);
      send(wsId, { type: 'profile_ok', username: target, ...payload, saved: false });
      break;
    }

    case 'update_profile': {
      if (!client.username || !db.users[client.username]) {
        return send(wsId, { type: 'profile_error', message: 'Must be logged in.' });
      }
      if (/^Guest_/i.test(client.username) || !db.users[client.username].passwordHash) {
        return send(wsId, { type: 'profile_error', message: 'Guests cannot save a profile.' });
      }
      const user = db.users[client.username];
      const profile = ensureUserProfile(user);
      const scrub = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
      profile.country = scrub(msg.country, 40);
      profile.league = scrub(msg.league, 60);
      profile.equipment = scrub(msg.equipment, 120);
      if (Object.prototype.hasOwnProperty.call(msg, 'avatarUrl')) {
        const avatar = sanitizeAvatarDataUrl(msg.avatarUrl);
        if (avatar === null) {
          return send(wsId, { type: 'profile_error', message: 'Invalid avatar image. Use a small JPEG/PNG/WebP.' });
        }
        profile.avatarUrl = avatar;
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'email')) {
        const email = normalizeEmail(msg.email);
        if (!isValidEmail(email)) {
          return send(wsId, { type: 'profile_error', message: 'A valid email address is required.' });
        }
        const taken = findUserByEmail(email);
        if (taken && taken.username !== user.username) {
          return send(wsId, { type: 'profile_error', message: 'An account with that email already exists.' });
        }
        user.email = email;
      }
      user.profile = profile;
      saveData(db);
      const payload = publicProfilePayload(user, { includeEmail: true });
      send(wsId, { type: 'profile_ok', username: client.username, ...payload, saved: true });
      break;
    }

    // ── WEBRTC SIGNALING ──────────────────────
    case 'webrtc_offer':
    case 'webrtc_answer':
    case 'webrtc_ice': {
      const room = rooms.get(client.roomId);
      if (!room) return;
      const targetId = room.hostWsId === wsId ? room.guestWsId : room.hostWsId;
      if (targetId) send(targetId, msg);
      break;
    }

    // ── GAME STATE ────────────────────────────
    case 'submit_score': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      const isHost = room.hostWsId === wsId;
      const playerIdx = isHost ? 0 : 1;
      if (room.turn !== playerIdx) return send(wsId, { type: 'error', message: 'Not your turn.' });

      room.gameState = msg.gameState
        ? structuredClone(msg.gameState)
        : room.gameState;
      room.lastActivity = Date.now();
      room.scores[playerIdx] += msg.delta || 0;
      if (msg.absoluteScore !== undefined) room.scores[playerIdx] = msg.absoluteScore;
      room.history.unshift({ player: client.username, score: msg.displayScore, note: msg.note, ts: Date.now() });
      if (room.history.length > 50) room.history.pop();
      recordCareerVisitStats(client.username, msg.displayScore, { checkout: msg.x01Checkout });
      room.round = Math.floor(room.history.length / 2);
      const turnEnded = shouldSwitchTurn(room.config.game, room.gameState);
      if (turnEnded) {
        room.turn = 1 - room.turn;
        if (room.config.game === 'Golf Checkouts') {
          room.turn = gcSkipWaitingTurn(room.turn, room.gameState);
        }
      }
      // X01 / Cricket control the exact next thrower via gameState.nextTurn.
      if ((isX01Game(room.config.game) || isCricketGame(room.config.game)) && room.gameState &&
          room.gameState.nextTurn !== null && room.gameState.nextTurn !== undefined) {
        room.turn = room.gameState.nextTurn;
      }
      room.gameState.turnEnded = false;

      const update = {
        type: 'score_update', scores: room.scores, turn: room.turn,
        round: room.round, history: room.history.slice(0, 1),
        gameState: room.gameState
      };
      broadcastToRoom(room, update);

      let gameOver = msg.gameOver;
      let winnerName = msg.winner;
      if (!gameOver && (room.config.game === 'Golf Darts' || room.config.game === 'Golf Checkouts')) {
        const result = computeGolfGameOver(room);
        gameOver = result.gameOver;
        winnerName = result.winner;
      }
      if (!gameOver && room.config.game === 'Halve-It' && halveItGameOver(room.gameState)) {
        gameOver = true;
        winnerName = halveItWinner(room);
      }
      if (!gameOver && isCricketGame(room.config.game)) {
        try {
          const result = cricketGameOver(room);
          gameOver = result.gameOver;
          winnerName = result.winner;
        } catch (err) {
          console.error('cricketGameOver failed:', err);
          room.gameState = ensureCricketState(room.gameState, room.config, room.config.game);
        }
      }
      if (gameOver) {
        room.status = 'finished';
        room.lastActivity = Date.now();
        const loserName = winnerName === room.config.hostName ? room.config.guestName : room.config.hostName;
        if (winnerName) updateStats(winnerName, loserName, msg.highScore || 0);
        const endMsg = buildGameOverMessage(room, winnerName, msg.matchStats);
        broadcastToRoom(room, endMsg);
        if (room.config.tournamentId && room.config.bracketMatchId && winnerName) {
          recordTournamentMatchResult(room.config.tournamentId, room.config.bracketMatchId, winnerName);
        }
        broadcastLobbyUpdate();
      } else if (room.config.bot && room.turn === 1) {
        // Schedule on final turn===1 (not only turnEnded) so cricket/tactics
        // bots keep moving even if nextTurn wiring and turnEnded disagree.
        scheduleBotMove(room.id);
      }
      break;
    }

    // ── X01 UNDO ──────────────────────────────
    case 'x01_undo': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active' || !isX01Game(room.config.game)) return;
      const isHost = room.hostWsId === wsId;
      if (!isHost && room.guestWsId !== wsId) return;
      if (msg.gameState) room.gameState = structuredClone(msg.gameState);
      if (Array.isArray(msg.scores)) room.scores = msg.scores.slice(0, 2);
      if (typeof msg.turn === 'number') room.turn = msg.turn;
      room.lastActivity = Date.now();
      const update = {
        type: 'score_update', scores: room.scores, turn: room.turn,
        round: room.round, history: [], gameState: room.gameState
      };
      broadcastToRoom(room, update);
      break;
    }

    case 'x01_edit': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active' || !isX01Game(room.config.game)) return;
      const isHost = room.hostWsId === wsId;
      if (!isHost && room.guestWsId !== wsId) return;
      // Finishing edits in human matches must go through opponent approval.
      if (room.pendingX01Edit) {
        return send(wsId, { type: 'error', message: 'A finishing edit is already waiting for approval.' });
      }
      applyX01EditToRoom(room, msg, { fromEdit: true });
      break;
    }

    case 'x01_edit_request': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active' || !isX01Game(room.config.game)) return;
      const isHost = room.hostWsId === wsId;
      if (!isHost && room.guestWsId !== wsId) return;
      if (room.config.bot) {
        // Bots cannot approve — apply immediately.
        applyX01EditToRoom(room, msg, { fromEdit: true });
        break;
      }
      if (room.pendingX01Edit) {
        return send(wsId, { type: 'error', message: 'A finishing edit is already waiting for approval.' });
      }
      if (!msg.gameState || !Array.isArray(msg.scores)) {
        return send(wsId, { type: 'error', message: 'Invalid edit request.' });
      }
      const opponentWsId = isHost ? room.guestWsId : room.hostWsId;
      if (!opponentWsId || !clients.has(opponentWsId)) {
        return send(wsId, { type: 'error', message: 'Opponent is not connected to approve this edit.' });
      }
      room.pendingX01Edit = {
        fromWsId: wsId,
        gameState: structuredClone(msg.gameState),
        scores: msg.scores.slice(0, 2),
        turn: msg.turn,
        gameOver: !!msg.gameOver,
        winner: msg.winner || null,
        highScore: msg.highScore || 0,
        matchStats: msg.matchStats || null,
        summary: msg.summary || {}
      };
      room.lastActivity = Date.now();
      send(wsId, { type: 'x01_edit_waiting' });
      send(opponentWsId, {
        type: 'x01_edit_pending',
        summary: room.pendingX01Edit.summary
      });
      break;
    }

    case 'x01_edit_decision': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active' || !isX01Game(room.config.game)) return;
      const pending = room.pendingX01Edit;
      if (!pending) return;
      const isHost = room.hostWsId === wsId;
      if (!isHost && room.guestWsId !== wsId) return;
      // Only the opponent (not the editor) may decide.
      if (wsId === pending.fromWsId) {
        return send(wsId, { type: 'error', message: 'You cannot approve your own finishing edit.' });
      }
      const editorWsId = pending.fromWsId;
      room.pendingX01Edit = null;
      room.lastActivity = Date.now();

      if (!msg.accepted) {
        if (editorWsId && clients.has(editorWsId)) {
          send(editorWsId, {
            type: 'x01_edit_rejected',
            message: 'Opponent rejected the finishing edit. Leg win was not granted.'
          });
        }
        break;
      }

      applyX01EditToRoom(room, pending, { fromEdit: true });
      break;
    }

    // ── CRICKET UNDO ──────────────────────────
    case 'cricket_undo': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active' || !isCricketGame(room.config.game)) return;
      const isHost = room.hostWsId === wsId;
      if (!isHost && room.guestWsId !== wsId) return;
      if (msg.gameState) room.gameState = structuredClone(msg.gameState);
      if (Array.isArray(msg.scores)) room.scores = msg.scores.slice(0, 2);
      if (typeof msg.turn === 'number') room.turn = msg.turn;
      room.gameState = ensureCricketState(room.gameState, room.config, room.config.game);
      room.lastActivity = Date.now();
      const update = {
        type: 'score_update', scores: room.scores, turn: room.turn,
        round: room.round, history: [], gameState: room.gameState
      };
      broadcastToRoom(room, update);
      if (room.config.bot && room.turn === 1) scheduleBotMove(room.id);
      break;
    }

    // ── CHAT ──────────────────────────────────
    case 'chat': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'active') return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : '';
      if (!text) return;
      const chatMsg = {
        type: 'chat', roomId: room.id, from: client.username, text, ts: Date.now()
      };
      broadcastToRoom(room, chatMsg);
      break;
    }

    case 'leave_room': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (room) {
        if (room.pendingX01Edit) {
          const pending = room.pendingX01Edit;
          room.pendingX01Edit = null;
          const otherWsId = wsId === room.hostWsId ? room.guestWsId : room.hostWsId;
          if (otherWsId && clients.has(otherWsId)) {
            if (wsId === pending.fromWsId) {
              send(otherWsId, { type: 'x01_edit_rejected', message: 'Editor left — finishing edit cancelled.' });
            } else {
              send(otherWsId, {
                type: 'x01_edit_rejected',
                message: 'Opponent left before approving the finishing edit.'
              });
            }
          }
        }
        spectators.get(room.id)?.delete(wsId);
        if (room.hostWsId === wsId && room.status === 'waiting') {
          rooms.delete(room.id);
          spectators.delete(room.id);
          broadcastLobbyUpdate();
        } else if (room.guestWsId === wsId) {
          room.guestWsId = null;
          if (room.status === 'active') {
            room.status = 'finished';
            broadcastToRoom(room, { type: 'opponent_disconnected', roomId: room.id });
          }
        }
      }
      client.roomId = null;
      send(wsId, { type: 'left_room' });
      break;
    }

    // ── TOURNAMENTS ───────────────────────────
    case 'create_tournament': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 60) : '';
      if (name.length < 2) {
        return send(wsId, { type: 'error', message: 'Tournament name must be 2–60 characters.' });
      }
      if (typeof msg.game !== 'string' || msg.game.length > 40) {
        return send(wsId, { type: 'error', message: 'Invalid game selection.' });
      }
      const maxPlayers = Math.min(64, Math.max(2, parseInt(msg.maxPlayers, 10) || 16));
      const t = {
        id: uuidv4(), name, game: msg.game,
        format: msg.format || 'single_elimination',
        maxPlayers,
        players: [], bracket: [], status: 'registration',
        createdBy: client.username, createdAt: Date.now(),
        startDate: msg.startDate || null,
        waitForHostJoin: !!msg.waitForHostJoin,
        variation: msg.variation || null,
        startRule: msg.startRule || null,
        finishRule: msg.finishRule || null,
        x01Base: msg.x01Base || null
      };
      const botsAdded = msg.addTestBots !== false ? addTestBotsToTournament(t) : 0;
      db.tournaments.push(t);
      saveData(db);
      broadcastAll({ type: 'tournament_created', tournament: sanitizeTournament(t), botsAdded });
      break;
    }

    case 'register_tournament': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t || t.status !== 'registration') return send(wsId, { type: 'error', message: 'Registration closed.' });
      ensureTournamentPlayers(t);
      if (t.players.includes(client.username)) return send(wsId, { type: 'error', message: 'Already registered.' });
      if (t.players.length >= t.maxPlayers) return send(wsId, { type: 'error', message: 'Tournament full.' });
      t.players.push(client.username);
      saveData(db);
      broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t) });
      break;
    }

    case 'get_users': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const data = Object.values(db.users)
        .map(u => ({
          username: u.username,
          admin: !!u.admin,
          approved: u.approved !== false,
          pending: u.approved === false,
        }))
        .sort((a, b) => a.username.localeCompare(b.username));
      send(wsId, { type: 'users', data });
      break;
    }

    case 'add_tournament_player': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t) return send(wsId, { type: 'error', message: 'Tournament not found.' });
      const username = String(msg.username || '').trim();
      if (!username) return send(wsId, { type: 'error', message: 'Enter a player name.' });
      ensureTournamentPlayers(t);
      if (t.status !== 'registration') return send(wsId, { type: 'error', message: 'Registration closed.' });
      if (t.players.includes(username)) return send(wsId, { type: 'error', message: 'Player already registered.' });
      if (t.players.length >= t.maxPlayers) return send(wsId, { type: 'error', message: 'Tournament full.' });
      if (!isBotPlayer(username) && !db.users[username]) {
        return send(wsId, { type: 'error', message: 'Unknown user — they must have an account first.' });
      }
      t.players.push(username);
      saveData(db);
      broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t) });
      break;
    }

    case 'remove_tournament_player': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t) return send(wsId, { type: 'error', message: 'Tournament not found.' });
      const username = String(msg.username || '').trim();
      if (!username) return send(wsId, { type: 'error', message: 'Select a player to remove.' });
      ensureTournamentPlayers(t);
      if (t.status !== 'registration') {
        return send(wsId, { type: 'error', message: 'Cannot remove players after the tournament has started.' });
      }
      const idx = t.players.indexOf(username);
      if (idx === -1) return send(wsId, { type: 'error', message: 'Player not in this tournament.' });
      t.players.splice(idx, 1);
      saveData(db);
      broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t) });
      break;
    }

    case 'add_tournament_bots': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t || t.status !== 'registration') {
        return send(wsId, { type: 'error', message: 'Bots can only be added during registration.' });
      }
      const botsAdded = addTestBotsToTournament(t);
      saveData(db);
      broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t), botsAdded });
      break;
    }

    case 'start_tournament': {
      if (!client.username || !db.users[client.username]?.admin) {
        return send(wsId, { type: 'error', message: 'Admin only.' });
      }
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t) return;
      ensureTournamentPlayers(t);
      if (t.players.length < 2) {
        return send(wsId, { type: 'error', message: 'Need at least 2 players to start.' });
      }
      if (t.waitForHostJoin && t.createdBy && !t.players.includes(t.createdBy)) {
        return send(wsId, { type: 'error', message: 'Register for this tournament before starting it.' });
      }
      t.status = 'active';
      t.bracket = generateBracket(t.players);
      finalizeBracketStart(t);
      saveData(db);
      broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t) });
      break;
    }

    case 'start_bracket_match': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t || t.status !== 'active') {
        return send(wsId, { type: 'error', message: 'Tournament not active.' });
      }
      finalizeBracketStart(t);
      const match = findBracketMatch(t, msg.matchId);
      if (!match) return send(wsId, { type: 'error', message: 'Match not found.' });
      if (match.winner) return send(wsId, { type: 'error', message: 'Match already completed.' });
      if (!match.p1 || !match.p2 || match.p1 === 'BYE' || match.p2 === 'BYE') {
        return send(wsId, { type: 'error', message: 'Match not ready yet.' });
      }
      const user = client.username;
      if (user !== match.p1 && user !== match.p2) {
        return send(wsId, { type: 'error', message: 'This is not your bracket match.' });
      }
      const opponent = user === match.p1 ? match.p2 : match.p1;
      if (!isBotPlayer(opponent)) {
        return send(wsId, { type: 'error', message: 'Human vs human bracket matches are not available during soft launch — use bots or play from the lobby.' });
      }
      const room = createRoom(wsId, {
        game: t.game,
        hostName: user,
        guestName: opponent,
        bot: true,
        botSkill: botSkillFromName(opponent),
        tournamentId: t.id,
        bracketMatchId: match.id,
        variation: t.variation || null,
        startRule: t.startRule || null,
        finishRule: t.finishRule || null,
        x01Base: t.x01Base || null,
        legs: t.legs || null
      });
      room.gameState = initGameState(t.game, room.config);
      client.roomId = room.id;
      match.roomId = room.id;
      saveData(db);
      send(wsId, {
        type: 'bot_room_started',
        roomId: room.id,
        game: t.game,
        opponentName: opponent,
        gameState: room.gameState,
        tournamentId: t.id,
        bracketMatchId: match.id,
        tournamentName: t.name,
        matchPreview: buildMatchPreview(t.game, user, opponent),
      });
      break;
    }

    case 'delete_tournament': {
      if (!client.username) return send(wsId, { type: 'error', message: 'Must be logged in.' });
      const t = db.tournaments.find(t => t.id === msg.tournamentId);
      if (!t) return send(wsId, { type: 'error', message: 'Tournament not found.' });
      if (!isTournamentUnplayed(t)) {
        return send(wsId, { type: 'error', message: 'Only unplayed tournaments can be removed.' });
      }
      const isAdmin = !!db.users[client.username]?.admin;
      if (t.createdBy !== client.username && !isAdmin) {
        return send(wsId, { type: 'error', message: 'Only the creator or an admin can remove this tournament.' });
      }
      db.tournaments = db.tournaments.filter(x => x.id !== t.id);
      saveData(db);
      broadcastAll({ type: 'tournament_deleted', tournamentId: t.id });
      break;
    }

    case 'get_tournaments': {
      send(wsId, { type: 'tournaments', data: db.tournaments.map(sanitizeTournament) });
      break;
    }
  }
}

function handleDisconnect(wsId) {
  const client = clients.get(wsId);
  if (client?.roomId) {
    const room = rooms.get(client.roomId);
    if (room) {
      if (room.status === 'waiting' && !room.config.bot) {
        rooms.delete(client.roomId);
        spectators.delete(client.roomId);
        broadcastLobbyUpdate();
      } else if (room.status === 'active') {
        if (room.config.bot) {
          rooms.delete(client.roomId);
          spectators.delete(client.roomId);
        } else {
          const otherId = room.hostWsId === wsId ? room.guestWsId : room.hostWsId;
          if (otherId) send(otherId, { type: 'opponent_disconnected', roomId: room.id });
          room.status = 'finished';
          room.lastActivity = Date.now();
          broadcastLobbyUpdate();
        }
      }
    }
    spectators.get(client.roomId)?.delete(wsId);
  }
  clients.delete(wsId);
}

// ─────────────────────────────────────────────
//  BOT AI
// ─────────────────────────────────────────────
function scheduleBotMove(roomId, attempt = 0) {
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (!room || !room.config.bot || room.status !== 'active' || room.turn !== 1) return;
    try {
      botTakeTurn(room);
    } catch (err) {
      console.error('Bot turn failed:', err);
      // Recover from transient state errors so cricket/tactics bots don't freeze mid-match.
      if (attempt < 2 && room.status === 'active' && room.turn === 1) {
        if (isCricketGame(room.config.game)) {
          room.gameState = ensureCricketState(room.gameState, room.config, room.config.game);
        }
        scheduleBotMove(roomId, attempt + 1);
      }
    }
  }, attempt === 0 ? 1000 : 600);
}

function botTakeTurn(room) {
  const move = computeBotMove(room);
  room.lastActivity = Date.now();
  room.history.unshift({ player: room.config.guestName, score: move.displayScore, note: move.note, ts: Date.now() });
  if (room.history.length > 50) room.history.pop();
  room.turn = (move.nextTurn !== undefined && move.nextTurn !== null)
    ? move.nextTurn
    : (move.keepTurn ? 1 : 0);
  if (room.config.game === 'Golf Checkouts' && !move.keepTurn) {
    room.turn = gcSkipWaitingTurn(room.turn, room.gameState);
  }
  if (move.absoluteScore !== undefined) room.scores[1] = move.absoluteScore;
  else room.scores[1] += move.delta || 0;
  room.gameState = move.gameState || room.gameState;
  if (move.gameOver) {
    room.status = 'finished';
    room.lastActivity = Date.now();
    if (move.winner === room.config.guestName) {
      updateStats(room.config.guestName, room.config.hostName, move.highScore || 0);
    } else if (move.winner === room.config.hostName) {
      updateStats(room.config.hostName, room.config.guestName, move.highScore || 0);
    }
  }

  const update = {
    type: 'score_update', scores: room.scores, turn: room.turn,
    round: room.round, history: room.history.slice(0, 1),
    gameState: room.gameState
  };
  send(room.hostWsId, update);
  if (move.gameOver) {
    const endMsg = buildGameOverMessage(room, move.winner, move.matchStats);
    send(room.hostWsId, endMsg);
    if (room.config.tournamentId && room.config.bracketMatchId && move.winner) {
      recordTournamentMatchResult(room.config.tournamentId, room.config.bracketMatchId, move.winner);
    }
  } else if (room.turn === 1 && room.status === 'active') {
    scheduleBotMove(room.id);
  }
}

function computeBotMove(room) {
  const gs = room.gameState || {};
  const skill = room.config.botSkill || 'easy';
  const rand = () => Math.random();
  const chooseTarget = (targetValue) => {
    if (typeof targetValue === 'number') return targetValue;
    if (targetValue === 'D') return 25;
    if (targetValue === 'T') return 45;
    if (targetValue === 'Bull') return 25;
    return 20;
  };
  const difficulty = { easy: 0.45, medium: 0.65, hard: 0.85, adaptive: 0.75 }[skill] || 0.55;
  let move = { delta: 0, absoluteScore: undefined, displayScore: 'MISS', note: 'Miss', gameState: gs, gameOver: false, winner: '', keepTurn: false };
  const game = room.config.game;

  if (isX01Game(game)) {
    const p = 1;
    if (!gs.remaining) Object.assign(gs, initX01State(room.config, game));
    const rem = gs.remaining[p];
    const avg = { easy: 38, medium: 58, hard: 84, adaptive: 70 }[skill] || 45;
    const coAttempt = { easy: 0.18, medium: 0.34, hard: 0.6, adaptive: 0.45 }[skill] || 0.2;

    let total;
    if (!gs.opened[p]) {
      // Open the leg (limited start-rule modelling under turn-total entry).
      total = Math.max(2, Math.round(avg + (rand() * 30 - 15)));
    } else if (rem <= 170 && x01IsValidCheckout(rem, gs.finishRule) && rem !== 1 && rand() < coAttempt) {
      total = rem; // go for the checkout
    } else {
      total = Math.round(avg + (rand() * 50 - 25));
      total = Math.max(0, Math.min(180, total));
      // Avoid certain busts / leaving an unfinishable 1 — aim for a sensible setup.
      const dblOut = gs.finishRule === 'double-out' || gs.finishRule === 'master-out';
      if (total > rem || (dblOut && rem - total === 1) || (rem - total) < 2) {
        const setupTargets = [40, 32, 36, 24, 16, 8];
        const want = setupTargets.find(s => rem - s >= 2 && rem - s <= 180);
        total = want != null ? rem - want : Math.max(0, rem - 60);
        if (total < 0 || total > 180) total = Math.min(rem - 2, Math.max(0, Math.round(avg)));
        if (total < 0) total = 0;
      }
    }

    const res = x01ApplyTurn(gs, p, total);
    move.gameState = gs;
    move.delta = 0;
    move.absoluteScore = gs.legs[p];
    move.keepTurn = false;
    move.nextTurn = res.matchOver ? 0 : gs.nextTurn;
    move.displayScore = res.bust ? 'BUST' : String(total);
    if (res.matchOver) move.note = `${room.config.guestName} wins the match!`;
    else if (res.legWon) move.note = `${room.config.guestName} wins leg ${gs.currentLeg - 1}!`;
    else if (res.bust) move.note = `BUST · ${gs.remaining[p]} left`;
    else move.note = `${total} · ${gs.remaining[p]} left`;
    if (res.matchOver) { move.gameOver = true; move.winner = room.config.guestName; }
    move.highScore = Math.max(gs.points[0], gs.points[1]);
    move.matchStats = { scores: [gs.legs[0], gs.legs[1]], time: Math.floor((Date.now() - room.createdAt) / 1000), bestRound: Math.max(gs.points[0], gs.points[1]) };
    return move;
  }

  if (isCricketGame(game)) {
    const p = 1;
    room.gameState = ensureCricketState(gs, room.config, game);
    const state = room.gameState;
    const hitChance = { easy: 0.45, medium: 0.62, hard: 0.8, adaptive: 0.72 }[skill] || 0.5;
    const tripleChance = { easy: 0.07, medium: 0.15, hard: 0.28, adaptive: 0.2 }[skill] || 0.1;
    const doubleChance = 0.2;
    const darts = [];
    for (let i = 0; i < 3; i++) {
      const botOpen = state.targets.filter(t => (state.marks[p][t] || 0) < 3);
      const defensive = state.targets.filter(t =>
        (state.marks[1 - p][t] || 0) >= 3 && (state.marks[p][t] || 0) < 3);
      let target;
      if (defensive.length && state.variation !== 'no-score' && rand() < 0.55) {
        target = defensive.sort((a, b) => b - a)[0]; // close opponent's scorer
      } else if (botOpen.length) {
        target = botOpen.sort((a, b) => b - a)[0]; // open/score highest value
      } else {
        const scoreable = state.targets.filter(t => (state.marks[1 - p][t] || 0) < 3);
        target = (scoreable.length ? scoreable : state.targets).sort((a, b) => b - a)[0];
      }
      if (target == null) {
        darts.push({ miss: true, dead: false, target: null, marks: 0, label: 'Miss' });
        continue;
      }
      if (rand() < hitChance) {
        const r = rand();
        let marks = 1, label;
        if (target === CRICKET_BULL) {
          if (r < tripleChance) { marks = 2; label = 'IB'; }
          else { marks = 1; label = 'OB'; }
        } else if (r < tripleChance) { marks = 3; label = 'T' + target; }
        else if (r < tripleChance + doubleChance) { marks = 2; label = 'D' + target; }
        else { marks = 1; label = String(target); }
        darts.push({ miss: false, dead: false, target, marks, label });
      } else {
        darts.push({ miss: true, dead: false, target: null, marks: 0, label: 'Miss' });
      }
    }
    const res = applyCricketVisit(state, p, darts);
    move.gameState = state;
    move.absoluteScore = state.score[p];
    move.nextTurn = res.matchOver
      ? 0
      : (state.nextTurn === 0 || state.nextTurn === 1 ? state.nextTurn : 0);
    move.displayScore = darts.map(d => d.label).join(' ');
    if (res.matchOver) move.note = `${room.config.guestName} wins the match!`;
    else if (res.legWon) {
      const lw = res.legWinnerIdx === 0 ? room.config.hostName : room.config.guestName;
      move.note = `${lw} wins the leg!`;
    } else if (res.points > 0) move.note = `BOT ${move.displayScore} · +${res.points}`;
    else move.note = `BOT ${move.displayScore}`;
    if (res.matchOver) {
      move.gameOver = true;
      const w = res.winnerIdx !== null && res.winnerIdx !== undefined
        ? res.winnerIdx
        : (state.legs[1] >= (state.legsToWin || 1) ? 1 : 0);
      move.winner = w === 0 ? room.config.hostName : room.config.guestName;
    }
    move.highScore = Math.max(state.score[0], state.score[1]);
    move.matchStats = {
      scores: [state.legs?.[0] || 0, state.legs?.[1] || 0],
      time: Math.floor((Date.now() - room.createdAt) / 1000),
      bestRound: res.points
    };
    return move;
  }

  if (game === 'Halve-It') {
    gs.targets = gs.targets || generateHalveItTargets();
    gs.roundProgress = gs.roundProgress || [
      { round: 0, throws: 0, hits: 0, pending: 0, total: 0, currentDarts: [] },
      { round: 0, throws: 0, hits: 0, pending: 0, total: 0, currentDarts: [] }
    ];
    const progress = gs.roundProgress[1];
    const target = gs.targets[progress.round] ?? gs.targets[0];
    const hitChance = Math.min(0.95, Math.max(0.25, difficulty + (typeof target === 'number' ? 0 : 0.1)));
    const dartLabels = [];
    progress.currentDarts = progress.currentDarts || [];
    if (progress.throws === 0) progress.currentDarts = [];
    // Finish the bot's full 3-dart round in one turn (avoids chained schedule gaps).
    while (progress.throws < 3) {
      const hit = rand() < hitChance;
      let score = 0;
      let label = 'MISS';
      if (hit) {
        if (target === 'D') {
          const base = Math.floor(rand() * 20) + 1;
          score = base * 2;
          label = `D${base}`;
        } else if (target === 'T') {
          const base = Math.floor(rand() * 20) + 1;
          score = base * 3;
          label = `T${base}`;
        } else if (target === 'Bull') {
          score = rand() < 0.35 ? 50 : 25;
          label = score === 50 ? 'DBULL' : 'BULL';
        } else {
          const mult = rand() < 0.15 ? 3 : rand() < 0.45 ? 2 : 1;
          score = target * mult;
          label = `${mult === 3 ? 'T' : mult === 2 ? 'D' : 'S'}${target}`;
        }
        progress.pending += score;
        progress.hits++;
      }
      progress.throws++;
      progress.currentDarts.push({ display: label, hit });
      dartLabels.push(label);
    }
    move.displayScore = dartLabels.join(' ');
    if (progress.hits === 0) {
      progress.total = Math.floor(progress.total / 2);
      move.absoluteScore = progress.total;
      move.note = 'BOT ÷2 HALVED';
    } else {
      progress.total += progress.pending;
      move.delta = progress.pending;
      move.absoluteScore = progress.total;
      move.note = `BOT round complete +${progress.pending}`;
    }
    gs.playerRounds = gs.playerRounds || [[], []];
    gs.playerRounds[1].push({
      round: progress.round + 1, target, darts: progress.throws,
      hits: progress.hits, roundScore: progress.pending, total: progress.total, hit: progress.hits > 0
    });
    progress.round++;
    progress.throws = 0;
    progress.hits = 0;
    progress.pending = 0;
    gs.roundIdx = Math.max(gs.roundProgress[0]?.round || 0, progress.round);
    gs.turnEnded = true;
    move.keepTurn = false;
    if (halveItGameOver(gs)) {
      move.gameOver = true;
      move.winner = halveItWinner({ ...room, scores: [room.scores[0], move.absoluteScore ?? room.scores[1]] });
    }
    move.gameState = gs;
  } else if (game === 'Football Darts') {
    const playerIdx = 1;
    const botName = room.config.guestName || 'Bot';
    gs.goals = gs.goals || [0, 0];
    gs.events = gs.events || [];
    gs.visitDarts = gs.visitDarts || [0, 0];
    gs.visitThrows = gs.visitThrows || [[], []];
    if (gs.possession === undefined) gs.possession = null;

    const hasPossession = gs.possession === playerIdx;
    gs.visitDarts[playerIdx] = (gs.visitDarts[playerIdx] || 0) + 1;
    let scored = false;

    if (!hasPossession) {
      if (rand() < difficulty * 0.55) {
        gs.possession = playerIdx;
        gs.events.unshift({ text: `🟢 ${botName} took possession!` });
        move.displayScore = 'DBULL';
        move.note = 'BOT took possession!';
      } else {
        gs.events.unshift({ text: `${botName}: missed possession` });
        move.displayScore = 'MISS';
        move.note = 'BOT missed possession';
      }
      move.delta = 0;
    } else if (rand() < difficulty) {
      const useDBull = rand() < 0.12;
      gs.goals[playerIdx] = (gs.goals[playerIdx] || 0) + 1;
      gs.ballX = Math.max(5, (gs.ballX || 50) - 15);
      gs.events.unshift({ text: `⚽ GOAL by ${botName}!` });
      move.delta = 1;
      scored = true;
      move.displayScore = useDBull ? 'DBULL' : `D${1 + Math.floor(rand() * 20)}`;
      move.note = '⚽ BOT GOAL!';
    } else {
      gs.events.unshift({ text: `${botName}: miss` });
      move.delta = 0;
      move.displayScore = 'MISS';
      move.note = 'BOT miss';
    }

    gs.visitThrows[playerIdx] = gs.visitThrows[playerIdx] || [];
    gs.visitThrows[playerIdx].push({ display: move.displayScore, goal: scored });

    if (gs.visitDarts[playerIdx] >= 3) {
      gs.visitDarts[playerIdx] = 0;
      gs.visitThrows[playerIdx] = [];
      gs.turnEnded = true;
      move.keepTurn = false;
      gs.round = (gs.round || 0) + 1;
    } else {
      gs.turnEnded = false;
      move.keepTurn = true;
    }

    move.absoluteScore = gs.goals[playerIdx];
    if (gs.goals[playerIdx] >= 10) {
      move.gameOver = true;
      move.winner = botName;
    }
    if (!move.gameOver && gs.turnEnded && (gs.round || 0) >= 20) {
      move.gameOver = true;
      const g0 = gs.goals[0] || 0, g1 = gs.goals[1] || 0;
      move.winner = g1 === g0 ? null : (g1 > g0 ? botName : room.config.hostName);
    }
    move.gameState = gs;
  } else if (game === 'Snakes & Ladders') {
    const roll = Math.ceil(rand() * 6);
    gs.pos = gs.pos || [0,0];
    let pos = gs.pos[1] + roll;
    if (pos > 100) pos = 100 - (pos - 100);
    if (gs.ladders?.[pos]) { pos = gs.ladders[pos]; move.note = `BOT Ladder ${pos}`; }
    else if (gs.snakes?.[pos]) { pos = gs.snakes[pos]; move.note = `BOT Snake ${pos}`; }
    gs.pos[1] = Math.min(100, Math.max(0, pos));
    move.absoluteScore = gs.pos[1];
    move.displayScore = `sq.${gs.pos[1]}`;
    if (gs.pos[1] >= 100) {
      move.gameOver = true;
      move.winner = room.config.guestName;
    }
    move.gameState = gs;
  } else if (game === 'Golf Darts') {
    if (!gs.holes?.length) {
      Object.assign(gs, {
        holes: Array.from({ length: 18 }, (_, i) => i + 1),
        playerHoles: gs.playerHoles || [0, 0],
        playerDarts: gs.playerDarts || [[], []],
        playerHoleScores: gs.playerHoleScores || [[], []],
        ballPos: gs.ballPos || [[50, 85], [50, 15]]
      });
    }
    gs.playerHoles = gs.playerHoles || [0,0];
    gs.playerDarts = gs.playerDarts || [[],[]];
    gs.playerHoleScores = gs.playerHoleScores || [[],[]];
    const holeIdx = gs.playerHoles[1] || 0;
    const target = gs.holes?.[holeIdx] ?? holeIdx + 1;
    const darts = gs.playerDarts[1] || [];
    if (darts.length >= 3) {
      move.note = 'BOT already finished hole';
      move.keepTurn = false;
      gs.turnEnded = true;
      move.gameState = gs;
    } else {
      const hitChance = Math.min(0.95, Math.max(0.2, difficulty + 0.05));
      const hit = rand() < hitChance;
      const parsed = { isMiss: !hit, base: 0, multiplier: 1, segment: 'MISS', value: 0 };
      if (hit) {
        const roll = rand();
        parsed.base = typeof target === 'number' ? target : 20;
        if (roll < 0.15) {
          parsed.multiplier = 3;
          parsed.segment = 'T';
          parsed.value = parsed.base * 3;
        } else if (roll < 0.45) {
          parsed.multiplier = 2;
          parsed.segment = 'D';
          parsed.value = parsed.base * 2;
        } else if (roll < 0.72) {
          parsed.multiplier = 1;
          parsed.segment = 'SO';
          parsed.singleRing = 'outer';
          parsed.value = parsed.base;
        } else {
          parsed.multiplier = 1;
          parsed.segment = 'SI';
          parsed.singleRing = 'inner';
          parsed.value = parsed.base;
        }
      }
      parsed.golfPts = golfDartPoints(parsed, target);
      darts.push(parsed);
      move.displayScore = parsed.isMiss ? 'MISS' : `${parsed.segment}${parsed.base}`;
      move.note = `Dart ${darts.length}/3: ${move.displayScore} (${parsed.golfPts})`;
      gs.playerDarts[1] = darts;
      if (darts.length >= 3) {
        const { holeScore, hatTrick } = finalizeGolfHole(darts, target);
        move.delta = holeScore;
        move.absoluteScore = (room.scores[1] || 0) + holeScore;
        move.displayScore = `Hole ${holeIdx + 1}: ${holeScore}`;
        move.note = `Hole ${holeIdx + 1} complete · best ${holeScore}${hatTrick ? ' · Hat trick −1!' : ''}`;
        gs.playerHoleScores[1].push({
          hole: holeIdx + 1,
          target,
          darts: darts.map(d => d.isMiss ? 'MISS' : `${d.segment}${d.base}`),
          dartScores: darts.map(d => d.golfPts),
          score: holeScore,
          bonus: hatTrick
        });
        gs.playerDarts[1] = [];
        gs.playerHoles[1] = holeIdx + 1;
        gs.turnEnded = true;
        move.keepTurn = false;
      } else {
        gs.turnEnded = false;
        move.keepTurn = true;
      }
      move.gameState = gs;
    }
  } else if (game === 'Golf Checkouts') {
    if (!gs.holes?.length) Object.assign(gs, initGolfCheckoutsState(room.config));
    gs.playerProgress = gs.playerProgress || [
      { hole: 0, remaining: gs.holes?.[0]?.target || 0, currentHoleDarts: 0, totalDarts: 0, holeResults: [], finished: false, holeDone: false },
      { hole: 0, remaining: gs.holes?.[0]?.target || 0, currentHoleDarts: 0, totalDarts: 0, holeResults: [], finished: false, holeDone: false }
    ];
    const playerIdx = 1;
    const progress = gs.playerProgress[playerIdx];
    if (!gcPlayerCanThrow(gs, playerIdx)) {
      move.note = progress?.finished ? 'BOT finished' : 'BOT waiting for opponent';
      move.keepTurn = false;
      gs.turnEnded = true;
      move.gameState = gs;
    } else {
      const rem = progress.remaining || 0;
      const avg = { easy: 38, medium: 58, hard: 84, adaptive: 70 }[skill] || 45;
      const coAttempt = { easy: 0.18, medium: 0.34, hard: 0.6, adaptive: 0.45 }[skill] || 0.2;
      let total;
      let visitDarts = GC_DARTS_PER_TURN;
      if (rem > 0 && rem <= 180 && rand() < coAttempt) {
        total = rem;
        if (rem < 170) {
          const minD = gcMinDartsForScore(rem);
          if (minD === 1 || minD === 2) visitDarts = minD;
        }
      } else {
        total = Math.round(avg + (rand() * 50 - 25));
        total = Math.max(0, Math.min(180, total));
        if (total > rem) {
          const setup = [40, 32, 36, 24, 16, 8].find(s => rem - s >= 0);
          total = setup != null ? rem - setup : Math.max(0, Math.min(rem, Math.round(avg)));
        }
      }
      const result = gcApplyTurnTotal(gs, playerIdx, total, visitDarts);
      move.delta = result.delta || 0;
      move.displayScore = total === 0 ? '0' : String(total);
      move.note = result.blocked ? result.note : `BOT ${move.displayScore} · ${result.note}`;
      move.keepTurn = result.keepTurn;
      gs.turnEnded = result.turnEnded;
      move.gameState = gs;
    }
  } else if (game === 'Around the Clock') {
    const needed = gs.progress?.[1] || 1;
    if (rand() < difficulty) {
      move.displayScore = `S${needed}`;
      move.delta = needed;
      gs.progress = gs.progress || [1,1];
      gs.progress[1] = needed + 1;
      move.note = `BOT hit ${needed}`;
      if (gs.progress[1] > 20) {
        move.gameOver = true;
        move.winner = room.config.guestName;
      }
    } else {
      move.displayScore = 'MISS';
      move.note = 'BOT MISS';
      gs.progress = gs.progress || [1,1];
    }
    move.absoluteScore = (gs.progress[1] || 1) - 1;
    move.gameState = gs;
  } else if (game === 'Killer') {
    gs.isKiller = gs.isKiller || [false,false];
    gs.hitCount = gs.hitCount || [0,0];
    gs.lives = gs.lives || [5,5];
    if (!gs.isKiller[1]) {
      if (rand() < difficulty) {
        gs.hitCount[1] = Math.min(3, gs.hitCount[1] + 1);
        move.note = `BOT hit ${gs.numbers?.[1] || '?'} (${gs.hitCount[1]}/3)`;
        if (gs.hitCount[1] >= 3) {
          gs.isKiller[1] = true;
          move.note = '⚡ BOT KILLER!';
        }
      } else {
        move.note = 'BOT MISS';
      }
    } else {
      if (rand() < difficulty) {
        gs.lives[0] = Math.max(0, gs.lives[0] - 1);
        move.note = `BOT hit your number ${gs.numbers?.[0] || '?'} -1 life`;
        if (gs.lives[0] <= 0) {
          move.gameOver = true;
          move.winner = room.config.guestName;
        }
      } else {
        move.note = 'BOT MISS';
      }
    }
    move.displayScore = move.note;
    move.gameState = gs;
  } else if (game === 'Shanghai') {
    gs.roundProgress = gs.roundProgress || [
      { round: 0, throws: 0, hits: { S:0,D:0,T:0 }, total: 0 },
      { round: 0, throws: 0, hits: { S:0,D:0,T:0 }, total: 0 }
    ];
    const progress = gs.roundProgress[1];
    const target = (gs.roundIdx || 0) + 1;
    const hitTarget = rand() < difficulty;
    if (hitTarget) {
      const mult = rand() < 0.25 ? 3 : rand() < 0.6 ? 2 : 1;
      progress.hits[mult === 3 ? 'T' : mult === 2 ? 'D' : 'S']++;
      progress.total += target * mult;
      move.displayScore = `${mult === 1 ? 'S' : mult === 2 ? 'D' : 'T'}${target}`;
      move.note = `BOT hit ${move.displayScore}`;
    } else {
      move.displayScore = 'MISS';
      move.note = 'BOT MISS';
    }
    progress.throws++;
    move.keepTurn = true;
    if (progress.throws >= 3) {
      if (progress.hits.S && progress.hits.D && progress.hits.T) {
        move.gameOver = true;
        move.winner = room.config.guestName;
        move.note = 'BOT SHANGHAI!';
      }
      gs.roundScores = gs.roundScores || [[],[]];
      gs.roundScores[1].push(progress.total);
      move.delta = progress.total;
      move.absoluteScore = room.scores[1] + progress.total;
      progress.round++;
      progress.throws = 0;
      progress.hits = { S:0, D:0, T:0 };
      progress.total = 0;
      gs.roundIdx = progress.round;
      gs.turnEnded = true;
      move.keepTurn = false;
      if (gs.roundIdx >= 7) move.gameOver = true;
    } else {
      gs.turnEnded = false;
    }
    move.gameState = gs;
  } else if (game === 'High Score') {
    const score = Math.max(0, Math.min(180, Math.round((rand() * 140 + 20) * (skill === 'easy' ? 0.75 : skill === 'medium' ? 0.9 : 1))));
    move.delta = score;
    move.displayScore = score;
    move.note = `BOT scored ${score}`;
    gs.roundScores = gs.roundScores || [[],[]];
    gs.roundScores[1].push(score);
    gs.roundIdx = (gs.roundIdx || 0) + 1;
    if (gs.roundIdx >= 10) {
      move.gameOver = true;
      move.winner = (room.scores[1] + score) >= room.scores[0] ? room.config.guestName : room.config.hostName;
    }
    move.gameState = gs;
  }

  move.highScore = Math.max(room.scores[1], room.scores[0]);
  move.matchStats = { scores: room.scores, time: Math.floor((Date.now() - room.createdAt) / 1000), bestRound: 0 };
  return move;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function send(wsId, msg) {
  const client = clients.get(wsId);
  if (client?.ws?.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

// Send an already-stringified payload to a single socket (no re-stringify).
function sendRaw(wsId, str) {
  const client = clients.get(wsId);
  if (client?.ws?.readyState === WebSocket.OPEN) {
    client.ws.send(str);
  }
}

function broadcastAll(msg) {
  const str = JSON.stringify(msg);
  clients.forEach((_, wsId) => sendRaw(wsId, str));
}

// Broadcast one payload to host + guest + spectators, stringifying ONCE.
function broadcastToRoom(room, msg) {
  if (!room) return;
  const str = JSON.stringify(msg);
  sendRaw(room.hostWsId, str);
  if (room.guestWsId) sendRaw(room.guestWsId, str);
  spectators.get(room.id)?.forEach(sid => sendRaw(sid, str));
}

function broadcastLobbyUpdate() {
  const openRooms = [...rooms.values()]
    .filter(r => (r.status === 'waiting' || r.status === 'active') && !r.config.bot)
    .map(r => ({
      id: r.id, game: r.config.game, hostName: r.config.hostName,
      status: r.status, createdAt: r.createdAt,
      spectators: spectators.get(r.id)?.size || 0
    }));
  broadcastAll({ type: 'lobby_update', rooms: openRooms });
}

function shouldSwitchTurn(game, gameState) {
  if (!gameState) return true;
  if (isX01Game(game)) return true; // each X01 submit is a full visit
  if (isCricketGame(game)) return true; // each cricket submit is a full visit
  if (['Golf Darts','Golf Checkouts','Football Darts','Halve-It','Shanghai'].includes(game)) {
    return !!gameState.turnEnded;
  }
  return true;
}

function computeGolfGameOver(room) {
  const game = room.config.game;
  const gs = room.gameState;
  if (game === 'Golf Darts') {
    const p0done = (gs.playerHoles?.[0] || 0) >= (gs.holes?.length || 18);
    const p1done = (gs.playerHoles?.[1] || 0) >= (gs.holes?.length || 18);
    if (p0done && p1done) {
      if (room.scores[0] === room.scores[1]) return { gameOver: true, winner: null };
      return { gameOver: true, winner: room.scores[0] < room.scores[1] ? room.config.hostName : room.config.guestName };
    }
  }
  if (game === 'Golf Checkouts') {
    const p0done = !!gs.playerProgress?.[0]?.finished;
    const p1done = !!gs.playerProgress?.[1]?.finished;
    if (p0done && p1done) {
      if (room.scores[0] === room.scores[1]) return { gameOver: true, winner: null };
      return { gameOver: true, winner: room.scores[0] < room.scores[1] ? room.config.hostName : room.config.guestName };
    }
  }
  return { gameOver: false, winner: null };
}

function updateStats(winnerName, loserName, highScore) {
  if (db.users[winnerName]) {
    db.users[winnerName].stats.wins++;
    db.users[winnerName].stats.gamesPlayed++;
    if (highScore > db.users[winnerName].stats.highScore) db.users[winnerName].stats.highScore = highScore;
  }
  if (db.users[loserName]) {
    db.users[loserName].stats.losses++;
    db.users[loserName].stats.gamesPlayed++;
  }
  saveData(db);
}

function isTournamentUnplayed(t) {
  if (t.status === 'registration') return true;
  if (t.status !== 'active') return false;
  if (!t.bracket?.length) return true;
  return t.bracket.every(round => round.every(m => !m.winner));
}

function golfDartPoints(dart, target) {
  if (!dart || dart.isMiss || dart.base !== target) return 7;
  if (dart.multiplier === 3 || dart.segment === 'T') return 1;
  if (dart.multiplier === 2 || dart.segment === 'D') return 2;
  if (dart.singleRing === 'inner' || dart.segment === 'SI') return 3;
  return 4;
}

function finalizeGolfHole(darts, target) {
  const scores = darts.map(d => d.golfPts ?? golfDartPoints(d, target));
  const best = Math.min(...scores);
  const hatTrick = darts.length === 3
    && darts.every(d => !d.isMiss && d.base === target)
    && darts[0].segment === darts[1].segment
    && darts[1].segment === darts[2].segment;
  return { scores, best, holeScore: Math.max(0, best - (hatTrick ? 1 : 0)), hatTrick };
}

const TOURNAMENT_TEST_BOTS = ['Bot (Easy)', 'Bot (Medium)', 'Bot (Hard)', 'Bot (Adaptive)'];

function ensureTournamentPlayers(t) {
  if (!Array.isArray(t.players)) t.players = [];
}

function addTestBotsToTournament(t) {
  ensureTournamentPlayers(t);
  let added = 0;
  for (const bot of TOURNAMENT_TEST_BOTS) {
    if (t.players.length >= t.maxPlayers) break;
    if (!t.players.includes(bot)) {
      t.players.push(bot);
      added++;
    }
  }
  return added;
}

function isBotPlayer(name) {
  return typeof name === 'string' && /^bot\s*\(/i.test(name);
}

function botSkillFromName(name) {
  const m = (name || '').match(/\((easy|medium|hard|adaptive)\)/i);
  return m ? m[1].toLowerCase() : 'easy';
}

function findBracketMatch(t, matchId) {
  if (!t?.bracket) return null;
  for (const round of t.bracket) {
    const m = round.find(x => x.id === matchId);
    if (m) return m;
  }
  return null;
}

function advanceWinnersToNextRound(t) {
  if (!t.bracket?.length) return;
  for (let r = 0; r < t.bracket.length - 1; r++) {
    const round = t.bracket[r];
    const next = t.bracket[r + 1];
    round.forEach((m, i) => {
      if (!m.winner) return;
      const nextMatch = next[Math.floor(i / 2)];
      if (!nextMatch) return;
      if (i % 2 === 0) nextMatch.p1 = m.winner;
      else nextMatch.p2 = m.winner;
    });
  }
}

function applyByeWins(t) {
  const round1 = t.bracket?.[0];
  if (!round1) return;
  round1.forEach(m => {
    if (m.winner) return;
    if (m.p2 === 'BYE' && m.p1 && m.p1 !== 'BYE') m.winner = m.p1;
    else if (m.p1 === 'BYE' && m.p2 && m.p2 !== 'BYE') m.winner = m.p2;
  });
}

function autoResolveBotOnlyMatches(t) {
  let changed = false;
  for (const round of t.bracket || []) {
    for (const m of round) {
      if (m.winner || !m.p1 || !m.p2 || m.p1 === 'BYE' || m.p2 === 'BYE') continue;
      if (isBotPlayer(m.p1) && isBotPlayer(m.p2)) {
        m.winner = Math.random() < 0.5 ? m.p1 : m.p2;
        changed = true;
      }
    }
  }
  if (changed) {
    advanceWinnersToNextRound(t);
    autoResolveBotOnlyMatches(t);
  }
}

function finalizeBracketStart(t) {
  applyByeWins(t);
  advanceWinnersToNextRound(t);
  autoResolveBotOnlyMatches(t);
}

function tournamentChampion(t) {
  const finalRound = t.bracket?.[t.bracket.length - 1];
  return finalRound?.[0]?.winner || null;
}

function recordTournamentMatchResult(tournamentId, matchId, winner) {
  const t = db.tournaments.find(x => x.id === tournamentId);
  if (!t || !matchId || !winner) return;
  const match = findBracketMatch(t, matchId);
  if (!match || match.winner) return;
  match.winner = winner;
  advanceWinnersToNextRound(t);
  autoResolveBotOnlyMatches(t);
  const champ = tournamentChampion(t);
  if (champ) {
    t.status = 'completed';
    if (db.users[champ]) {
      db.users[champ].stats.tournamentsWon = (db.users[champ].stats.tournamentsWon || 0) + 1;
    }
  }
  saveData(db);
  broadcastAll({ type: 'tournament_updated', tournament: sanitizeTournament(t) });
}

function buildGameOverMessage(room, winner, stats) {
  const t = room.config.tournamentId
    ? db.tournaments.find(x => x.id === room.config.tournamentId)
    : null;
  return {
    type: 'game_over',
    roomId: room.id,
    winner,
    scores: room.scores,
    stats,
    tournamentId: room.config.tournamentId || null,
    bracketMatchId: room.config.bracketMatchId || null,
    tournamentName: t?.name || null
  };
}

function generateBracket(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  let size = 2;
  while (size < shuffled.length) size *= 2;
  const slots = [...shuffled];
  while (slots.length < size) slots.push('BYE');

  const rounds = [];
  let matchCount = size / 2;
  for (let r = 0; matchCount >= 1; matchCount = Math.floor(matchCount / 2), r++) {
    const round = [];
    for (let i = 0; i < matchCount; i++) {
      if (r === 0) {
        round.push({
          p1: slots[i * 2],
          p2: slots[i * 2 + 1],
          winner: null,
          id: uuidv4(),
          roomId: null
        });
      } else {
        round.push({ p1: null, p2: null, winner: null, id: uuidv4(), roomId: null });
      }
    }
    rounds.push(round);
  }
  return rounds;
}

function sanitizeTournament(t) {
  return { id: t.id, name: t.name, game: t.game, format: t.format,
    maxPlayers: t.maxPlayers, players: t.players, bracket: t.bracket,
    status: t.status, createdBy: t.createdBy, createdAt: t.createdAt, startDate: t.startDate,
    waitForHostJoin: !!t.waitForHostJoin,
    variation: t.variation || null, startRule: t.startRule || null,
    finishRule: t.finishRule || null, x01Base: t.x01Base || null };
}

// ─────────────────────────────────────────────
//  WDL STANDINGS PROXY (worlddartsleague.com)
// ─────────────────────────────────────────────
const WDL_BASE = 'https://worlddartsleague.com';
const WDL_CACHE_MS = 5 * 60 * 1000;
let wdlStandingsCache = { data: null, fetchedAt: 0 };
let wdlInFlight = null; // shared promise so concurrent cold-cache callers refresh ONCE

function formatWdlPlayerName(name) {
  if (!name) return 'Unknown';
  return name.includes('@') ? name.split('@')[0] : name;
}

async function fetchWdlJson(urlPath) {
  const res = await fetch(WDL_BASE + urlPath, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`WDL ${urlPath} returned ${res.status}`);
  return res.json();
}

// Run async tasks with a small concurrency cap so we don't open hundreds of
// sockets to the upstream API at once while still parallelizing the work.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildWdlStandings() {
  const regionalsRes = await fetchWdlJson('/api/regionals');
  const regionals = regionalsRes.regionals || [];

  // 1) Fetch every regional's league list in parallel.
  const perRegional = await mapWithConcurrency(regionals, 5, async (reg) => {
    const leaguesRes = await fetchWdlJson(`/api/regionals/${reg.id}/leagues`);
    return (leaguesRes.leagues || []).map(league => ({ reg, league }));
  });
  const flatLeagues = perRegional.flat();

  // 2) Fetch every league's standings in parallel.
  const built = await mapWithConcurrency(flatLeagues, 6, async ({ reg, league }) => {
    const standingsRes = await fetchWdlJson(`/api/leagues/${league.id}/standings`);
    const top3 = (standingsRes.standings || []).slice(0, 3);
    if (!top3.length) return null;
    return {
      regional: reg.name,
      regionalFlag: reg.flag || '',
      league: league.name,
      tier: league.tier,
      top3: top3.map(p => ({
        pos: p.pos,
        name: formatWdlPlayerName(p.playerName),
        points: p.points,
        played: p.played,
        won: p.won,
      })),
    };
  });

  const leagues = built.filter(Boolean);
  leagues.sort((a, b) => (a.tier - b.tier) || a.league.localeCompare(b.league));

  const payload = { ok: true, leagues, updatedAt: Date.now() };
  wdlStandingsCache = { data: payload, fetchedAt: Date.now() };
  return payload;
}

async function fetchWdlStandings() {
  if (wdlStandingsCache.data && Date.now() - wdlStandingsCache.fetchedAt < WDL_CACHE_MS) {
    return wdlStandingsCache.data;
  }
  // Single-flight: concurrent cold-cache callers share one in-flight refresh.
  if (wdlInFlight) return wdlInFlight;
  wdlInFlight = buildWdlStandings().finally(() => { wdlInFlight = null; });
  return wdlInFlight;
}

// Pre-warm slightly under the cache TTL so the ticker stays warm and visitors
// rarely pay the cold-fetch latency. Best-effort; failures are swallowed.
setInterval(() => {
  fetchWdlStandings().catch(() => {});
}, WDL_CACHE_MS - 30 * 1000);

// ─────────────────────────────────────────────
//  LAZY-LEAGUES STANDINGS PROXY (lazy-leagues.web.app)
// ─────────────────────────────────────────────
// Lazy Leagues is a Firebase (Firestore) web app. Division tables are computed
// client-side from the `users` collection. Current score fields:
//   league (0-11), firstName, lastName, totalPoints, averagePPG, gamesPlayed,
//   rollingAverage, ppgHistory[] (legacy fallback).
// Division names below mirror the site's leagueNames array. Firestore rules
// require an authenticated session, so the proxy signs in via the Firebase
// Auth REST API (email/password) to obtain an ID token. Credentials come from
// env vars LAZY_LEAGUES_EMAIL / LAZY_LEAGUES_PASSWORD, else from a local
// (gitignored) lazy-credentials.json; LAZY_LEAGUES_TOKEN overrides sign-in.
const LAZY_PROJECT = 'lazy-leagues';
const LAZY_API_KEY = 'AIzaSyCPn78FhyBpelCjwlD7yf3g8Y8D5mwuxfM';
const LAZY_FS_BASE = `https://firestore.googleapis.com/v1/projects/${LAZY_PROJECT}/databases/(default)/documents`;
const LAZY_CACHE_MS = 5 * 60 * 1000;
const LAZY_DIVISIONS = [
  'Premier League', 'Champs League', 'The Bridge',
  'Gold One', 'Gold Two', 'Gold Three',
  'Silver One', 'Silver Two', 'Silver Three',
  'Bronze One', 'Bronze Two', 'Pending League',
];
let lazyStandingsCache = { data: null, fetchedAt: 0 };
let lazyInFlight = null;
let lazyAuth = { idToken: '', refreshToken: '', expiresAt: 0 };

function loadLazyCredentials() {
  let email = process.env.LAZY_LEAGUES_EMAIL || '';
  let password = process.env.LAZY_LEAGUES_PASSWORD || '';
  if (!email || !password) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'lazy-credentials.json'), 'utf8'));
      email = email || cfg.email || '';
      password = password || cfg.password || '';
    } catch { /* no local credentials file — fall through */ }
  }
  return { email, password };
}

async function lazySignIn() {
  const { email, password } = loadLazyCredentials();
  if (!email || !password) throw new Error('no Lazy-Leagues credentials configured');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${LAZY_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Lazy sign-in failed: ${json.error?.message || res.status}`);
  lazyAuth = {
    idToken: json.idToken,
    refreshToken: json.refreshToken,
    expiresAt: Date.now() + (Number(json.expiresIn || 3600) - 60) * 1000,
  };
  return lazyAuth.idToken;
}

async function lazyRefreshToken() {
  if (!lazyAuth.refreshToken) return lazySignIn();
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${LAZY_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(lazyAuth.refreshToken)}`,
  });
  const json = await res.json();
  if (!res.ok) return lazySignIn();
  lazyAuth = {
    idToken: json.id_token,
    refreshToken: json.refresh_token || lazyAuth.refreshToken,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) - 60) * 1000,
  };
  return lazyAuth.idToken;
}

async function getLazyToken() {
  if (process.env.LAZY_LEAGUES_TOKEN) return process.env.LAZY_LEAGUES_TOKEN;
  if (lazyAuth.idToken && Date.now() < lazyAuth.expiresAt) return lazyAuth.idToken;
  if (lazyAuth.refreshToken) return lazyRefreshToken();
  return lazySignIn();
}

function lazyFieldNumber(f) {
  if (!f) return 0;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  return 0;
}

function lazyParseUser(fields) {
  const f = fields || {};
  const first = f.firstName?.stringValue || '';
  const last = f.lastName?.stringValue || '';
  const name = `${first} ${last}`.trim() || (f.displayName?.stringValue || 'Unknown');
  const league = f.league?.integerValue !== undefined ? Number(f.league.integerValue)
    : (f.league?.doubleValue !== undefined ? Number(f.league.doubleValue) : null);

  // Prefer current aggregate fields; fall back to legacy ppgHistory[].
  const hist = f.ppgHistory?.arrayValue?.values || [];
  const histPoints = hist.reduce((a, v) => a + lazyFieldNumber(v), 0);
  const histMatches = hist.length;
  const histAvg = histMatches ? +(histPoints / histMatches).toFixed(1) : 0;

  const gamesPlayed = lazyFieldNumber(f.gamesPlayed) || histMatches;
  const totalPoints = lazyFieldNumber(f.totalPoints) || histPoints;
  let averagePPG = lazyFieldNumber(f.averagePPG);
  if (!averagePPG && histAvg) averagePPG = histAvg;
  if (!averagePPG && gamesPlayed > 0 && totalPoints > 0) {
    averagePPG = +(totalPoints / gamesPlayed).toFixed(1);
  }
  const rollingAverage = lazyFieldNumber(f.rollingAverage);

  return {
    name,
    league,
    matches: gamesPlayed,
    points: totalPoints,
    avg: averagePPG || rollingAverage || 0,
    rollingAverage,
    isMember: f.isMember?.booleanValue === true,
  };
}

async function fetchLazyUsers(token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const users = [];
  let pageToken = '';
  do {
    const url = `${LAZY_FS_BASE}/users?key=${LAZY_API_KEY}&pageSize=300`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Lazy users auth ${res.status}`);
      err.authError = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Lazy users returned ${res.status}`);
    const json = await res.json();
    for (const doc of json.documents || []) users.push(lazyParseUser(doc.fields));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return users;
}

async function buildLazyStandings() {
  let users;
  try {
    users = await fetchLazyUsers(await getLazyToken());
  } catch (err) {
    if (!err.authError) throw err;
    // Force a fresh sign-in once if the cached token was rejected.
    lazyAuth = { idToken: '', refreshToken: '', expiresAt: 0 };
    users = await fetchLazyUsers(await lazySignIn());
  }

  const divisions = [];
  LAZY_DIVISIONS.forEach((division, leagueIndex) => {
    // Pending League (11) is a queue, not a ranked table — skip on the ticker.
    if (leagueIndex === 11) return;
    const top2 = users
      .filter(u => u.league === leagueIndex && u.matches > 0 && (u.avg > 0 || u.points > 0))
      .sort((a, b) => (b.avg - a.avg) || (b.points - a.points) || a.name.localeCompare(b.name))
      .slice(0, 2)
      .map((u, i) => ({
        pos: i + 1,
        name: u.name,
        points: u.points,
        avg: u.avg,
        matches: u.matches,
      }));
    if (top2.length) divisions.push({ division, leagueIndex, top2 });
  });

  const payload = { ok: true, divisions, updatedAt: Date.now() };
  lazyStandingsCache = { data: payload, fetchedAt: Date.now() };
  return payload;
}

async function fetchLazyStandings() {
  if (lazyStandingsCache.data && Date.now() - lazyStandingsCache.fetchedAt < LAZY_CACHE_MS) {
    return lazyStandingsCache.data;
  }
  if (lazyInFlight) return lazyInFlight;
  lazyInFlight = buildLazyStandings().finally(() => { lazyInFlight = null; });
  return lazyInFlight;
}

// Keep Lazy cache warm the same way as WDL (best-effort).
setInterval(() => {
  fetchLazyStandings().catch(() => {});
}, LAZY_CACHE_MS - 30 * 1000);

// ─────────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────────
// Security headers. CSP is tuned for the externalized build: app.js/app.css are
// loaded from 'self'; the many inline on*="" handlers are permitted via
// script-src-attr (NOT script-src, so injected <script> blocks stay blocked);
// inline style="" attributes + Google Fonts are allowed; XHR/WebSocket are
// same-origin. upgrade-insecure-requests is left off so http:// localhost dev
// and same-origin ws:// keep working — terminate TLS at your proxy in prod.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrcElem: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false, // allow normal cross-origin font loads
}));

// gzip responses (HTML/CSS/JS/JSON) before they hit the wire.
app.use(compression());

// Health check for uptime monitors / load balancers. Cheap + never cached.
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    clients: clients.size,
    rooms: rooms.size,
    env: NODE_ENV,
    softLaunch: SOFT_LAUNCH,
    arenaMode: ensureArenaSettings().mode,
    ts: Date.now(),
  });
});

// Per-IP rate limit on the upstream-proxy API routes. Static assets are
// immutable-cached and the SPA fallback is cheap, so neither is limited here;
// auth/WS abuse is throttled at the socket layer (MAX_WS_PER_IP, AUTH_MAX_ATTEMPTS).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_MAX, 10) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests — please slow down.' },
});
app.use('/api/', apiLimiter);

app.get('/api/wdl-standings', async (req, res) => {
  try {
    res.json(await fetchWdlStandings());
  } catch (err) {
    log('error', 'WDL standings fetch failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not load WDL standings right now.' });
  }
});

app.get('/api/lazy-standings', async (req, res) => {
  try {
    res.json(await fetchLazyStandings());
  } catch (err) {
    log('error', 'Lazy-Leagues standings fetch failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not load Lazy-Leagues standings right now.' });
  }
});

// Cache index.html in memory so the SPA fallback never touches disk per request.
let indexHtmlCache = '';
function loadIndexHtml() {
  try {
    indexHtmlCache = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch (err) {
    indexHtmlCache = '';
    console.error('\n[!] public/index.html not found. Run `npm run build` to generate the public/ bundle.\n');
  }
}
loadIndexHtml();

// Static assets: long-lived immutable cache (filenames are stable; bump via
// build/query string if an asset changes). index.html is handled separately
// below with no-cache so clients always pick up new asset references.
app.use(express.static(PUBLIC_DIR, {
  maxAge: '30d',
  immutable: true,
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback — serve the in-memory index.html (short/no-store) for any route.
app.get('*', (req, res) => {
  if (!indexHtmlCache) loadIndexHtml();
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(indexHtmlCache || '<!doctype html><title>Treble-Makers</title><h1>Run <code>npm run build</code> to generate public/index.html</h1>');
});

server.listen(PORT, HOST, () => {
  // Periodic DB backups (also runs once on shutdown via gracefulExit).
  backupData();
  backupTimer = setInterval(backupData, BACKUP_INTERVAL_MS);
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   TREBLE-MAKERS FUNHOUSE — WDL         ║');
  console.log(`║   Running at http://localhost:${PORT}      ║`);
  console.log('║                                        ║');
  if (SOFT_LAUNCH) {
    console.log('║   Mode: SOFT LAUNCH (invite-only)      ║');
  }
  console.log(`║   Admin username: ${ADMIN_USERNAME.padEnd(22)}║`);
  console.log('║   Set ADMIN_PASSWORD in .env           ║');
  console.log('║   Change password after first login    ║');
  console.log('╚════════════════════════════════════════╝');
  log('info', `Server listening on ${HOST}:${PORT} (env=${NODE_ENV}, softLaunch=${SOFT_LAUNCH}, backups every ${Math.round(BACKUP_INTERVAL_MS / 60000)}m)`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`The site may already be running — open http://localhost:${PORT}`);
    console.error('To restart, close the other terminal running the server, then run npm start again.\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
