


// const router = require('express').Router();

// // GET /api/processing/all/status — MUST be before /:profile routes
// router.get('/all/status', (req, res) => {
//   try {
//     const profiles = req.app.get('botManager').getActiveProcessors(req.userId);
//     res.json({ success: true, profiles });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // GET /api/processing/:profile/status
// router.get('/:profile/status', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const instance = await botManager.getInstance(req.userId, req.params.profile);
//     if (!instance) return res.json({ running: false });

//     const proc = instance.processor;
//     res.json({
//       running:       proc.isProcessing,
//       wheelMode:     instance.wheelMode,
//       currentCycle:  proc.currentCycle || 0,
//       totalCycles:   proc.totalCycles  || 0,
//       activeWorkers: proc.stats?.activeWorkers || 0,
//       stats:         proc.stats || {},
//     });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/processing/:profile/start
// router.post('/:profile/start', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const {
//       repetitions = 1,
//       accountIds,
//       wheelMode = 'single',
//       gameConfig,
//       workers,
//     } = req.body;

//     const { processor, db } = await botManager.getOrCreateInstance(
//       req.userId, req.params.profile, wheelMode
//     );

//     if (processor.isProcessing) {
//       return res.status(400).json({ error: 'Already processing' });
//     }

//     // ── Apply game server config ─────────────────────────────────────────────
//     const gc = (gameConfig && typeof gameConfig === 'object') ? gameConfig : {};

//     const CONFIG_KEYS = ['LOGIN_WS_URL', 'GAME_VERSION', 'ORIGIN'];
//     for (const k of CONFIG_KEYS) {
//       if (gc[k] !== undefined && gc[k] !== null && gc[k] !== '') {
//         processor.config[k] = gc[k];
//       }
//     }

//     if (gc.noWeekendSpin !== undefined) {
//       processor.noWeekendSpin = !!gc.noWeekendSpin;
//     }

//     // ── Per-game default worker counts ───────────────────────────────────────
//     const gameId = gc.id || '';
//     let defaultWorkers = 20;
//     if (gameId === 'pandamaster')                                        defaultWorkers = 15;
//     else if (gameId === 'milkyway')                                      defaultWorkers = 25;
//     else if (gameId === 'megaspin' || gameId === 'orion' || gameId === 'firekirin') defaultWorkers = 15;

//     // ── Scale workers based on concurrent active users ───────────────────────
//     // Target max ~200 total workers across all users (safe for 2-4 CPU VPS).
//     // Formula: workerCount = min(defaultWorkers, floor(200 / activeUsers))
//     const getActiveCount = req.app.get('getActiveRunningCount');
//     const activeUsers    = getActiveCount ? getActiveCount() : 1;
//     const scaledMax      = Math.max(5, Math.floor(200 / activeUsers));
//     const workerCount    = Math.min(scaledMax, Math.min(50, Math.max(1, parseInt(workers) || defaultWorkers)));
//     processor.config.WORKERS = workerCount;

//     console.log('Active users: ' + activeUsers + ' | Workers this session: ' + workerCount + ' (default was ' + defaultWorkers + ')');
//     console.log('Game=' + gameId + ' URL=' + processor.config.LOGIN_WS_URL + ' Origin=' + processor.config.ORIGIN + ' Workers=' + workerCount);

//     // ── Proxy setup ──────────────────────────────────────────────────────────
//     const proxyConfig = db.getProxyConfig();
//     let useProxy = false, proxyList = [];
//     if (proxyConfig?.enabled) {
//       useProxy  = true;
//       proxyList = Array.isArray(proxyConfig.proxyList)
//         ? proxyConfig.proxyList
//         : (proxyConfig.proxyList || '').split('\n').filter(Boolean);
//     }

//     // ── Proxy validation with hash-based cache ───────────────────────────────
//     // Skip re-validation if the proxy list hasn't changed since last run.
//     // This prevents 500-proxy validation (25+ seconds) on every Start click.
//     const autoValidate = req.body?.autoValidateProxies !== false;
//     if (useProxy && autoValidate && proxyList.length > 0) {
//       const crypto   = require('crypto');
//       const listHash = crypto.createHash('md5').update(proxyList.join('\n')).digest('hex');
//       const saved    = db.getProxyConfig();
//       const room     = 'profile:' + req.userId + ':' + req.params.profile.replace(/[^a-zA-Z0-9_-]/g, '_');
//       const io       = req.app.get('botManager').io;

//       if (listHash === saved?.lastValidatedHash && saved?.lastValidatedAt) {
//         // Same list as last time — skip validation, use cached healthy list
//         const ageMins = Math.round((Date.now() - saved.lastValidatedAt) / 60000);
//         io.to(room).emit('bot:terminal', {
//           _profile: req.params.profile,
//           line: '✅ Proxy list unchanged — skipping re-validation (validated ' + ageMins + 'm ago)',
//         });
//         if (Array.isArray(saved.healthyList) && saved.healthyList.length > 0) {
//           proxyList = saved.healthyList;
//         }
//       } else {
//         // List changed or never validated — run validation
//         const { validateProxyList } = require('../proxyValidator');

