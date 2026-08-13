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

      // Graceful shutdown — wait up to 10s for in-flight requests
      kill_timeout: 10000,
      listen_timeout: 5000,
      shutdown_with_message: true,

      // Environment
      env: {
        NODE_ENV: 'development',
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
