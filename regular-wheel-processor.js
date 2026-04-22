



// /**
//  * regular-wheel-processor.js  —  HIGH THROUGHPUT EDITION
//  *
//  * Key improvements over previous version:
//  *
//  * 1. CONTINUOUS WORKER POOL (replaces batch loop)
//  *    Instead of: process 5 → wait → process 5 → wait
//  *    Now:        maintain N workers running at all times
//  *    Effect:     no idle time between batches → 10-17x faster
//  *
//  * 2. PANDAMASTER IP BAN HANDLING
//  *    result=-1 + "disabled login function" = that proxy's exit IP is banned.
//  *    - These accounts are NOT retried (retrying wastes a slot + burns more proxies)
//  *    - Banned proxy exit IPs are tracked in memory and skipped for 10 minutes
//  *    - Account is marked as "ip_banned" in DB, skipped on next run
//  *
//  * 3. SMART RETRY — only retries CONNECTION errors, not server rejections
//  *    - result=-1 (IP ban)     → skip immediately, no retry
//  *    - result=3  (wrong pass) → skip immediately, no retry
//  *    - WS error / timeout     → retry with fresh proxy
//  *
//  * 4. STAGGERED STARTS — new workers start with 150ms offset
//  *    Prevents all workers hammering the game server in the same millisecond.
//  *
//  * THROUGHPUT TARGET:
//  *   With 20 workers + 52 proxies:
//  *   Each account ~4-7s → 20 workers → 3-5 accounts/sec → 10k-18k/hour
//  */

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
//       LOGIN_WS_URL:   'wss://pandamaster.vip:7878/',
//       GAME_VERSION:   '2.0.1',
//       ORIGIN:         'http://play.pandamaster.vip',

//       // Worker pool size — tune based on proxy count
//       // Rule: WORKERS ≤ proxy_count to ensure 1 proxy per concurrent worker
//       WORKERS:        20,

//       // Stagger between worker starts (ms) — reduces burst on game server
//       STAGGER_MS:     150,

//       // Only retry on connection/timeout errors — NOT on server rejections
//       RETRY_ATTEMPTS: 1,

//       TIMEOUTS: {
//         TOTAL:  35000,  // hard per-account limit
//         WS:     12000,  // WebSocket handshake
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

//     this.proxyRotator = new ProxyRotator(proxyList);

//     // Cap workers to proxy count when proxies enabled — ensures 1 proxy per worker
//     const workerCount = (useProxy && proxyList.length > 0)
//       ? Math.min(this.config.WORKERS, proxyList.length)
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

//         const { account, index } = next;
//         this.stats.activeWorkers++;
//         this._emit('status', {
//           running: true, total, current: index + 1,
//           activeWorkers: this.stats.activeWorkers, currentAccount: account.username,
//         });

//         try {
//           await this._processWithRetry(account, index);
//         } catch (_) {}

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
//       this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (connection error)`);
//       await this._sleep(this._rand(500, 1200));
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

//       this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

//       const hardTimeout = setTimeout(() => {
//         cleanup();
//         resolve({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore, error: 'Timeout' });
//       }, this.config.TIMEOUTS.TOTAL);

//       const cleanup = () => {
//         clearTimeout(hardTimeout);
//         try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
//       };

//       const done = (result) => {
//         if (phase === 'done') return;
//         phase = 'done';
//         cleanup();
//         resolve(result);
//       };

//       // ── Proxy selection ────────────────────────────────────────────────────
//       let agent      = null;
//       let proxyIp    = null;

