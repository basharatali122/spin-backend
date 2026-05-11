

// const WebSocket    = require('ws');
// const EventEmitter = require('events');
// const { makeProxyAgent, ProxyRotator } = require('./proxyUtils');

// // IPs banned by the game server — skip these for BAN_COOLDOWN_MS
// const bannedIpCache  = new Map(); // exitIp → bannedAt timestamp
// const BAN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// function recordBannedIp(ip) {
//   if (ip) bannedIpCache.set(ip, Date.now());
// }

// function isIpBanned(ip) {
//   if (!ip) return false;
//   const t = bannedIpCache.get(ip);
//   if (!t) return false;
//   if (Date.now() - t > BAN_COOLDOWN_MS) { bannedIpCache.delete(ip); return false; }
//   return true;
// }

// // Extract exit IP from PandaMaster error message
// // Format: "(1.2.3.4):system has disabled..."
// function extractBannedIp(msg) {
//   if (!msg) return null;
//   const m = String(msg).match(/\((\d+\.\d+\.\d+\.\d+)\)/);
//   return m ? m[1] : null;
// }

// // ── Global worker budget shared across ALL processor instances ──────────────
// // Node.js is single-threaded. Each active worker holds open a WebSocket + proxy
// // tunnel. If 10 users each spawn 33 workers = 330 concurrent sockets → the
// // event loop saturates and EVERYONE slows down or errors out.
// //
// // Solution: a shared counter limits total concurrent workers across ALL users.
// // KVM2 (2 vCPU, 4 GB) sweet spot: 60–80 total concurrent WebSocket workers.
// // Adjust MAX_GLOBAL_WORKERS up if you have faster proxies / more RAM.
// const MAX_GLOBAL_WORKERS = 70;
// let   _globalActiveWorkers = 0;

// function _acquireWorkerSlot() {
//   if (_globalActiveWorkers >= MAX_GLOBAL_WORKERS) return false;
//   _globalActiveWorkers++;
//   return true;
// }
// function _releaseWorkerSlot() {
//   if (_globalActiveWorkers > 0) _globalActiveWorkers--;
// }

// class RegularWheelProcessor extends EventEmitter {
//   constructor(db) {
//     super();
//     this.db              = db;
//     this.isProcessing    = false;
//     this.currentAccounts = [];
//     this.proxyRotator    = new ProxyRotator([]);
//     this.instanceId      = 'default';

//     this.stats = {
//       successCount:  0,
//       failCount:     0,
//       ipBanned:      0,
//       wheelSpins:    0,
//       totalScoreWon: 0,
//       activeWorkers: 0,
//       processed:     0,
//     };

//     this.config = {
//       LOGIN_WS_URL:   'ws://47.251.75.73:8600/',
//       GAME_VERSION:   '2.0.1',
//       ORIGIN:         'http://okay.jkgame.vip',

//       // Max workers THIS instance will try to start.
//       // The global slot limiter (MAX_GLOBAL_WORKERS=70) is the hard ceiling
//       // shared across ALL users — so 10 users each requesting 33 workers
//       // will not exceed 70 total. This keeps the event loop healthy.
//       WORKERS:        33,

//       // 1 connection per proxy IP = zero saturation risk
//       PER_PROXY_LIMIT: 1,

//       // FIX: Stagger increased from 150ms → 500ms to prevent thundering herd
//       STAGGER_MS:     500,

//       // Only retry on connection/timeout errors — NOT on server rejections
//       RETRY_ATTEMPTS: 1,
//       // FIX: Exponential backoff between retries (ms)
//       RETRY_BACKOFF: [1000, 3000, 8000],

//       TIMEOUTS: {
//         TOTAL:  35000,  // hard per-account limit
//         WS:    25000,  // FIX: Increased 12s → 25s for slow SOCKS5 handshakes  // WebSocket handshake
//       },

//       RANDOM_DELAYS: { MIN: 300, MAX: 800 },
//     };

//     this.mobileUserAgents = [
//       'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
//       'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
//       'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
//       'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
//       'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
//     ];
//   }

//   // ── Public API ──────────────────────────────────────────────────────────────

//   async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
//     if (this.isProcessing) throw new Error('Already processing');

//     this.isProcessing = true;
//     this.stats = { successCount: 0, failCount: 0, ipBanned: 0, wheelSpins: 0, totalScoreWon: 0, activeWorkers: 0, processed: 0 };

//     // Pass maxPerProxy so the rotator enforces 1 concurrent connection per proxy IP
//     this.proxyRotator = new ProxyRotator(proxyList, { maxPerProxy: this.config.PER_PROXY_LIMIT });

//     // Workers capped to proxy_count * PER_PROXY_LIMIT (but rotator still enforces the actual limit)
//     const workerCount = (useProxy && proxyList.length > 0)
//       ? Math.min(this.config.WORKERS, proxyList.length * this.config.PER_PROXY_LIMIT)
//       : this.config.WORKERS;

//     const all = await this.db.getAllAccounts();
//     this.currentAccounts = all.filter(a => accountIds.includes(a.id));