//         io.to(room).emit('bot:terminal', {
//           _profile: req.params.profile,
//           line: '🧪 Pre-flight: validating ' + proxyList.length + ' proxies...',
//         });

//         const v = await validateProxyList(proxyList, {
//           concurrency: 15,   // reduced from 25 to lower TCP burst on shared server
//           onProgress: (done, total) => {
//             if (done % 25 === 0 || done === total) {
//               io.to(room).emit('bot:terminal', {
//                 _profile: req.params.profile,
//                 line: '🧪 Validating: ' + done + '/' + total,
//               });
//             }
//           },
//         });

//         io.to(room).emit('bot:terminal', {
//           _profile: req.params.profile,
//           line: '🧪 Done: ✅ ' + v.healthyCount + ' healthy | ❌ ' + v.deadCount + ' dead (' + v.durationMs + 'ms)',
//         });

//         if (v.healthyCount === 0) {
//           return res.status(400).json({
//             error: 'All proxies failed validation. Check your provider credentials.',
//             deadProxies: v.dead.slice(0, 10),
//           });
//         }

//         // Save healthy list + hash so next run can skip validation
//         db.saveProxyConfig({
//           enabled:           true,
//           proxyList:         v.healthy,
//           healthyList:       v.healthy,
//           lastValidatedHash: listHash,
//           lastValidatedAt:   Date.now(),
//         });
//         proxyList = v.healthy;

//         if (v.deadCount > 0) {
//           io.to(room).emit('bot:terminal', {
//             _profile: req.params.profile,
//             line: '🗑️  Removed ' + v.deadCount + ' dead proxies from saved list',
//           });
//         }
//       }
//     }

//     // ── Account IDs ──────────────────────────────────────────────────────────
//     let ids = accountIds;
//     if (!ids || ids.length === 0) {
//       ids = db.getAllAccounts().map(a => a.id);
//     }
//     if (ids.length === 0) {
//       return res.status(400).json({ error: 'No accounts found. Please add accounts first.' });
//     }

//     let result;
//     if (wheelMode === 'double') {
//       result = await processor.startProcessing(ids, repetitions, useProxy, proxyList);
//     } else {
//       result = await processor.startProcessing(ids, 1, useProxy, proxyList);
//     }

//     res.json({ success: true, wheelMode, workers: workerCount, ...result });
//   } catch (err) {
//     console.error('Start processing error:', err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // POST /api/processing/:profile/stop
// router.post('/:profile/stop', async (req, res) => {
//   try {
//     const instance = await req.app.get('botManager').getInstance(req.userId, req.params.profile);
//     if (!instance) return res.json({ success: true, message: 'Not running' });
//     const result = await instance.processor.stopProcessing();
//     res.json({ success: true, ...result });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// module.exports = router;






const router = require('express').Router();

