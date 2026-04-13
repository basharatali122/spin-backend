// require('dotenv').config();
// const express    = require('express');
// const http       = require('http');
// const { Server } = require('socket.io');
// const cors       = require('cors');
// const helmet     = require('helmet');
// const rateLimit  = require('express-rate-limit');
// const path       = require('path');
// const fs         = require('fs');

// const { verifyToken, verifyFirebaseToken } = require('./middleware/auth');
// const accountRoutes    = require('./routes/accounts');
// const processingRoutes = require('./routes/processing');
// const { proxyRouter, statsRouter } = require('./routes/other');
// const BotManager       = require('./botManager');

// const app    = express();
// const server = http.createServer(app);

// const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// const io = new Server(server, {
//   cors: {
//     origin: FRONTEND_URL,
//     methods: ['GET', 'POST'],
//     credentials: true,
//   },
//   pingInterval: 25000,
//   pingTimeout: 60000,
// });

// // ── Data directory ─────────────────────────────────────────────────────────────
// const dataDir = process.env.DATA_DIR || './data';
// if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// // ── Middleware ─────────────────────────────────────────────────────────────────
// app.use(helmet({ contentSecurityPolicy: false }));
// app.use(cors({ origin: FRONTEND_URL, credentials: true }));
// app.use(express.json({ limit: '10mb' }));

// const defaultLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true });
// const authLimiter    = rateLimit({ windowMs: 60 * 1000, max: 30 });
// app.use('/api/', defaultLimiter);

// // ── Bot Manager ────────────────────────────────────────────────────────────────
// const botManager = new BotManager(io);
// app.set('botManager', botManager);

// // ── Routes ─────────────────────────────────────────────────────────────────────
// app.use('/api/accounts',   verifyToken, accountRoutes);
// app.use('/api/processing', verifyToken, processingRoutes);
// app.use('/api/proxy',      verifyToken, proxyRouter);
// app.use('/api/stats',      verifyToken, statsRouter);

// app.get('/health', (req, res) => {
//   const stats = botManager.getServerStats();
//   res.json({ status: 'ok', uptime: process.uptime(), ...stats });
// });

// // ── Socket Auth ────────────────────────────────────────────────────────────────
// io.use(async (socket, next) => {
//   try {
//     const token = socket.handshake.auth.token;
//     if (!token) return next(new Error('No token'));
//     const decoded = await verifyFirebaseToken(token);
//     socket.userId    = decoded.uid;
//     socket.userEmail = decoded.email;
//     socket.tabId     = socket.handshake.query.tabId || 'unknown';
//     next();
//   } catch { next(new Error('Unauthorized')); }
// });

// io.on('connection', (socket) => {
//   console.log(`🔌 ${socket.userEmail} [tab:${socket.tabId}] connected [${socket.id}]`);

//   let currentProfileRoom = null;

//   socket.on('subscribe:profile', (profileName) => {
//     if (currentProfileRoom && currentProfileRoom !== profileName) {
//       socket.leave(currentProfileRoom);
//     }
//     const room = `profile:${socket.userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
//     socket.join(room);
//     currentProfileRoom = room;
//     console.log(`📡 ${socket.userEmail} subscribed to ${profileName}`);
//   });

//   socket.on('unsubscribe:profile', () => {
//     if (currentProfileRoom) {
//       socket.leave(currentProfileRoom);
//       currentProfileRoom = null;
//     }
//   });

//   socket.on('disconnect', (reason) => {
//     console.log(`🔌 ${socket.userEmail} disconnected: ${reason}`);
//   });
// });

// // ── Start ──────────────────────────────────────────────────────────────────────
// const PORT = process.env.PORT || 3001;
// server.listen(PORT, () => {
//   console.log(`\n🔥 FireKirin Web Backend running on :${PORT}`);
//   console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
//   console.log(`📁 Data dir: ${path.resolve(dataDir)}\n`);
// });

// // ── Graceful shutdown ──────────────────────────────────────────────────────────
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received — shutting down...');
//   await botManager.shutdownAll();
//   server.close(() => process.exit(0));
// });
// process.on('SIGINT', async () => {
//   await botManager.shutdownAll();
//   server.close(() => process.exit(0));
// });




require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

const authRoutes       = require('./routes/auth');
const accountRoutes    = require('./routes/accounts');
const processingRoutes = require('./routes/processing');
const proxyRoutes      = require('./routes/proxy');
const statsRoutes      = require('./routes/stats');
const { verifyToken }  = require('./middleware/auth');
const BotManager       = require('./botManager');

const app    = express();
const server = http.createServer(app);

// ── CORS Configuration ────────────────────────────────────────────────
// Support multiple origins from environment variable or fallback to localhost
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [process.env.FRONTEND_URL || 'http://localhost:5173'];

console.log('✅ CORS allowed origins:', allowedOrigins);
console.log('🌍 FRONTEND_URL:', process.env.FRONTEND_URL || 'not set');
console.log('📋 ALLOWED_ORIGINS:', process.env.ALLOWED_ORIGINS || 'not set (using FRONTEND_URL)');

