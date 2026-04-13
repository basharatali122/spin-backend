const path     = require('path');
const fs       = require('fs');
const Database = require('./database/database');
const RegularWheelProcessor = require('./regular-wheel-processor');
const WeekendWheelProcessor  = require('./weekend-wheel-processor');

class BotManager {
  constructor(io) {
    this.io        = io;
    this.instances = new Map();
  }

  _key(userId, profileName) {
    return `${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _room(userId, profileName) {
    return `profile:${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _dataDir(userId, profileName) {
    const base = process.env.DATA_DIR || './data';
    const dir  = path.join(base, userId, profileName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _createProcessor(wheelMode, db) {
    const Cls  = wheelMode === 'double' ? WeekendWheelProcessor : RegularWheelProcessor;
    const proc = new Cls(db);

    // Wrap db methods so they always return Promises regardless of DB implementation
    proc.db = {
      getAllAccounts:   ()            => Promise.resolve(db.getAllAccounts()),
      updateAccount:   (acc)         => Promise.resolve(db.updateAccount(acc)),
      addProcessingLog:(id, s, m, d) => Promise.resolve(db.addProcessingLog(id, s, m, d)),
    };

    return proc;
  }

  async getOrCreateInstance(userId, profileName, wheelMode = 'single') {
    const key = this._key(userId, profileName);

    if (this.instances.has(key)) {
      const existing = this.instances.get(key);

      // If wheelMode changed and not currently running → destroy and recreate
      if (existing.wheelMode !== wheelMode && !existing.processor.isProcessing) {
        await this.destroyInstance(userId, profileName);
      } else {
        // Reuse existing instance — it already has event listeners bound
        return existing;
      }
    }

    const dbPath = path.join(this._dataDir(userId, profileName), 'accounts.db');
    const db     = new Database(dbPath);
    await db.init();

    const processor = this._createProcessor(wheelMode, db);
    processor.instanceId = `${userId.substring(0, 8)}_${profileName}`;

    const room = this._room(userId, profileName);

    // Emit to room — include _profile so the frontend can filter by profile
    const emit = (event, data) =>
      this.io.to(room).emit(event, { ...data, _profile: profileName });

    // Map processor events → socket events
    // These are the ONLY listeners added — no duplicates possible
    const eventMap = {
      terminal:    'bot:terminal',
      status:      'bot:status',
      progress:    'bot:progress',
      completed:   'bot:completed',
      cycleStart:  'bot:cycleStart',
      cycleUpdate: 'bot:cycleUpdate',
      wheelStats:  'bot:wheelStats',
      betUpdate:   'bot:betUpdate',
    };

    const boundHandlers = {};
    for (const [ev, socketEv] of Object.entries(eventMap)) {
      boundHandlers[ev] = (data) => emit(socketEv, data);
      processor.on(ev, boundHandlers[ev]);
    }

    const instance = {
      processor,
      db,
      boundHandlers,
      room,
      wheelMode,
      createdAt: Date.now(),
    };

    this.instances.set(key, instance);
    console.log(`🤖 [${key}] instance created | mode:${wheelMode} | db:${dbPath}`);
    return instance;
  }

  async getInstance(userId, profileName) {
    return this.instances.get(this._key(userId, profileName)) || null;
  }

  async destroyInstance(userId, profileName) {
    const key      = this._key(userId, profileName);
    const instance = this.instances.get(key);
    if (!instance) return;

    // Stop if running
    try { if (instance.processor.isProcessing) await instance.processor.stopProcessing(); } catch (_) {}

    // Remove all bound listeners to prevent accumulation
    for (const [ev, handler] of Object.entries(instance.boundHandlers)) {
      try { instance.processor.off(ev, handler); } catch (_) {}
    }
    instance.processor.removeAllListeners();

    // Close DB
    try { instance.db.close(); } catch (_) {}

    this.instances.delete(key);
    console.log(`🗑️  [${key}] instance destroyed`);
  }

  getActiveProcessors(userId) {
    const result = [];
    for (const [key, inst] of this.instances.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      const profileName = key.substring(userId.length + 1);
      result.push({
        profileName,
        isRunning:    inst.processor.isProcessing,
        wheelMode:    inst.wheelMode,
        currentCycle: inst.processor.currentCycle || 0,
        totalCycles:  inst.processor.totalCycles  || 0,
        accountCount: inst.db.getAccountCount ? inst.db.getAccountCount() : 0,
      });
    }
    return result;
  }

  getServerStats() {
    let totalInstances = 0, totalRunning = 0;
    for (const inst of this.instances.values()) {
      totalInstances++;
      if (inst.processor.isProcessing) totalRunning++;
    }
    return { totalInstances, totalRunning };
  }

  async shutdownAll() {
    const keys = [...this.instances.keys()];
    await Promise.allSettled(keys.map(key => {
      const [userId, ...rest] = key.split(':');
      return this.destroyInstance(userId, rest.join(':'));
    }));
  }
}

module.exports = BotManager;
