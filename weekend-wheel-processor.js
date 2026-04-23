

/**
 * weekend-wheel-processor.js  —  HIGH THROUGHPUT EDITION
 *
 * Same architecture as regular-wheel-processor (continuous worker pool)
 * plus the full regular+weekend spin state machine.
 *
 * PandaMaster IP ban handling is identical to regular-wheel-processor.
 * The bannedIpCache is shared between both processors (module-level).
 */

const WebSocket    = require('ws');
const EventEmitter = require('events');
const { makeProxyAgent, ProxyRotator } = require('./proxyUtils');

// Shared with regular-wheel-processor if both are loaded in the same process
const bannedIpCache  = new Map();
const BAN_COOLDOWN_MS = 10 * 60 * 1000;

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

function extractBannedIp(msg) {
  if (!msg) return null;
  const m = String(msg).match(/\((\d+\.\d+\.\d+\.\d+)\)/);
  return m ? m[1] : null;
}

class WeekendWheelProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.db              = db;
    this.isProcessing    = false;
    this.currentAccounts = [];
    this.proxyRotator    = new ProxyRotator([]);
    this.instanceId      = 'default';
    this.noWeekendSpin   = false;
    this.totalCycles     = 1;
    this.currentCycle    = 0;

    this.stats = {
      successCount:      0,
      failCount:         0,
      ipBanned:          0,
      regularWheelSpins: 0,
      weekendWheelSpins: 0,
      totalScoreWon:     0,
      activeWorkers:     0,
      cyclesCompleted:   0,
      processed:         0,
    };

    this.config = {
      LOGIN_WS_URL:   'wss://pandamaster.vip:7878/',
      GAME_VERSION:   '2.0.1',
      ORIGIN:         'http://play.pandamaster.vip',

      // With 500 proxies @ 3000 concurrent limit: safe to run 50-200 workers
      // Each worker uses 1 proxy slot. 50 workers = 10% of proxy pool used.
      WORKERS:        50,

      // 1 connection per proxy IP = zero saturation risk
      PER_PROXY_LIMIT: 1,

      // FIX: Stagger increased from 150ms → 500ms to prevent thundering herd
      STAGGER_MS:     500,
      RETRY_ATTEMPTS: 3,
      // FIX: Exponential backoff between retries (ms)
      RETRY_BACKOFF: [1000, 3000, 8000],

      TIMEOUTS: {
        TOTAL: 45000,
        WS:    25000,  // FIX: Increased 12s → 25s for slow SOCKS5 handshakes
      },

      CYCLE_DELAY: { MIN: 2000, MAX: 5000 },
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

    this.isProcessing  = true;
    this.totalCycles   = Math.max(1, Math.min(100, parseInt(repetitions) || 1));
    this.currentCycle  = 0;

    this.stats = {
      successCount: 0, failCount: 0, ipBanned: 0,
      regularWheelSpins: 0, weekendWheelSpins: 0,
      totalScoreWon: 0, activeWorkers: 0, cyclesCompleted: 0, processed: 0,
    };

    this.proxyRotator = new ProxyRotator(proxyList, { maxPerProxy: this.config.PER_PROXY_LIMIT });

    const workerCount = (useProxy && proxyList.length > 0)
      ? Math.min(this.config.WORKERS, proxyList.length * this.config.PER_PROXY_LIMIT)
      : this.config.WORKERS;

    const all = await this.db.getAllAccounts();
    this.currentAccounts = all.filter(a => accountIds.includes(a.id));

    const spinMode = this.noWeekendSpin ? 'Regular only' : 'Regular + Weekend';
    this._emit('terminal', { type: 'info', message: `🚀 WEEKEND WHEEL SPIN BOT STARTED` });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length} | Cycles: ${this.totalCycles}` });
    this._emit('terminal', { type: 'info', message: `⚡ Workers: ${workerCount} concurrent` });
    this._emit('terminal', { type: 'info', message: `🎯 Strategy: ${spinMode}` });
    this._emit('terminal', { type: 'info', message: `🌐 Login: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🔗 Origin: ${this.config.ORIGIN}` });
    this._emit('terminal', { type: 'info', message: `🛡️ Proxy: ${this.proxyRotator.enabled ? this.proxyRotator.summary() : 'disabled (direct)'}` });
    this._emit('status', { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0, currentCycle: 0, totalCycles: this.totalCycles });

    this._runCycles(workerCount);
    return { started: true, totalAccounts: this.currentAccounts.length, totalCycles: this.totalCycles };
  }

  async stopProcessing() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped by user' });
    this._emit('status', { running: false, activeWorkers: 0 });
    return { success: true };
  }

  // ── Cycle loop ──────────────────────────────────────────────────────────────

  async _runCycles(workerCount) {
    while (this.isProcessing && this.currentCycle < this.totalCycles) {
      this.currentCycle++;
      this.stats.processed = 0;

      const sep = '─'.repeat(55);
      this._emit('terminal', { type: 'info', message: `\n${sep}\n🔄 CYCLE ${this.currentCycle}/${this.totalCycles}\n${sep}` });
      this._emit('cycleStart', { cycle: this.currentCycle, totalCycles: this.totalCycles, accountCount: this.currentAccounts.length });

      await this._runWorkerPool(workerCount);

      this.stats.cyclesCompleted = this.currentCycle;
      this._emit('cycleUpdate', { ...this.stats, cyclesCompleted: this.currentCycle, totalCycles: this.totalCycles });
      this._emit('terminal', { type: 'success',
        message: `✅ Cycle ${this.currentCycle} done | Regular: ${this.stats.regularWheelSpins} | Weekend: ${this.stats.weekendWheelSpins} | Score: ${this.stats.totalScoreWon}` });

      if (this.isProcessing && this.currentCycle < this.totalCycles) {
        const delay = this._rand(this.config.CYCLE_DELAY.MIN, this.config.CYCLE_DELAY.MAX);
        this._emit('terminal', { type: 'info', message: `⏳ Next cycle in ${delay}ms...` });
        await this._sleep(delay);
      }
    }
    this._complete();
  }

  // ── Continuous worker pool ──────────────────────────────────────────────────

  async _runWorkerPool(workerCount) {
    const queue   = [...this.currentAccounts];
    let   queueIdx = 0;
    const total   = queue.length;

    const getNext = () => {
      if (queueIdx >= total) return null;
      return { account: queue[queueIdx], index: queueIdx++ };
    };

    const worker = async () => {
      while (this.isProcessing) {
        const next = getNext();
        if (!next) break;

        const { account, index } = next;
        this.stats.activeWorkers++;
        this._emit('status', {
          running: true, total, current: index + 1,
          activeWorkers: this.stats.activeWorkers,
          currentAccount: account.username,
          currentCycle: this.currentCycle, totalCycles: this.totalCycles,
        });

        try {
          await this._processWithRetry(account, index);
        } catch (_) {}

        this.stats.activeWorkers--;
        this.stats.processed++;

        if (this.stats.processed % 10 === 0) {
          this._emit('terminal', {
            type: 'info',
            message: `📊 [C${this.currentCycle}] ${this.stats.processed}/${total} | ✅ ${this.stats.successCount} | ❌ ${this.stats.failCount} | 🚫 ${this.stats.ipBanned} | Workers: ${this.stats.activeWorkers}`,
          });
        }
      }
    };

    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      await this._sleep(this.config.STAGGER_MS);
      if (!this.isProcessing) break;
      workers.push(worker());
    }

    await Promise.allSettled(workers);
  }

  // ── Retry wrapper ───────────────────────────────────────────────────────────

  async _processWithRetry(account, globalIndex, attempt = 0) {
    const result = await this._accountFlow(account, globalIndex, attempt);

    if (result.newScore !== undefined) {
      await this.db.updateAccount({ ...account, score: result.newScore });
    }
    await this.db.addProcessingLog(
      account.id,
      result.success ? 'success' : (result.ipBanned ? 'ip_banned' : 'error'),
      result.success
        ? `R:${result.regularSpun ? '✓' : '✗'} W:${result.weekendSpun ? '✓' : '✗'} +${result.totalScoreWon || 0}`
        : result.error,
      result
    );

    if (result.ipBanned || result.serverRejected) {
      if (result.ipBanned) this.stats.ipBanned++;
      else this.stats.failCount++;
      return result;
    }

    if (!result.success && attempt < this.config.RETRY_ATTEMPTS) {
        // Exponential backoff with jitter before retry
        const backoffMs = (this.config.RETRY_BACKOFF[attempt] || 8000) + Math.floor(Math.random() * 500);
        this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS} (waiting ${backoffMs}ms)`);
        await this._sleep(backoffMs);
      return this._processWithRetry(account, globalIndex, attempt + 1);
    }

    if (result.success) {
      this.stats.successCount++;
      if (result.regularSpun)   this.stats.regularWheelSpins++;
      if (result.weekendSpun)   this.stats.weekendWheelSpins++;
      if (result.totalScoreWon) this.stats.totalScoreWon += result.totalScoreWon;
    } else {
      this.stats.failCount++;
    }

    this._emit('progress', {
      index: globalIndex, total: this.currentAccounts.length,
      account: account.username, success: result.success,
      stats: { ...this.stats },
    });
    this._emit('wheelStats', { ...this.stats });

    return result;
  }

  // ── Core account flow ───────────────────────────────────────────────────────

  _accountFlow(account, index, attempt = 0) {
    return new Promise(async (resolve) => {
      let ws    = null;
      let phase = 'login';

      let loginDone     = false;
      let regularSpun   = false;
      let weekendSpun   = false;
      let totalScoreWon = 0;
      let lastScore     = account.score || 0;

      this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

      const hardTimeout = setTimeout(() => {
        cleanup();
        resolve({ success: regularSpun || weekendSpun, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore, error: 'Timeout' });
      }, this.config.TIMEOUTS.TOTAL);

      const cleanup = () => {
        clearTimeout(hardTimeout);
        try { if (ws && ws.readyState <= 1) ws.terminate(); } catch (_) {}
        if (_proxyRelease) { try { _proxyRelease(); } catch (_) {} _proxyRelease = null; }
      };

      const done = (result) => {
        if (phase === 'done') return;
        phase = 'done';
        cleanup();
        resolve(result);
      };

      // ── Proxy selection — SECURITY: abort if proxy fails, never expose server IP ──
      let agent = null;
      let _proxyRelease = null;

      if (this.proxyRotator.enabled) {
        try {
          let acquired = null;
          for (let t = 0; t <= 5; t++) {
            const a = await this.proxyRotator.acquire();
            if (!a.proxyUrl) { acquired = a; break; }
            let banned = false;
            try { const u = new URL(a.proxyUrl); if (isIpBanned(u.hostname)) banned = true; } catch (_) {}
            if (!banned) { acquired = a; break; }
            this._log(index, 'warning', 'Proxy IP banned, trying next...');
            a.release();
          }
          if (acquired && acquired.proxyUrl) {
            _proxyRelease = acquired.release;
            try {
              agent = await makeProxyAgent(acquired.proxyUrl);
              if (agent) {
                this._log(index, 'debug', 'Proxy: ' + acquired.proxyUrl.replace(/\/\/[^@]+@/, '//*:****@'));
              } else {
                this._log(index, 'error', '❌ Proxy agent failed — aborting (IP protection)');
                return done({ success: false, error: 'Proxy agent failed', regularSpun: false, weekendSpun: false, totalScoreWon: 0 });
              }
            } catch (err) {
              this._log(index, 'error', '❌ Proxy error: ' + err.message + ' — aborting (IP protection)');
              return done({ success: false, error: 'Proxy error: ' + err.message, regularSpun: false, weekendSpun: false, totalScoreWon: 0 });
            }
          } else {
            this._log(index, 'error', '❌ All proxies banned — aborting (IP protection)');
            return done({ success: false, error: 'All proxies banned', regularSpun: false, weekendSpun: false, totalScoreWon: 0 });
          }
        } catch (proxyErr) {
          this._log(index, 'error', '❌ Proxy acquire failed: ' + proxyErr.message + ' — aborting (IP protection)');
          return done({ success: false, error: 'Proxy acquire failed: ' + proxyErr.message, regularSpun: false, weekendSpun: false, totalScoreWon: 0 });
        }
      }

      const wsOptions = {
        handshakeTimeout: this.config.TIMEOUTS.WS,
        headers: { 'User-Agent': this._userAgent(), 'Origin': this.config.ORIGIN },
      };
      if (agent) wsOptions.agent = agent;

      try {
        ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
      } catch (err) {
        return resolve({ success: false, error: `WS create: ${err.message}`, regularSpun, weekendSpun, totalScoreWon });
      }

      ws.on('open', () => {
        this._log(index, 'success', `✅ Connected`);
        ws.send(JSON.stringify({
          account: account.username, password: account.password,
          version: this.config.GAME_VERSION, mainID: 100, subID: 6,
        }));
      });

      ws.on('message', (raw) => {
        if (phase === 'done') return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        this._log(index, 'debug', `📩 mainID:${msg.mainID} subID:${msg.subID} phase:${phase}`);

        // ── Login (subID:116) ───────────────────────────────────────────────
        if (msg.subID === 116 && !loginDone) {
          const d = msg.data || {};

          if (d.result === -1) {
            const bannedIp = extractBannedIp(d.msg);
            if (bannedIp) recordBannedIp(bannedIp);
            this._log(index, 'error', `❌ IP BANNED: ${d.msg}`);
            return done({ success: false, ipBanned: true, bannedIp, error: d.msg, regularSpun, weekendSpun, totalScoreWon });
          }

          if (!d.userid || !d.dynamicpass) {
            const serverRejected = d.result !== 0;
            this._log(index, 'error', `❌ Login failed — result=${d.result} msg="${d.msg || ''}"`);
            return done({ success: false, serverRejected, error: `Login rejected (result:${d.result})`, regularSpun, weekendSpun, totalScoreWon });
          }

          account.userid      = d.userid;
          account.dynamicpass = d.dynamicpass;
          account.bossid      = d.bossid;
          lastScore           = d.score !== undefined ? d.score : lastScore;
          loginDone           = true;
          this._log(index, 'success', `✅ Logged in: ${d.nickname || account.username} | score: ${lastScore}`);

          phase = 'check';
          ws.send(JSON.stringify({ userid: account.userid, password: account.password, mainID: 100, subID: 26 }));
          return;
        }

        // ── Availability (subID:142) ────────────────────────────────────────
        if (msg.subID === 142) {
          const d = msg.data || {};
          if (d.dynamicpass) account.dynamicpass = d.dynamicpass;
          if (d.score !== undefined) lastScore = d.score;

          const regularAvail = d.blottery === 1;
          const weekendAvail = d.blotteryhappyweek === 1;
          this._log(index, 'info', `🎡 Regular:${regularAvail} Weekend:${weekendAvail} [${phase}]`);

          if (phase === 'check') {
            if (regularAvail) {
              phase = 'spin_regular';
              ws.send(JSON.stringify({ userid: account.userid, dynamicpass: account.dynamicpass, mainID: 100, subID: 16 }));
            } else if (!this.noWeekendSpin && weekendAvail) {
              phase = 'spin_weekend';
              ws.send(JSON.stringify({ userid: account.userid, dynamicpass: account.dynamicpass, mainID: 100, subID: 27 }));
            } else {
              this._log(index, 'warning', `⚠️ No wheels available`);
              return done({ success: true, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore, message: 'No wheels' });
            }
            return;
          }

          if (phase === 'check_weekend') {
            if (!this.noWeekendSpin && weekendAvail) {
              phase = 'spin_weekend';
              ws.send(JSON.stringify({ userid: account.userid, dynamicpass: account.dynamicpass, mainID: 100, subID: 27 }));
            } else {
              return done({ success: true, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore });
            }
            return;
          }
          return;
        }

        // ── Regular spin result (subID:131) ────────────────────────────────
        if (msg.subID === 131 && phase === 'spin_regular') {
          const d = msg.data || {};
          regularSpun = true;
          const won = d.lotteryscore || 0;
          lastScore     = d.score !== undefined ? d.score : lastScore;
          totalScoreWon += won;

          if (d.result === 0) this._log(index, 'success', `🎉 Regular: +${won} → ${lastScore}`);
          else this._log(index, 'warning', `⚠️ Regular result=${d.result}`);

          if (this.noWeekendSpin) {
            return setTimeout(() => done({ success: true, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore }), 300);
          }

          phase = 'check_weekend';
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN && phase !== 'done') {
              ws.send(JSON.stringify({ userid: account.userid, password: account.password, mainID: 100, subID: 26 }));
            }
          }, 500);
          return;
        }

        // ── Weekend spin result (subID:143) ────────────────────────────────
        if (msg.subID === 143 && phase === 'spin_weekend') {
          const d = msg.data || {};
          weekendSpun = true;
          const won = d.lotteryscore || 0;
          lastScore     = d.score !== undefined ? d.score : lastScore;
          totalScoreWon += won;

          if (d.result === 0) this._log(index, 'success', `🎉 Weekend: +${won} → ${lastScore}`);
          else this._log(index, 'warning', `⚠️ Weekend result=${d.result}`);

          setTimeout(() => done({ success: true, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore }), 300);
          return;
        }
      });

      ws.on('error', (err) => {
        this._log(index, 'error', `❌ WS error: ${err.message}`);
        done({ success: false, error: err.message, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore });
      });

      ws.on('close', (code) => {
        if (phase !== 'done') {
          done({ success: regularSpun || weekendSpun, regularSpun, weekendSpun, totalScoreWon, newScore: lastScore });
        }
      });
    });
  }

  // ── Completion ──────────────────────────────────────────────────────────────

  _complete() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'success', message: `\n🎉 ALL PROCESSING COMPLETED!` });
    this._emit('terminal', { type: 'info',    message: `📈 Success: ${this.stats.successCount} | Failed: ${this.stats.failCount} | IP Banned: ${this.stats.ipBanned}` });
    this._emit('terminal', { type: 'info',    message: `🎡 Regular: ${this.stats.regularWheelSpins} | Weekend: ${this.stats.weekendWheelSpins} | Score: ${this.stats.totalScoreWon}` });
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

module.exports = WeekendWheelProcessor;