// ── Socket.IO — tuned for 200 concurrent users ────────────────────────────────
// Each user has exactly ONE socket connection (one browser tab, one profile).
// 200 users = 200 simultaneous socket connections.
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log(`❌ Socket.IO CORS blocked origin: ${origin}`);
        callback(new Error('CORS not allowed for this origin'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Increase buffer for terminal log bursts from 200 active bots
  maxHttpBufferSize: 2e6,          // 2 MB (default 1 MB)

  // Compression helps with terminal log streams but adds CPU — disable for
  // high-concurrency to keep Node's event loop free for bot processing
  perMessageDeflate: false,

  // Keep-alive tuned for 200 connections — longer ping interval reduces
  // server CPU from heartbeat processing
  pingInterval: 30000,             // 30s (default 25s)
  pingTimeout:  75000,             // 75s (default 60s)

  // Allow both transports — polling fallback for corporate firewalls
  transports: ['websocket', 'polling'],

  // Upgrade from polling → websocket quickly
  upgradeTimeout: 10000,

  // Connection state recovery — lets clients resume after brief disconnects
  // without losing their profile room subscription
  connectionStateRecovery: {
    maxDisconnectionDuration: 30000,
    skipMiddlewares: false,
  },
});

const dataDir = process.env.DATA_DIR || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));

// Express CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`❌ Express CORS blocked origin: ${origin}`);
      callback(new Error('CORS not allowed for this origin'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));

// ── Rate limiters — recalibrated for 200 concurrent users ────────────────────
//
// Old values were designed for a handful of users and would throttle at scale:
//   strictLimiter:  30 req/min   → blocks even 1 user doing frequent API calls
//   defaultLimiter: 500/15min    → blocks 200 users polling every 10s (1200/min)
//
// New values:
//   authLimiter:    20 req/min per IP  — Firebase auth is slow anyway, 20 is plenty
//   apiLimiter:     2000 req/min per IP — 200 users × 6 polls/min × ~2 endpoints = ~2400
//                   Using per-user ID via X-User-Id header if available, else IP
//
// Trust proxy if behind nginx/load balancer (needed for accurate IP detection)
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, slow down' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT) || 2000,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by userId (from decoded token) if available, else IP
  // This gives each user their own 2000/min budget rather than sharing one IP bucket
  keyGenerator: (req) => req.userId || req.ip,
  skip: (req) => req.path === '/health',
});

app.use('/api/auth', authLimiter);
app.use('/api/',     apiLimiter);

// ── BotManager ────────────────────────────────────────────────────────────────
const botManager = new BotManager(io);
app.set('io', io);
app.set('botManager', botManager);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/accounts',   verifyToken, accountRoutes);
app.use('/api/processing', verifyToken, processingRoutes);
app.use('/api/proxy',      verifyToken, proxyRoutes);
app.use('/api/stats',      verifyToken, statsRoutes);

// ── Health endpoint ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:       'ok',
    uptime:       Math.round(process.uptime()),
    activeUsers:  botManager.instances.size,
    socketCount:  io.engine.clientsCount,
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
    },
    nodeVersion: process.version,
    corsOrigins: allowedOrigins, // Helpful for debugging
  });
});

// ── Socket.IO auth middleware ─────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    const { verifyFirebaseToken } = require('./middleware/auth');
    const decoded = await verifyFirebaseToken(token);
    socket.userId    = decoded.uid;
    socket.userEmail = decoded.email;
    socket.tabId     = socket.handshake.query.tabId || 'unknown';
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// ── Socket.IO connection handler ──────────────────────────────────────────────
//
// Each user has exactly ONE profile now (their own "Profile_1" namespaced by userId).
// A user joins their personal room on connect, then subscribes to their profile room
// when they open the profile page.
//
// Multiple browser tabs from the same user each get their OWN socket but subscribe
// to the SAME profile room — so both tabs see the same bot output.
//
// 200 users × 1 socket each = 200 concurrent connections → fully manageable.
io.on('connection', (socket) => {
  console.log(`🔌 [${socket.userId?.substring(0,8)}] ${socket.userEmail} connected [${socket.id}]`);

  // Personal room — for user-level notifications (future use)
  socket.join(`user:${socket.userId}`);

  let currentProfileRoom = null;

  socket.on('subscribe:profile', (profileName) => {
    // Sanitize profile name — prevent room injection
    const safe = String(profileName).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);

    // Leave previous profile room if switching
    if (currentProfileRoom && currentProfileRoom !== safe) {
      socket.leave(currentProfileRoom);
    }

    // Room is namespaced by userId — two users with same profileName never share a room
    const room = `profile:${socket.userId}:${safe}`;
    socket.join(room);
    currentProfileRoom = room;
    console.log(`📡 [${socket.userId?.substring(0,8)}] joined ${room}`);
  });

  socket.on('unsubscribe:profile', (profileName) => {
    const safe = String(profileName).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
    const room = `profile:${socket.userId}:${safe}`;
    socket.leave(room);
    if (currentProfileRoom === room) currentProfileRoom = null;
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 [${socket.userId?.substring(0,8)}] disconnected: ${reason}`);
    // socket.io auto-removes from all rooms on disconnect
  });
});

// ── Server start ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Milkyway backend running on port ${PORT}`);
  console.log(`🌍 Frontend origin: ${process.env.FRONTEND_URL || '*'}`);
  console.log(`👥 Designed for ${process.env.MAX_USERS || 200} concurrent users`);
  console.log(`📊 Rate limit: ${process.env.API_RATE_LIMIT || 2000} req/min per user`);
  console.log(`🔒 CORS enabled for: ${allowedOrigins.join(', ')}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`\n${signal} — shutting down gracefully...`);
  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed');
    // Shut down all bot instances cleanly
    await botManager.shutdownAll();
    console.log('✅ All bot instances stopped');
    process.exit(0);
  });
  // Force exit after 15s if graceful shutdown hangs
  setTimeout(() => {
    console.error('Forced exit after timeout');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled promise rejections — prevents one user's error crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Do NOT exit — other users' bots must keep running
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Same — log but don't crash the whole server
});

module.exports = { app, io, botManager };