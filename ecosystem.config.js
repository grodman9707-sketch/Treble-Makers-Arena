/**
 * PM2 process manager config.
 *
 * Soft launch:
 *   cp .env.example .env   # SOFT_LAUNCH=1, TRUST_PROXY=1, ADMIN_PASSWORD=...
 *   npm install && npm run build
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save && pm2 startup
 *
 * Note: PM2 does not load .env automatically. Export vars in the shell,
 * use a dotenv wrapper, or set them in this file / your host dashboard.
 * The app itself loads .env via dotenv when present.
 */
module.exports = {
  apps: [{
    name: 'treble-makers',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'development',
    },
    env_production: {
      NODE_ENV: 'production',
      SOFT_LAUNCH: '1',
      TRUST_PROXY: '1',
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    time: true,
  }],
};
