module.exports = {
  apps: [
    {
      name: 'solatide-api',
      script: 'dist/server.js',

      // Cluster mode — uses all available CPU cores
      instances: 'max',
      exec_mode: 'cluster',

      // Auto-restart if memory exceeds 512MB
      max_memory_restart: '512M',

      // Restart policy
      watch: false,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '5s',

      // Graceful shutdown — PM2 sends SIGINT, then SIGKILL after kill_timeout.
      // server.ts force-exits itself after 12s, so it always finishes before PM2's 15s kill.
      // (server.ts also handles a 'shutdown' message, but we rely on signals: no shutdown_with_message.)
      kill_timeout: 15000,
      listen_timeout: 5000,

      // Environment
      // IMPORTANT: `pm2 start ecosystem.config.js` WITHOUT `--env production` uses `env`,
      // not `env_production`. The live API was running with NODE_ENV=development because of
      // this (dev error handler leaks stack traces). Both blocks are production-safe now;
      // for local development run `npm run dev` instead of PM2.
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // Logging
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