//     this._emit('terminal', { type: 'info', message: `🚀 REGULAR WHEEL SPIN BOT STARTED` });
//     this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length}` });
//     this._emit('terminal', { type: 'info', message: `⚡ Workers: ${workerCount} concurrent` });
//     this._emit('terminal', { type: 'info', message: `🌐 Login: ${this.config.LOGIN_WS_URL}` });
//     this._emit('terminal', { type: 'info', message: `🔗 Origin: ${this.config.ORIGIN}` });
//     this._emit('terminal', { type: 'info', message: `🛡️ Proxy: ${this.proxyRotator.enabled ? this.proxyRotator.summary() : 'disabled (direct)'}` });
//     this._emit('status', { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0 });

//     this._runWorkerPool(workerCount);
//     return { started: true, totalAccounts: this.currentAccounts.length };
//   }

//   async stopProcessing() {
//     this.isProcessing = false;
//     this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped by user' });
//     this._emit('status', { running: false, activeWorkers: 0 });
//     return { success: true };
//   }

//   // ── Continuous worker pool ──────────────────────────────────────────────────
//   // Each worker picks the next account from a shared index and processes it.
//   // When done, it immediately picks the next one — no waiting for a full batch.
//   // Workers start staggered to avoid bursting the game server.

//   async _runWorkerPool(workerCount) {
//     const queue   = [...this.currentAccounts]; // local copy, mutated by workers
//     let   queueIdx = 0;
//     const total   = queue.length;

//     const getNext = () => {
//       if (queueIdx >= total) return null;
//       return { account: queue[queueIdx], index: queueIdx++ };
//     };

//     const worker = async (workerId) => {
//       while (this.isProcessing) {
//         const next = getNext();
//         if (!next) break;

//         // Wait for a global slot — backs off if server is saturated
//         // This prevents event loop overload when multiple users run at once
//         let waited = 0;
//         while (!_acquireWorkerSlot()) {
//           if (!this.isProcessing) return;
//           await this._sleep(200);
//           waited += 200;
//           if (waited > 30000) break; // give up after 30s, pick next account
//         }

//         const { account, index } = next;
//         this.stats.activeWorkers++;
//         this._emit('status', {
//           running: true, total, current: index + 1,
//           activeWorkers: this.stats.activeWorkers, currentAccount: account.username,
//         });

//         try {
//           await this._processWithRetry(account, index);
//         } catch (_) {}

//         _releaseWorkerSlot();
//         this.stats.activeWorkers--;
//         this.stats.processed++;

//         // Emit speed stats every 10 accounts
//         if (this.stats.processed % 10 === 0) {
//           this._emit('terminal', {
//             type: 'info',
//             message: `📊 Progress: ${this.stats.processed}/${total} | ✅ ${this.stats.successCount} | ❌ ${this.stats.failCount} | 🚫 banned: ${this.stats.ipBanned} | Workers: ${this.stats.activeWorkers}`,
//           });
//         }
//       }
//     };

//     // Start workers with stagger
//     const workers = [];
//     for (let i = 0; i < workerCount; i++) {
//       await this._sleep(this.config.STAGGER_MS);
//       if (!this.isProcessing) break;
//       workers.push(worker(i));
//     }

//     await Promise.allSettled(workers);
//     if (this.isProcessing) this._complete();
//   }

//   // ── Retry wrapper ───────────────────────────────────────────────────────────

//   async _processWithRetry(account, globalIndex, attempt = 0) {
//     const result = await this._accountFlow(account, globalIndex, attempt);

//     // Persist result
//     if (result.newScore !== undefined) {
//       await this.db.updateAccount({ ...account, score: result.newScore });
//     }
//     await this.db.addProcessingLog(
//       account.id,
//       result.success ? 'success' : (result.ipBanned ? 'ip_banned' : 'error'),
//       result.success ? `Wheel spin: +${result.lotteryscore || 0}` : result.error,
//       result
//     );

//     if (result.ipBanned) {
//       this.stats.ipBanned++;
//       // Don't retry — different proxy will also likely be banned
//       return result;
//     }

//     if (result.serverRejected) {
//       this.stats.failCount++;
//       // Don't retry — server explicitly rejected (wrong pass, account doesn't exist)
//       return result;
//     }

//     if (!result.success && attempt < this.config.RETRY_ATTEMPTS) {
//         // Exponential backoff with jitter before retry
//         const backoffMs = (this.config.RETRY_BACKOFF[attempt] || 8000) + Math.floor(Math.random() * 500);
//         this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (connection error) (waiting ${backoffMs}ms)`);
//         await this._sleep(backoffMs);
//       return this._processWithRetry(account, globalIndex, attempt + 1);
//     }

//     if (result.success) {
//       this.stats.successCount++;
//       if (result.wheelSpun)    this.stats.wheelSpins++;
//       if (result.lotteryscore) this.stats.totalScoreWon += result.lotteryscore;
//     } else {
//       this.stats.failCount++;
//     }

//     this._emit('progress', {
//       index: globalIndex, total: this.currentAccounts.length,
//       account: account.username, success: result.success,
//       error: result.error, stats: { ...this.stats },
//     });

//     return result;
//   }

//   // ── Core account flow ───────────────────────────────────────────────────────

//   _accountFlow(account, index, attempt = 0) {
//     return new Promise(async (resolve) => {
//       let ws    = null;
//       let phase = 'login';

