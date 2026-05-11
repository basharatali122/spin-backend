// // PM2 Ecosystem Config — Spin Claimer Backend
// // Run with: pm2 start ecosystem.config.js
// //
// // WHY THIS WORKS:
// //   Your KVM2 has 2 vCPUs. Without PM2, node uses only 1 CPU = 50% waste.
// //   PM2 "cluster" mode forks 2 processes (one per CPU), but Socket.IO
// //   requires sticky sessions so all sockets from one user hit the same process.
// //   We use the "@socket.io/sticky" approach via a single process with UV_THREADPOOL_SIZE.
// //
// // IMPORTANT: We use fork mode (instances: 1) NOT cluster mode because:
// //   - sql.js databases are per-process in-memory — cluster would split user data
// //   - Socket.IO rooms are in-memory — cluster needs Redis adapter (complex)
// //   - The bottleneck is the event loop / WebSocket connections, not CPU math
// //   - We compensate with UV_THREADPOOL_SIZE and max-old-space for the JS heap

// module.exports = {
//   apps: [
//     {
//       name: 'spin-claimer',
//       script: 'server.js',
//       instances: 1,             // Single process — avoids split-state problems
//       exec_mode: 'fork',
      
//       env: {
//         NODE_ENV: 'production',
//         PORT: 3001,
//         // Give Node.js more heap memory (KVM2 has 4GB, keep OS headroom)
//         NODE_OPTIONS: '--max-old-space-size=2048',
//         // More libuv threads for file I/O (sql.js exports to disk)
//         UV_THREADPOOL_SIZE: 16,
//       },

//       // Auto-restart on crash
//       autorestart: true,
//       watch: false,
//       max_memory_restart: '2500M',

//       // Log settings
//       log_date_format: 'YYYY-MM-DD HH:mm:ss',
//       error_file: './logs/err.log',
//       out_file: './logs/out.log',
//       merge_logs: true,
//     },
//   ],
// };





module.exports = {
  apps: [
    {
      name: 'spin-claimer',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        // 6GB heap — your server has 8GB, leave 2GB for OS + proxies
        NODE_OPTIONS: '--max-old-space-size=6144',
        // 64 libuv threads: handles sql.js WASM + 300 concurrent WS workers
        UV_THREADPOOL_SIZE: 64,
      },

      autorestart: true,
      watch: false,
      max_memory_restart: '7000M',

      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/err.log',
      out_file:   './logs/out.log',
      merge_logs: true,
    },
  ],
};