//       if (this.proxyRotator.enabled) {
//         const proxyUrl = this.proxyRotator.next();
//         if (proxyUrl) {
//           // Extract IP for ban check
//           try {
//             const u = new URL(proxyUrl);
//             proxyIp = u.hostname;
//             if (isIpBanned(proxyIp)) {
//               this._log(index, 'warning', `⚠️ Proxy ${proxyIp} is banned — skipping to next`);
//               // Try to get a non-banned proxy
//               let found = false;
//               for (let t = 0; t < 5; t++) {
//                 const alt = this.proxyRotator.next();
//                 if (!alt) break;
//                 const au = new URL(alt);
//                 if (!isIpBanned(au.hostname)) {
//                   proxyIp = au.hostname;
//                   try {
//                     agent = await makeProxyAgent(alt);
//                     if (agent) {
//                       this._log(index, 'debug', `🛡️ Alt proxy: ${alt.replace(/\/\/[^@]+@/, '//*:****@')}`);
//                       found = true;
//                       break;
//                     }
//                   } catch (_) {}
//                 }
//               }
//               if (!found) {
//                 this._log(index, 'warning', `⚠️ All tried proxies banned — using direct`);
//               }
//             } else {
//               try {
//                 agent = await makeProxyAgent(proxyUrl);
//                 if (agent) {
//                   this._log(index, 'debug', `🛡️ Proxy: ${proxyUrl.replace(/\/\/[^@]+@/, '//*:****@')}`);
//                 } else {
//                   this._log(index, 'warning', `⚠️ Proxy agent failed — using direct`);
//                 }
//               } catch (err) {
//                 this._log(index, 'warning', `⚠️ Proxy error: ${err.message}`);
//               }
//             }
//           } catch (_) {
//             try { agent = await makeProxyAgent(proxyUrl); } catch (_) {}
//           }
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
//             // result=3 = wrong password → server rejection, no retry
//             const serverRejected = d.result === 3 || d.result === 2;
//             return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})` });
//           }

//           account.userid      = d.userid;
//           account.dynamicpass = d.dynamicpass;
//           account.bossid      = d.bossid;
//           lastScore           = d.score || lastScore;
//           loginDone           = true;
//           this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

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




//loveable version


// /**
//  * regular-wheel-processor.js  —  HIGH THROUGHPUT EDITION
//  *
//  * Key improvements over previous version:
//  *
//  * 1. CONTINUOUS WORKER POOL (replaces batch loop)
//  *    Instead of: process 5 → wait → process 5 → wait
//  *    Now:        maintain N workers running at all times
//  *    Effect:     no idle time between batches → 10-17x faster
//  *
//  * 2. PANDAMASTER IP BAN HANDLING
//  *    result=-1 + "disabled login function" = that proxy's exit IP is banned.
//  *    - These accounts are NOT retried (retrying wastes a slot + burns more proxies)
//  *    - Banned proxy exit IPs are tracked in memory and skipped for 10 minutes
//  *    - Account is marked as "ip_banned" in DB, skipped on next run
//  *
//  * 3. SMART RETRY — only retries CONNECTION errors, not server rejections
//  *    - result=-1 (IP ban)     → skip immediately, no retry
//  *    - result=3  (wrong pass) → skip immediately, no retry
//  *    - WS error / timeout     → retry with fresh proxy
//  *
//  * 4. STAGGERED STARTS — new workers start with 150ms offset
//  *    Prevents all workers hammering the game server in the same millisecond.
//  *
//  * THROUGHPUT TARGET:
//  *   With 20 workers + 52 proxies:
//  *   Each account ~4-7s → 20 workers → 3-5 accounts/sec → 10k-18k/hour
//  */

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
//       LOGIN_WS_URL:   'wss://pandamaster.vip:7878/',
//       GAME_VERSION:   '2.0.1',
//       ORIGIN:         'http://play.pandamaster.vip',

//       // Worker pool size — tune based on proxy count
//       // Rule: WORKERS ≤ proxy_count to ensure 1 proxy per concurrent worker
//       WORKERS:        20,

//       // FIX: Cap concurrent connections per proxy IP (prevents proxy overload)
//       PER_PROXY_LIMIT: 5,

//       // FIX: Stagger increased from 150ms → 500ms to prevent thundering herd
//       STAGGER_MS:     500,

//       // Only retry on connection/timeout errors — NOT on server rejections
//       RETRY_ATTEMPTS: 3,
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

//     this.proxyRotator = new ProxyRotator(proxyList);

//     // Cap workers to proxy count when proxies enabled — ensures 1 proxy per worker
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

//         const { account, index } = next;
//         this.stats.activeWorkers++;
//         this._emit('status', {
//           running: true, total, current: index + 1,
//           activeWorkers: this.stats.activeWorkers, currentAccount: account.username,
//         });

//         try {
//           await this._processWithRetry(account, index);
//         } catch (_) {}

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
//         // FIX: Exponential backoff with jitter before retry
//         const backoffMs = (this.config.RETRY_BACKOFF[attempt] || 8000) + Math.floor(Math.random() * 500);
//         this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (connection error) (waiting ${backoffMs}ms)`);
//         await this._sleep(backoffMs);
//       await this._sleep(this._rand(500, 1200));
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

//       this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