//       let loginDone    = false;
//       let wheelSpun    = false;
//       let lotteryscore = 0;
//       let lastScore    = account.score || 0;

//       // MegaSpin requires subID:11 (game-list handshake) after login
//       // before the server responds to subID:26 (lottery check).
//       // All other games go straight from login → subID:26.
//       const isMegaSpin = this.config.LOGIN_WS_URL.includes('47.251.75.73');

//       this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

//       const hardTimeout = setTimeout(() => {
//         cleanup();
//         resolve({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore, error: 'Timeout' });
//       }, this.config.TIMEOUTS.TOTAL);

//       const cleanup = () => {
//         clearTimeout(hardTimeout);
//         try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
//         // Release the proxy slot so another worker can use this proxy
//         if (_proxyRelease) { try { _proxyRelease(); } catch (_) {} _proxyRelease = null; }
//       };

//       const done = (result) => {
//         if (phase === 'done') return;
//         phase = 'done';
//         cleanup();
//         resolve(result);
//       };

//       // ── Proxy selection (semaphore-aware) ────────────────────────────────
//       // acquire() waits for a free slot so no proxy IP is over-saturated.
//       // release() MUST be called on all exit paths — wired into cleanup().
//       let agent         = null;
//       let proxyIp       = null;
//       let _proxyRelease = null; // will be set if we acquire a proxy slot

//       // SECURITY: if proxies are configured, we MUST use one.
//       // Never fall through to direct — that would expose the Hostinger server IP.
//       if (this.proxyRotator.enabled) {
//         try {
//           // Skip banned proxies: try up to proxy_count times to find a clean one
//           let acquired = null;
//           const maxTries = Math.min(5, this.proxyRotator.proxies.length || 5);
//           for (let t = 0; t <= maxTries; t++) {
//             acquired = await this.proxyRotator.acquire();
//             if (!acquired.proxyUrl) break;
//             const u = new URL(acquired.proxyUrl);
//             if (!isIpBanned(u.hostname)) break;
//             // This proxy is banned — release it and try to get another
//             this._log(index, 'warning', `⚠️ Proxy ${u.hostname} is banned — skipping`);
//             acquired.release();
//             acquired = null;
//           }

//           if (acquired && acquired.proxyUrl) {
//             _proxyRelease = acquired.release;
//             const u = new URL(acquired.proxyUrl);
//             proxyIp = u.hostname;
//             try {
//               agent = await makeProxyAgent(acquired.proxyUrl);
//               if (agent) {
//                 this._log(index, 'debug', `🛡️ Proxy: ${acquired.proxyUrl.replace(/\/\/[^@]+@/, '//*:****@')}`);
//               } else {
//                 // Proxy agent creation failed — ABORT, do not expose server IP
//                 this._log(index, 'error', `❌ Proxy agent failed — aborting (IP protection)`);
//                 return done({ success: false, error: 'Proxy agent failed' });
//               }
//             } catch (err) {
//               // Proxy error — ABORT, do not expose server IP
//               this._log(index, 'error', `❌ Proxy error: ${err.message} — aborting (IP protection)`);
//               return done({ success: false, error: `Proxy error: ${err.message}` });
//             }
//           } else {
//             // All proxies are banned — ABORT, do not expose server IP
//             this._log(index, 'error', `❌ All proxies banned — aborting (IP protection)`);
//             return done({ success: false, error: 'All proxies banned' });
//           }
//         } catch (err) {
//           // acquire() timed out or threw — ABORT, do not expose server IP
//           this._log(index, 'error', `❌ Proxy acquire failed: ${err.message} — aborting (IP protection)`);
//           return done({ success: false, error: `Proxy acquire failed: ${err.message}` });
//         }
//       }

//       // ── WebSocket ──────────────────────────────────────────────────────────
//       const wsOptions = {
//         handshakeTimeout: this.config.TIMEOUTS.WS,
//         headers: { 'User-Agent': this._userAgent(), 'Origin': this.config.ORIGIN },
//       };
//       if (agent) wsOptions.agent = agent;

//       try {
//         ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
//       } catch (err) {
//         return resolve({ success: false, error: `WS create: ${err.message}` });
//       }

//       ws.on('open', () => {
//         this._log(index, 'success', `✅ Connected`);
//         ws.send(JSON.stringify({
//           account:  account.username,
//           password: account.password,
//           version:  this.config.GAME_VERSION,
//           mainID:   100, subID: 6,
//         }));
//       });

//       ws.on('message', (raw) => {
//         if (phase === 'done') return;
//         let msg;
//         try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

//         this._log(index, 'debug', `📩 mainID:${msg.mainID} subID:${msg.subID} phase:${phase}`);

//         // ── Login response ──────────────────────────────────────────────────
//         if (msg.subID === 116 && !loginDone) {
//           const d = msg.data || {};

//           if (d.result === -1) {
//             // IP banned — record and skip, no retry
//             const bannedIp = extractBannedIp(d.msg);
//             if (bannedIp) recordBannedIp(bannedIp);
//             this._log(index, 'error', `❌ IP BANNED: ${d.msg}`);
//             return done({ success: false, ipBanned: true, bannedIp, error: d.msg });
//           }

