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

const { verifyToken, verifyFirebaseToken } = require('./middleware/auth');
const accountRoutes    = require('./routes/accounts');
const processingRoutes = require('./routes/processing');
const { proxyRouter, statsRouter } = require('./routes/other');
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
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ── Data directory ─────────────────────────────────────────────────────────────
const dataDir = process.env.DATA_DIR || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
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
  credentials: true 
}));
app.use(express.json({ limit: '10mb' }));

const defaultLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true });
const authLimiter    = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use('/api/', defaultLimiter);

// ── Bot Manager ────────────────────────────────────────────────────────────────
const botManager = new BotManager(io);
app.set('botManager', botManager);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/accounts',   verifyToken, accountRoutes);
app.use('/api/processing', verifyToken, processingRoutes);
app.use('/api/proxy',      verifyToken, proxyRouter);
app.use('/api/stats',      verifyToken, statsRouter);

app.get('/health', (req, res) => {
  const stats = botManager.getServerStats();
  res.json({ status: 'ok', uptime: process.uptime(), ...stats, corsOrigins: allowedOrigins });
});

// ── Socket Auth ────────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    const decoded = await verifyFirebaseToken(token);
    socket.userId    = decoded.uid;
    socket.userEmail = decoded.email;
    socket.tabId     = socket.handshake.query.tabId || 'unknown';
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.userEmail} [tab:${socket.tabId}] connected [${socket.id}]`);

  let currentProfileRoom = null;

  socket.on('subscribe:profile', (profileName) => {
    if (currentProfileRoom && currentProfileRoom !== profileName) {
      socket.leave(currentProfileRoom);
    }
    const room = `profile:${socket.userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    socket.join(room);
    currentProfileRoom = room;
    console.log(`📡 ${socket.userEmail} subscribed to ${profileName}`);
  });

  socket.on('unsubscribe:profile', () => {
    if (currentProfileRoom) {
      socket.leave(currentProfileRoom);
      currentProfileRoom = null;
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 ${socket.userEmail} disconnected: ${reason}`);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🔥 FireKirin Web Backend running on :${PORT}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`🔒 CORS enabled for: ${allowedOrigins.join(', ')}`);
  console.log(`📁 Data dir: ${path.resolve(dataDir)}\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down...');
  await botManager.shutdownAll();
  server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
  await botManager.shutdownAll();
  server.close(() => process.exit(0));
});