//       const hardTimeout = setTimeout(() => {
//         cleanup();
//         resolve({ success: wheelSpun, wheelSpun, lotteryscore, newScore: lastScore, error: 'Timeout' });
//       }, this.config.TIMEOUTS.TOTAL);

//       const cleanup = () => {
//         clearTimeout(hardTimeout);
//         try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
//       };

//       const done = (result) => {
//         if (phase === 'done') return;
//         phase = 'done';
//         cleanup();
//         resolve(result);
//       };

//       // ── Proxy selection ────────────────────────────────────────────────────
//       let agent      = null;
//       let proxyIp    = null;

//       if (this.proxyRotator.enabled) {
//         const proxyUrl = this.proxyRotator.next();
//         if (proxyUrl) {
//           // Extract IP for ban check
//           try {
//             const u = new URL(proxyUrl);
//             proxyIp = u.hostname;
//             if (isIpBanned(proxyIp)) {
//               this._log(index, 'warning', `⚠️ Proxy ${proxyIp} is banned — skipping to next`);
//               // Try to get a non-banned proxy
//               let found = false;
//               for (let t = 0; t < 5; t++) {
//                 const alt = this.proxyRotator.next();
//                 if (!alt) break;
//                 const au = new URL(alt);
//                 if (!isIpBanned(au.hostname)) {
//                   proxyIp = au.hostname;
//                   try {
//                     agent = await makeProxyAgent(alt);
//                     if (agent) {
//                       this._log(index, 'debug', `🛡️ Alt proxy: ${alt.replace(/\/\/[^@]+@/, '//*:****@')}`);
//                       found = true;
//                       break;
//                     }
//                   } catch (_) {}
//                 }
//               }
//               if (!found) {
//                 this._log(index, 'warning', `⚠️ All tried proxies banned — using direct`);
//               }
//             } else {
//               try {
//                 agent = await makeProxyAgent(proxyUrl);
//                 if (agent) {
//                   this._log(index, 'debug', `🛡️ Proxy: ${proxyUrl.replace(/\/\/[^@]+@/, '//*:****@')}`);
//                 } else {
//                   this._log(index, 'warning', `⚠️ Proxy agent failed — using direct`);
//                 }
//               } catch (err) {
//                 this._log(index, 'warning', `⚠️ Proxy error: ${err.message}`);
//               }
//             }
//           } catch (_) {
//             try { agent = await makeProxyAgent(proxyUrl); } catch (_) {}
//           }
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
//             // result=3 = wrong password → server rejection, no retry
//             const serverRejected = d.result === 3 || d.result === 2;
//             return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})` });
//           }