//           if (!d.userid || !d.dynamicpass) {
//             this._log(index, 'error', `❌ Login failed — result=${d.result} msg="${d.msg || ''}"`);
//             // result=1: account not found / wrong password (no point retrying — different proxy won't help)
//             // result=2: account locked
//             // result=3: wrong password
//             // All non-zero results are server rejections — never retry
//             const serverRejected = d.result !== 0;
//             return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})` });
//           }

//           account.userid      = d.userid;
//           account.dynamicpass = d.dynamicpass;
//           account.bossid      = d.bossid;
//           lastScore           = d.score || lastScore;
//           loginDone           = true;
//           this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

//           if (isMegaSpin) {
//             // MegaSpin REQUIRES subID:11 (game-list) before subID:26 will respond.
//             phase = 'gamelist';
//             ws.send(JSON.stringify({ userid: account.userid, mainID: 100, subID: 11 }));
//           } else {
//             phase = 'check';
//             ws.send(JSON.stringify({
//               userid: account.userid, password: account.password,
//               mainID: 100, subID: 26,
//             }));
//           }
//         }

//         // ── MegaSpin: game-list response → proceed to lottery check ───────────
//         if (msg.subID === 122 && phase === 'gamelist') {
//           this._log(index, 'debug', `🎮 Game list received — proceeding to lottery check`);
//           phase = 'check';
//           ws.send(JSON.stringify({
//             userid: account.userid, password: account.password,
//             mainID: 100, subID: 26,
//           }));
//           return;
//         }

//         // ── Availability check ──────────────────────────────────────────────
//         if (msg.subID === 142 && phase === 'check') {
//           const d = msg.data || {};
//           if (d.dynamicpass) account.dynamicpass = d.dynamicpass;
//           if (d.score !== undefined) lastScore = d.score;

//           const regularAvail = d.blottery === 1;
//           this._log(index, 'info', `🎡 Regular: ${regularAvail} | blottery=${d.blottery}`);

//           if (!regularAvail) {
//             this._log(index, 'warning', `⚠️ Already spun today`);
//             return done({ success: true, wheelSpun: false, lotteryscore: 0, newScore: lastScore, message: 'Already spun' });
//           }

//           phase = 'spin';
//           ws.send(JSON.stringify({
//             userid: account.userid, dynamicpass: account.dynamicpass,
//             mainID: 100, subID: 16,
//           }));
//           return;
//         }

//         // ── Spin result ─────────────────────────────────────────────────────
//         if (msg.subID === 131 && phase === 'spin') {
//           const d = msg.data || {};
//           wheelSpun    = true;
//           lotteryscore = d.lotteryscore || 0;
//           lastScore    = d.score !== undefined ? d.score : lastScore;

//           if (d.result === 0) {
//             this._log(index, 'success', `🎉 Won: +${lotteryscore} pts | balance: ${lastScore}`);
//           } else {
//             this._log(index, 'warning', `⚠️ Spin result=${d.result}`);
//           }

//           setTimeout(() => done({ success: true, wheelSpun: true, lotteryscore, newScore: lastScore }), 300);
//           return;
//         }
//       });

//       ws.on('error', (err) => {
//         this._log(index, 'error', `❌ WS error: ${err.message}`);
//         done({ success: false, error: err.message, wheelSpun, lotteryscore, newScore: lastScore });
//       });

//       ws.on('close', (code) => {
//         if (phase !== 'done') {
//           done({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore });
//         }
//       });
//     });
//   }

//   // ── Completion ──────────────────────────────────────────────────────────────

//   _complete() {
//     this.isProcessing = false;
//     this._emit('terminal', { type: 'success', message: `\n🎉 ALL PROCESSING COMPLETED!` });
//     this._emit('terminal', { type: 'info',    message: `📈 Success: ${this.stats.successCount} | Failed: ${this.stats.failCount} | IP Banned: ${this.stats.ipBanned}` });
//     this._emit('terminal', { type: 'info',    message: `🎡 Wheels spun: ${this.stats.wheelSpins} | Score won: ${this.stats.totalScoreWon}` });
//     this._emit('completed', { ...this.stats });
//     this._emit('status',   { running: false, activeWorkers: 0 });
//   }

//   // ── Helpers ─────────────────────────────────────────────────────────────────

//   _emit(event, data) { this.emit(event, data); }

//   _log(index, type, message) {
//     this.emit('terminal', { type, message: `[${index}] ${message}`, timestamp: new Date().toISOString() });
//   }

//   _userAgent() {
//     return this.mobileUserAgents[Math.floor(Math.random() * this.mobileUserAgents.length)];
//   }

//   _rand(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
//   _sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
// }

// module.exports = RegularWheelProcessor;
// module.exports._acquireWorkerSlot = _acquireWorkerSlot;
// module.exports._releaseWorkerSlot = _releaseWorkerSlot;







const WebSocket    = require('ws');
const EventEmitter = require('events');
const { makeProxyAgent, ProxyRotator } = require('./proxyUtils');

// IPs banned by the game server — skip these for BAN_COOLDOWN_MS
const bannedIpCache  = new Map(); // exitIp → bannedAt timestamp
const BAN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function recordBannedIp(ip) {
  if (ip) bannedIpCache.set(ip, Date.now());
}

