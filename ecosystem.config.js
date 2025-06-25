module.exports = {
  apps: [{
    name: 'whalehub-server',
    script: 'dist/main.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    node_args: [
      '--max-old-space-size=4096',
      '--optimize-for-size',
      '--gc-interval=100'
    ],
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: 16
    },
    env_development: {
      NODE_ENV: 'development',
      UV_THREADPOOL_SIZE: 8
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
}; 