// GET /api/processing/all/status — MUST be before /:profile routes
router.get('/all/status', (req, res) => {
  try {
    const profiles = req.app.get('botManager').getActiveProcessors(req.userId);
    res.json({ success: true, profiles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/processing/:profile/status
router.get('/:profile/status', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const instance = await botManager.getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ running: false });

    const proc = instance.processor;
    res.json({
      running:       proc.isProcessing,
      wheelMode:     instance.wheelMode,
      currentCycle:  proc.currentCycle || 0,
      totalCycles:   proc.totalCycles  || 0,
      activeWorkers: proc.stats?.activeWorkers || 0,
      stats:         proc.stats || {},
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/processing/:profile/start
router.post('/:profile/start', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const {
      repetitions = 1,
      accountIds,
      wheelMode = 'single',
      gameConfig,
      workers,
    } = req.body;

    const { processor, db } = await botManager.getOrCreateInstance(
      req.userId, req.params.profile, wheelMode
    );

    if (processor.isProcessing) {
      return res.status(400).json({ error: 'Already processing' });
    }

    // ── Apply game server config ─────────────────────────────────────────────
    const gc = (gameConfig && typeof gameConfig === 'object') ? gameConfig : {};

    const CONFIG_KEYS = ['LOGIN_WS_URL', 'GAME_VERSION', 'ORIGIN'];
    for (const k of CONFIG_KEYS) {
      if (gc[k] !== undefined && gc[k] !== null && gc[k] !== '') {
        processor.config[k] = gc[k];
      }
    }

    if (gc.noWeekendSpin !== undefined) {
      processor.noWeekendSpin = !!gc.noWeekendSpin;
    }

    // ── Per-game default worker counts ───────────────────────────────────────
    const gameId = gc.id || '';
    let defaultWorkers = 20;
    if (gameId === 'pandamaster')                                        defaultWorkers = 15;
    else if (gameId === 'milkyway')                                      defaultWorkers = 25;
    else if (gameId === 'megaspin' || gameId === 'orion' || gameId === 'firekirin') defaultWorkers = 15;

    // ── Worker count: pass through to processor, let _getWorkersForUser() scale ─
    // DO NOT scale here — the processor already scales fairly via _runningProcessors Set.
    // Double scaling (here AND in processor) was the bug causing Workers:11 with 18 users.
    const workerCount = Math.min(100, Math.max(1, parseInt(workers) || defaultWorkers));
    processor.config.WORKERS = workerCount;

    console.log('Game=' + gameId + ' URL=' + processor.config.LOGIN_WS_URL + ' Workers-requested=' + workerCount);

    // ── Proxy setup ──────────────────────────────────────────────────────────
    const proxyConfig = db.getProxyConfig();
    let useProxy = false, proxyList = [];
    if (proxyConfig?.enabled) {
      useProxy  = true;
      proxyList = Array.isArray(proxyConfig.proxyList)
        ? proxyConfig.proxyList
        : (proxyConfig.proxyList || '').split('\n').filter(Boolean);
    }

    // ── Proxy validation with hash-based cache ───────────────────────────────
    // Skip re-validation if the proxy list hasn't changed since last run.
    // This prevents 500-proxy validation (25+ seconds) on every Start click.
    const autoValidate = req.body?.autoValidateProxies !== false;
    if (useProxy && autoValidate && proxyList.length > 0) {
      const crypto   = require('crypto');
      const listHash = crypto.createHash('md5').update(proxyList.join('\n')).digest('hex');
      const saved    = db.getProxyConfig();
      const room     = 'profile:' + req.userId + ':' + req.params.profile.replace(/[^a-zA-Z0-9_-]/g, '_');
      const io       = req.app.get('botManager').io;

      if (listHash === saved?.lastValidatedHash && saved?.lastValidatedAt) {
        // Same list as last time — skip validation, use cached healthy list
        const ageMins = Math.round((Date.now() - saved.lastValidatedAt) / 60000);
        io.to(room).emit('bot:terminal', {
          _profile: req.params.profile,
          line: '✅ Proxy list unchanged — skipping re-validation (validated ' + ageMins + 'm ago)',
        });
        if (Array.isArray(saved.healthyList) && saved.healthyList.length > 0) {
          proxyList = saved.healthyList;
        }
      } else {
        // List changed or never validated — run validation
        const { validateProxyList } = require('../proxyValidator');

        io.to(room).emit('bot:terminal', {
          _profile: req.params.profile,
          line: '🧪 Pre-flight: validating ' + proxyList.length + ' proxies...',
        });

        const v = await validateProxyList(proxyList, {
          concurrency: 15,   // reduced from 25 to lower TCP burst on shared server
          onProgress: (done, total) => {
            if (done % 25 === 0 || done === total) {
              io.to(room).emit('bot:terminal', {
                _profile: req.params.profile,
                line: '🧪 Validating: ' + done + '/' + total,
              });
            }
          },
        });

        io.to(room).emit('bot:terminal', {
          _profile: req.params.profile,
          line: '🧪 Done: ✅ ' + v.healthyCount + ' healthy | ❌ ' + v.deadCount + ' dead (' + v.durationMs + 'ms)',
        });

        if (v.healthyCount === 0) {
          return res.status(400).json({
            error: 'All proxies failed validation. Check your provider credentials.',
            deadProxies: v.dead.slice(0, 10),
          });
        }

        // Save healthy list + hash so next run can skip validation
        db.saveProxyConfig({
          enabled:           true,
          proxyList:         v.healthy,
          healthyList:       v.healthy,
          lastValidatedHash: listHash,
          lastValidatedAt:   Date.now(),
        });
        proxyList = v.healthy;

        if (v.deadCount > 0) {
          io.to(room).emit('bot:terminal', {
            _profile: req.params.profile,
            line: '🗑️  Removed ' + v.deadCount + ' dead proxies from saved list',
          });
        }
      }
    }

    // ── Account IDs ──────────────────────────────────────────────────────────
    let ids = accountIds;
    if (!ids || ids.length === 0) {
      ids = db.getAllAccounts().map(a => a.id);
    }
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No accounts found. Please add accounts first.' });
    }

    let result;
    if (wheelMode === 'double') {
      result = await processor.startProcessing(ids, repetitions, useProxy, proxyList);
    } else {
      result = await processor.startProcessing(ids, 1, useProxy, proxyList);
    }

    res.json({ success: true, wheelMode, workers: workerCount, ...result });
  } catch (err) {
    console.error('Start processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:profile/stop
router.post('/:profile/stop', async (req, res) => {
  try {
    const instance = await req.app.get('botManager').getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ success: true, message: 'Not running' });
    const result = await instance.processor.stopProcessing();
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