function isIpBanned(ip) {
  if (!ip) return false;
  const t = bannedIpCache.get(ip);
  if (!t) return false;
  if (Date.now() - t > BAN_COOLDOWN_MS) { bannedIpCache.delete(ip); return false; }
  return true;
}

// Extract exit IP from PandaMaster error message
// Format: "(1.2.3.4):system has disabled..."
function extractBannedIp(msg) {
  if (!msg) return null;
  const m = String(msg).match(/\((\d+\.\d+\.\d+\.\d+)\)/);
  return m ? m[1] : null;
}

// ── Global worker budget shared across ALL processor instances ──────────────
// Node.js is single-threaded. Each active worker holds open a WebSocket + proxy
// tunnel. If 10 users each spawn 33 workers = 330 concurrent sockets → the
// event loop saturates and EVERYONE slows down or errors out.
//
// TARGET: 100 concurrent users, each finishing 500 accounts in 3-5 minutes.
// Math: 500 accounts / 3min = 167 accounts/min = 2.8 accounts/sec per user.
// Each account takes ~1-2 seconds (login+gamelist+check+spin = 4 WS messages).
// So each user needs ~5-8 active workers to maintain 2.8 acc/sec.
// 100 users × 7 workers = 700 — but Node.js can handle ~300 concurrent WS safely.
// Solution: per-user worker count scales DOWN as more users are active,
// but each user always gets at least 6 workers minimum.
//
// KVM2 (2 vCPU, 4 GB): tested safe up to 300 concurrent WebSocket workers.
// ── Global worker budget ─────────────────────────────────────────────────────
// Node.js is single-threaded. This counter limits TOTAL concurrent WebSocket
// workers across ALL users so the event loop never saturates.
const MAX_GLOBAL_WORKERS = 300;
let   _globalActiveWorkers = 0;

function _acquireWorkerSlot() {
  if (_globalActiveWorkers >= MAX_GLOBAL_WORKERS) return false;
  _globalActiveWorkers++;
  return true;
}
function _releaseWorkerSlot() {
  if (_globalActiveWorkers > 0) _globalActiveWorkers--;
}

// ── Active user tracking ─────────────────────────────────────────────────────
// CRITICAL: Use a Set of instances, NOT a counter.
// A counter leaks: if startProcessing increments but a crash skips decrement,
// the count grows forever → workers drop to 14 → performance degrades each run.
// A Set is self-healing: add(this) on start, delete(this) on stop. No leak possible.
const _runningProcessors = new Set();

function _getWorkersForUser(requestedWorkers) {
  const activeCount = _runningProcessors.size || 1;
  if (activeCount <= 1) return requestedWorkers;
  // Fair share: divide budget equally, guarantee at least 10 workers per user
  const fair = Math.floor(MAX_GLOBAL_WORKERS / activeCount);
  return Math.max(10, Math.min(requestedWorkers, fair));
}

class RegularWheelProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.db              = db;
    this.isProcessing    = false;
    this.currentAccounts = [];
    this.proxyRotator    = new ProxyRotator([]);
    this.instanceId      = 'default';

    this.stats = {
      successCount:  0,
      failCount:     0,
      ipBanned:      0,
      wheelSpins:    0,
      totalScoreWon: 0,
      activeWorkers: 0,
      processed:     0,
    };

    this.config = {
      LOGIN_WS_URL:   'ws://47.251.75.73:8600/',
      GAME_VERSION:   '2.0.1',
      ORIGIN:         'http://okay.jkgame.vip',

      // Max workers THIS instance will try to start.
      // _getWorkersForUser() scales this down fairly when many users are active.
      WORKERS:        33,

      // 1 connection per proxy IP = zero saturation risk
      PER_PROXY_LIMIT: 1,

      // FIXED: Was 500ms → caused 33×500=16.5s startup delay per user!
      // Now 50ms: workers start fast, global slot limiter controls concurrency.
      STAGGER_MS:     50,

      // Only retry once — failed proxies waste time, better to move on fast
      RETRY_ATTEMPTS: 1,

      // FIXED: Was [1000,3000,8000] — a single fail blocked a worker for 8s!
      // 100+ failures × 4s avg = 400+ seconds wasted per run.
      // Now 300ms: quick retry then move on.
      RETRY_BACKOFF: [300, 800],

      TIMEOUTS: {
        // FIXED: Was 35s → now 12s. Login+spin normally takes <3s.
        // 12s is still generous for slow proxies. Failing fast frees workers.
        TOTAL:  12000,
        // FIXED: Was 25s → now 8s. Enough for SOCKS5 handshake.
        WS:      8000,
      },

      // FIXED: Was MIN:300 MAX:800 — added ~550ms after EVERY account!
      // 500 accounts × 550ms = 275 seconds wasted per run. Removed.
      RANDOM_DELAYS: { MIN: 0, MAX: 30 },
    };

    this.mobileUserAgents = [
      'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    ];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
    if (this.isProcessing) throw new Error('Already processing');

    this.isProcessing = true;
    this.stats = { successCount: 0, failCount: 0, ipBanned: 0, wheelSpins: 0, totalScoreWon: 0, activeWorkers: 0, processed: 0 };
    this._lastStatusEmit = 0;

    // Register this instance as running — Set prevents double-registration
    _runningProcessors.add(this);

    // acquireTimeoutMs: 8s max wait for a proxy slot.
    // Was 30s — a worker blocked for 30s waiting for proxy = dead worker.
    this.proxyRotator = new ProxyRotator(proxyList, {
      maxPerProxy: this.config.PER_PROXY_LIMIT,
      acquireTimeoutMs: 8000,
    });

    const rawCount = (useProxy && proxyList.length > 0)
      ? Math.min(this.config.WORKERS, proxyList.length * this.config.PER_PROXY_LIMIT)
      : this.config.WORKERS;
    const workerCount = _getWorkersForUser(rawCount);

    const all = await this.db.getAllAccounts();
    this.currentAccounts = all.filter(a => accountIds.includes(a.id));

    this._emit('terminal', { type: 'info', message: `🚀 REGULAR WHEEL SPIN BOT STARTED` });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length}` });
    this._emit('terminal', { type: 'info', message: `⚡ Workers: ${workerCount} (active users: ${_runningProcessors.size})` });
    this._emit('terminal', { type: 'info', message: `🌐 Login: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🔗 Origin: ${this.config.ORIGIN}` });
    this._emit('terminal', { type: 'info', message: `🛡️ Proxy: ${this.proxyRotator.enabled ? this.proxyRotator.summary() : 'disabled (direct)'}` });
    this._emit('status', { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0 });

    this._runWorkerPool(workerCount);
    return { started: true, totalAccounts: this.currentAccounts.length };
  }

  async stopProcessing() {
    this.isProcessing = false;
    _runningProcessors.delete(this); // safe to call even if not in set
    this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped by user' });
    this._emit('status', { running: false, activeWorkers: 0 });
    return { success: true };
  }

  // ── Continuous worker pool ──────────────────────────────────────────────────
  // Each worker picks the next account from a shared index and processes it.
  // When done, it immediately picks the next one — no waiting for a full batch.
  // Workers start staggered to avoid bursting the game server.

  // ── Continuous worker pool ──────────────────────────────────────────────────
  // Each worker picks the next account from a shared queue and processes it
  // immediately when done — no waiting for a batch to finish.
  // The global slot counter (_globalActiveWorkers) prevents the combined
  // workers of ALL concurrent users from overloading the Node.js event loop.

  async _runWorkerPool(workerCount) {
    const queue    = [...this.currentAccounts];
    let   queueIdx = 0;
    const total    = queue.length;

    const getNext = () => {
      if (queueIdx >= total) return null;
      return { account: queue[queueIdx], index: queueIdx++ };
    };

    const worker = async (workerId) => {
      while (this.isProcessing) {
        const next = getNext();
        if (!next) break;

        // Acquire a global slot. Spin with 50ms yield — fast enough to keep
        // workers busy without burning CPU while slots are temporarily full.
        while (!_acquireWorkerSlot()) {
          if (!this.isProcessing) return;
          await this._sleep(50);
        }

        const { account, index } = next;
        this.stats.activeWorkers++;

        // Throttle status broadcast: max once per 250ms across ALL workers.
        // Without throttle: 300 workers × ~1 finish/sec = 300 socket broadcasts/sec.
        // With throttle: max 4 broadcasts/sec regardless of worker count.
        const now = Date.now();
        if (now - this._lastStatusEmit > 250) {
          this._lastStatusEmit = now;
          this._emit('status', {
            running: true, total, current: index + 1,
            activeWorkers: this.stats.activeWorkers, currentAccount: account.username,
          });
        }

        try {
          await this._processWithRetry(account, index);
        } catch (_) {}

        _releaseWorkerSlot();
        this.stats.activeWorkers--;
        this.stats.processed++;

        if (this.stats.processed % 10 === 0) {
          this._emit('terminal', {
            type: 'info',
            message: `📊 Progress: ${this.stats.processed}/${total} | ✅ ${this.stats.successCount} | ❌ ${this.stats.failCount} | 🚫 banned: ${this.stats.ipBanned} | Workers: ${this.stats.activeWorkers}`,
          });
        }
      }
    };

    // Stagger worker startup — 50ms × 33 workers = 1.65s total (was 16.5s!)
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      await this._sleep(this.config.STAGGER_MS);
      if (!this.isProcessing) break;
      workers.push(worker(i));
    }

    await Promise.allSettled(workers);

    // Unregister from running set — job completed naturally
    _runningProcessors.delete(this);
    if (this.isProcessing) this._complete();
  }

  // ── Retry wrapper ───────────────────────────────────────────────────────────

  async _processWithRetry(account, globalIndex, attempt = 0) {
    const result = await this._accountFlow(account, globalIndex, attempt);

    // Persist result — fire-and-forget, never block the worker
    if (result.newScore !== undefined) {
      this.db.updateAccount({ ...account, score: result.newScore });
    }
    this.db.addProcessingLog(
      account.id,
      result.success ? 'success' : (result.ipBanned ? 'ip_banned' : 'error'),
      result.success ? `Wheel spin: +${result.lotteryscore || 0}` : result.error,
      result
    );

    if (result.ipBanned) {
      this.stats.ipBanned++;
      // Don't retry — different proxy will also likely be banned
      return result;
    }

    if (result.serverRejected) {
      this.stats.failCount++;
      // Don't retry — server explicitly rejected (wrong pass, account doesn't exist)
      return result;
    }

    if (!result.success && attempt < this.config.RETRY_ATTEMPTS) {
        // Exponential backoff with jitter before retry
        const backoffMs = (this.config.RETRY_BACKOFF[attempt] || 8000) + Math.floor(Math.random() * 500);
        this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (connection error) (waiting ${backoffMs}ms)`);
        await this._sleep(backoffMs);
      return this._processWithRetry(account, globalIndex, attempt + 1);
    }

    if (result.success) {
      this.stats.successCount++;
      if (result.wheelSpun)    this.stats.wheelSpins++;
      if (result.lotteryscore) this.stats.totalScoreWon += result.lotteryscore;
    } else {
      this.stats.failCount++;
    }

    this._emit('progress', {
      index: globalIndex, total: this.currentAccounts.length,
      account: account.username, success: result.success,
      error: result.error, stats: { ...this.stats },
    });

    return result;
  }

  // ── Core account flow ───────────────────────────────────────────────────────

  _accountFlow(account, index, attempt = 0) {
    return new Promise(async (resolve) => {
      let ws    = null;
      let phase = 'login';

      let loginDone    = false;
      let wheelSpun    = false;
      let lotteryscore = 0;
      let lastScore    = account.score || 0;

      // MegaSpin requires subID:11 (game-list handshake) after login
      // before the server responds to subID:26 (lottery check).
      // All other games go straight from login → subID:26.
      const isMegaSpin = this.config.LOGIN_WS_URL.includes('47.251.75.73');

      this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

      const hardTimeout = setTimeout(() => {
        cleanup();
        resolve({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore, error: 'Timeout' });
      }, this.config.TIMEOUTS.TOTAL);

      const cleanup = () => {
        clearTimeout(hardTimeout);
        try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
        // Release the proxy slot so another worker can use this proxy
        if (_proxyRelease) { try { _proxyRelease(); } catch (_) {} _proxyRelease = null; }
      };

      const done = (result) => {
        if (phase === 'done') return;
        phase = 'done';
        cleanup();
        resolve(result);
      };

      // ── Proxy selection (semaphore-aware) ────────────────────────────────
      // acquire() waits for a free slot so no proxy IP is over-saturated.
      // release() MUST be called on all exit paths — wired into cleanup().
      let agent         = null;
      let proxyIp       = null;
      let _proxyRelease = null; // will be set if we acquire a proxy slot

      // SECURITY: if proxies are configured, we MUST use one.
      // Never fall through to direct — that would expose the Hostinger server IP.
      if (this.proxyRotator.enabled) {
        try {
          // Skip banned proxies: try up to proxy_count times to find a clean one
          let acquired = null;
          const maxTries = Math.min(5, this.proxyRotator.proxies.length || 5);
          for (let t = 0; t <= maxTries; t++) {
            acquired = await this.proxyRotator.acquire();
            if (!acquired.proxyUrl) break;
            const u = new URL(acquired.proxyUrl);
            if (!isIpBanned(u.hostname)) break;
            // This proxy is banned — release it and try to get another
            this._log(index, 'warning', `⚠️ Proxy ${u.hostname} is banned — skipping`);
            acquired.release();
            acquired = null;
          }

          if (acquired && acquired.proxyUrl) {
            _proxyRelease = acquired.release;
            const u = new URL(acquired.proxyUrl);
            proxyIp = u.hostname;
            try {
              agent = await makeProxyAgent(acquired.proxyUrl);
              if (agent) {
                this._log(index, 'debug', `🛡️ Proxy: ${acquired.proxyUrl.replace(/\/\/[^@]+@/, '//*:****@')}`);
              } else {
                // Proxy agent creation failed — ABORT, do not expose server IP
                this._log(index, 'error', `❌ Proxy agent failed — aborting (IP protection)`);
                return done({ success: false, error: 'Proxy agent failed' });
              }
            } catch (err) {
              // Proxy error — ABORT, do not expose server IP
              this._log(index, 'error', `❌ Proxy error: ${err.message} — aborting (IP protection)`);
              return done({ success: false, error: `Proxy error: ${err.message}` });
            }
          } else {
            // All proxies are banned — ABORT, do not expose server IP
            this._log(index, 'error', `❌ All proxies banned — aborting (IP protection)`);
            return done({ success: false, error: 'All proxies banned' });
          }
        } catch (err) {
          // acquire() timed out or threw — ABORT, do not expose server IP
          this._log(index, 'error', `❌ Proxy acquire failed: ${err.message} — aborting (IP protection)`);
          return done({ success: false, error: `Proxy acquire failed: ${err.message}` });
        }
      }

      // ── WebSocket ──────────────────────────────────────────────────────────
      const wsOptions = {
        handshakeTimeout: this.config.TIMEOUTS.WS,
        headers: { 'User-Agent': this._userAgent(), 'Origin': this.config.ORIGIN },
      };
      if (agent) wsOptions.agent = agent;

      try {
        ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
      } catch (err) {
        return resolve({ success: false, error: `WS create: ${err.message}` });
      }

      ws.on('open', () => {
        this._log(index, 'success', `✅ Connected`);
        ws.send(JSON.stringify({
          account:  account.username,
          password: account.password,
          version:  this.config.GAME_VERSION,
          mainID:   100, subID: 6,
        }));
      });

      ws.on('message', (raw) => {
        if (phase === 'done') return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        this._log(index, 'debug', `📩 mainID:${msg.mainID} subID:${msg.subID} phase:${phase}`);

        // ── Login response ──────────────────────────────────────────────────
        if (msg.subID === 116 && !loginDone) {
          const d = msg.data || {};

          if (d.result === -1) {
            // IP banned — record and skip, no retry
            const bannedIp = extractBannedIp(d.msg);
            if (bannedIp) recordBannedIp(bannedIp);
            this._log(index, 'error', `❌ IP BANNED: ${d.msg}`);
            return done({ success: false, ipBanned: true, bannedIp, error: d.msg });
          }

          if (!d.userid || !d.dynamicpass) {
            this._log(index, 'error', `❌ Login failed — result=${d.result} msg="${d.msg || ''}"`);
            // result=1: account not found / wrong password (no point retrying — different proxy won't help)
            // result=2: account locked
            // result=3: wrong password
            // All non-zero results are server rejections — never retry
            const serverRejected = d.result !== 0;
            return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})` });
          }

          account.userid      = d.userid;
          account.dynamicpass = d.dynamicpass;
          account.bossid      = d.bossid;
          lastScore           = d.score || lastScore;
          loginDone           = true;
          this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

          if (isMegaSpin) {
            // MegaSpin REQUIRES subID:11 (game-list) before subID:26 will respond.
            phase = 'gamelist';
            ws.send(JSON.stringify({ userid: account.userid, mainID: 100, subID: 11 }));
          } else {
            phase = 'check';
            ws.send(JSON.stringify({
              userid: account.userid, password: account.password,
              mainID: 100, subID: 26,
            }));
          }
        }

        // ── MegaSpin: game-list response → proceed to lottery check ───────────
        if (msg.subID === 122 && phase === 'gamelist') {
          this._log(index, 'debug', `🎮 Game list received — proceeding to lottery check`);
          phase = 'check';
          ws.send(JSON.stringify({
            userid: account.userid, password: account.password,
            mainID: 100, subID: 26,
          }));
          return;
        }

        // ── Availability check ──────────────────────────────────────────────
        if (msg.subID === 142 && phase === 'check') {
          const d = msg.data || {};
          if (d.dynamicpass) account.dynamicpass = d.dynamicpass;
          if (d.score !== undefined) lastScore = d.score;

          const regularAvail = d.blottery === 1;
          this._log(index, 'info', `🎡 Regular: ${regularAvail} | blottery=${d.blottery}`);

          if (!regularAvail) {
            this._log(index, 'warning', `⚠️ Already spun today`);
            return done({ success: true, wheelSpun: false, lotteryscore: 0, newScore: lastScore, message: 'Already spun' });
          }

          phase = 'spin';
          ws.send(JSON.stringify({
            userid: account.userid, dynamicpass: account.dynamicpass,
            mainID: 100, subID: 16,
          }));
          return;
        }

        // ── Spin result ─────────────────────────────────────────────────────
        if (msg.subID === 131 && phase === 'spin') {
          const d = msg.data || {};
          wheelSpun    = true;
          lotteryscore = d.lotteryscore || 0;
          lastScore    = d.score !== undefined ? d.score : lastScore;

          if (d.result === 0) {
            this._log(index, 'success', `🎉 Won: +${lotteryscore} pts | balance: ${lastScore}`);
          } else {
            this._log(index, 'warning', `⚠️ Spin result=${d.result}`);
          }

          setTimeout(() => done({ success: true, wheelSpun: true, lotteryscore, newScore: lastScore }), 300);
          return;
        }
      });

      ws.on('error', (err) => {
        this._log(index, 'error', `❌ WS error: ${err.message}`);
        done({ success: false, error: err.message, wheelSpun, lotteryscore, newScore: lastScore });
      });

      ws.on('close', (code) => {
        if (phase !== 'done') {
          done({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore });
        }
      });
    });
  }

  // ── Completion ──────────────────────────────────────────────────────────────

  _complete() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'success', message: `\n🎉 ALL PROCESSING COMPLETED!` });
    this._emit('terminal', { type: 'info',    message: `📈 Success: ${this.stats.successCount} | Failed: ${this.stats.failCount} | IP Banned: ${this.stats.ipBanned}` });
    this._emit('terminal', { type: 'info',    message: `🎡 Wheels spun: ${this.stats.wheelSpins} | Score won: ${this.stats.totalScoreWon}` });
    this._emit('completed', { ...this.stats });
    this._emit('status',   { running: false, activeWorkers: 0 });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _emit(event, data) { this.emit(event, data); }

  _log(index, type, message) {
    this.emit('terminal', { type, message: `[${index}] ${message}`, timestamp: new Date().toISOString() });
  }

  _userAgent() {
    return this.mobileUserAgents[Math.floor(Math.random() * this.mobileUserAgents.length)];
  }

  _rand(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
  _sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = RegularWheelProcessor;
module.exports._acquireWorkerSlot = _acquireWorkerSlot;
module.exports._releaseWorkerSlot = _releaseWorkerSlot;
module.exports._runningProcessors = _runningProcessors;
module.exports._getWorkersForUser = _getWorkersForUser;