//           account.userid      = d.userid;
//           account.dynamicpass = d.dynamicpass;
//           account.bossid      = d.bossid;
//           lastScore           = d.score || lastScore;
//           loginDone           = true;
//           this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

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
      LOGIN_WS_URL:   'wss://pandamaster.vip:7878/',
      GAME_VERSION:   '2.0.1',
      ORIGIN:         'http://play.pandamaster.vip',

      // Worker pool size — tune based on proxy count
      // Rule: WORKERS ≤ proxy_count to ensure 1 proxy per concurrent worker
      WORKERS:        20,

      // FIX: Cap concurrent connections per proxy IP (prevents proxy overload)
      PER_PROXY_LIMIT: 5,

      // FIX: Stagger increased from 150ms → 500ms to prevent thundering herd
      STAGGER_MS:     500,

      // Only retry on connection/timeout errors — NOT on server rejections
      RETRY_ATTEMPTS: 3,
      // FIX: Exponential backoff between retries (ms)
      RETRY_BACKOFF: [1000, 3000, 8000],

      TIMEOUTS: {
        TOTAL:  35000,  // hard per-account limit
        WS:    25000,  // FIX: Increased 12s → 25s for slow SOCKS5 handshakes  // WebSocket handshake
      },

      RANDOM_DELAYS: { MIN: 300, MAX: 800 },
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

    // Pass maxPerProxy so the rotator enforces 1 concurrent connection per proxy IP
    this.proxyRotator = new ProxyRotator(proxyList, { maxPerProxy: this.config.PER_PROXY_LIMIT });

    // Workers capped to proxy_count * PER_PROXY_LIMIT (but rotator still enforces the actual limit)
    const workerCount = (useProxy && proxyList.length > 0)
      ? Math.min(this.config.WORKERS, proxyList.length * this.config.PER_PROXY_LIMIT)
      : this.config.WORKERS;

    const all = await this.db.getAllAccounts();
    this.currentAccounts = all.filter(a => accountIds.includes(a.id));

    this._emit('terminal', { type: 'info', message: `🚀 REGULAR WHEEL SPIN BOT STARTED` });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length}` });
    this._emit('terminal', { type: 'info', message: `⚡ Workers: ${workerCount} concurrent` });
    this._emit('terminal', { type: 'info', message: `🌐 Login: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🔗 Origin: ${this.config.ORIGIN}` });
    this._emit('terminal', { type: 'info', message: `🛡️ Proxy: ${this.proxyRotator.enabled ? this.proxyRotator.summary() : 'disabled (direct)'}` });
    this._emit('status', { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0 });

    this._runWorkerPool(workerCount);
    return { started: true, totalAccounts: this.currentAccounts.length };
  }

  async stopProcessing() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped by user' });
    this._emit('status', { running: false, activeWorkers: 0 });
    return { success: true };
  }

  // ── Continuous worker pool ──────────────────────────────────────────────────
  // Each worker picks the next account from a shared index and processes it.
  // When done, it immediately picks the next one — no waiting for a full batch.
  // Workers start staggered to avoid bursting the game server.

  async _runWorkerPool(workerCount) {
    const queue   = [...this.currentAccounts]; // local copy, mutated by workers
    let   queueIdx = 0;
    const total   = queue.length;

    const getNext = () => {
      if (queueIdx >= total) return null;
      return { account: queue[queueIdx], index: queueIdx++ };
    };

    const worker = async (workerId) => {
      while (this.isProcessing) {
        const next = getNext();
        if (!next) break;

        const { account, index } = next;
        this.stats.activeWorkers++;
        this._emit('status', {
          running: true, total, current: index + 1,
          activeWorkers: this.stats.activeWorkers, currentAccount: account.username,
        });

        try {
          await this._processWithRetry(account, index);
        } catch (_) {}

        this.stats.activeWorkers--;
        this.stats.processed++;

        // Emit speed stats every 10 accounts
        if (this.stats.processed % 10 === 0) {
          this._emit('terminal', {
            type: 'info',
            message: `📊 Progress: ${this.stats.processed}/${total} | ✅ ${this.stats.successCount} | ❌ ${this.stats.failCount} | 🚫 banned: ${this.stats.ipBanned} | Workers: ${this.stats.activeWorkers}`,
          });
        }
      }
    };

    // Start workers with stagger
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      await this._sleep(this.config.STAGGER_MS);
      if (!this.isProcessing) break;
      workers.push(worker(i));
    }

    await Promise.allSettled(workers);
    if (this.isProcessing) this._complete();
  }

  // ── Retry wrapper ───────────────────────────────────────────────────────────

  async _processWithRetry(account, globalIndex, attempt = 0) {
    const result = await this._accountFlow(account, globalIndex, attempt);

    // Persist result
    if (result.newScore !== undefined) {
      await this.db.updateAccount({ ...account, score: result.newScore });
    }
    await this.db.addProcessingLog(
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
        // FIX: Exponential backoff with jitter before retry
        const backoffMs = (this.config.RETRY_BACKOFF[attempt] || 8000) + Math.floor(Math.random() * 500);
        this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (connection error) (waiting ${backoffMs}ms)`);
        await this._sleep(backoffMs);
      await this._sleep(this._rand(500, 1200));
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

      if (this.proxyRotator.enabled) {
        try {
          // Skip banned proxies: try up to proxy_count times to find a clean one
          let acquired = null;
          const maxTries = Math.min(5, this.proxies ? this.proxies.length : 5);
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
                this._log(index, 'warning', `⚠️ Proxy agent failed — using direct`);
              }
            } catch (err) {
              this._log(index, 'warning', `⚠️ Proxy error: ${err.message}`);
            }
          } else {
            this._log(index, 'warning', `⚠️ All tried proxies banned — using direct`);
          }
        } catch (err) {
          this._log(index, 'warning', `⚠️ Proxy acquire failed: ${err.message} — using direct`);
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
            // result=3 = wrong password → server rejection, no retry
            const serverRejected = d.result === 3 || d.result === 2;
            return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})` });
          }

          account.userid      = d.userid;
          account.dynamicpass = d.dynamicpass;
          account.bossid      = d.bossid;
          lastScore           = d.score || lastScore;
          loginDone           = true;
          this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

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
