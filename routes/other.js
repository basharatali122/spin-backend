// const { normalizeProxy, parseProxyList, testProxy } = require('../proxyUtils');

// // ── Proxy Routes ─────────────────────────────────────────────────────────────
// const proxyRouter = require('express').Router();

// // GET /api/proxy/:profile — load saved config
// proxyRouter.get('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
//     res.json({ config: db.getProxyConfig() || { enabled: false, proxyList: [] } });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile — save config
// // Normalizes all proxy entries before saving so the DB always holds clean URLs.
// proxyRouter.post('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

//     const body = req.body || {};

//     // Normalize the proxy list — converts all raw formats to socks5h:// etc.
//     let proxyList = body.proxyList || [];
//     if (typeof proxyList === 'string') proxyList = proxyList.split('\n');
//     const normalized = parseProxyList(proxyList.join('\n'));

//     db.saveProxyConfig({ enabled: !!body.enabled, proxyList: normalized });

//     res.json({
//       success: true,
//       saved:   normalized.length,
//       message: `Saved ${normalized.length} proxies`,
//     });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile/normalize — preview normalized format without saving
// proxyRouter.post('/:profile/normalize', (req, res) => {
//   try {
//     const raw   = req.body.proxyList || '';
//     const lines = typeof raw === 'string' ? raw : raw.join('\n');
//     const normalized = parseProxyList(lines);
//     res.json({ success: true, normalized, count: normalized.length });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile/test — LIVE test through actual proxy connection
// proxyRouter.post('/:profile/test', async (req, res) => {
//   try {
//     const { proxyUrl } = req.body;
//     if (!proxyUrl) return res.status(400).json({ error: 'No proxy URL provided' });

//     const normalized = normalizeProxy(proxyUrl);
//     if (!normalized) {
//       return res.json({
//         success: false,
//         message: `Cannot parse proxy format. Supported:\n  socks5h://user:pass@host:port\n  socks5://user:pass@host:port\n  http://user:pass@host:port\n  user:pass@host:port\n  host:port:user:pass\n\nReceived: ${proxyUrl}`,
//       });
//     }

//     const result = await testProxy(normalized);
//     res.json(result);
//   } catch (err) {
//     res.json({ success: false, message: `Test error: ${err.message}` });
//   }
// });

// module.exports.proxyRouter = proxyRouter;

// // ── Stats Routes ──────────────────────────────────────────────────────────────
// const statsRouter = require('express').Router();

// statsRouter.get('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
//     const totals = db.getStatsTotals();
//     res.json({ totals });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// module.exports.statsRouter = statsRouter;





//loveable version 




// const { normalizeProxy, parseProxyList, testProxy } = require('../proxyUtils');
// const { validateProxyList } = require('../proxyValidator');

// // ── Proxy Routes ─────────────────────────────────────────────────────────────
// const proxyRouter = require('express').Router();

// // GET /api/proxy/:profile — load saved config
// proxyRouter.get('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
//     res.json({ config: db.getProxyConfig() || { enabled: false, proxyList: [] } });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile — save config
// proxyRouter.post('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

//     const body = req.body || {};
//     let proxyList = body.proxyList || [];
//     if (typeof proxyList === 'string') proxyList = proxyList.split('\n');
//     const normalized = parseProxyList(proxyList.join('\n'));

//     db.saveProxyConfig({ enabled: !!body.enabled, proxyList: normalized });

//     res.json({
//       success: true,
//       saved:   normalized.length,
//       message: `Saved ${normalized.length} proxies`,
//     });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile/normalize
// proxyRouter.post('/:profile/normalize', (req, res) => {
//   try {
//     const raw   = req.body.proxyList || '';
//     const lines = typeof raw === 'string' ? raw : raw.join('\n');
//     const normalized = parseProxyList(lines);
//     res.json({ success: true, normalized, count: normalized.length });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/proxy/:profile/test — single proxy live test
// proxyRouter.post('/:profile/test', async (req, res) => {
//   try {
//     const { proxyUrl } = req.body;
//     if (!proxyUrl) return res.status(400).json({ error: 'No proxy URL provided' });

//     const normalized = normalizeProxy(proxyUrl);
//     if (!normalized) {
//       return res.json({
//         success: false,
//         message: `Cannot parse proxy format. Received: ${proxyUrl}`,
//       });
//     }

//     const result = await testProxy(normalized);
//     res.json(result);
//   } catch (err) {
//     res.json({ success: false, message: `Test error: ${err.message}` });
//   }
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // POST /api/proxy/:profile/validate-all
// //   Tests every proxy currently saved (or supplied in body.proxyList) in
// //   parallel. Streams progress back over Socket.IO ("proxy:validate:progress")
// //   so the UI can show a live progress bar. Returns split healthy/dead.
// //
// //   Body (optional):
// //     { proxyList: [...], concurrency: 20, autoClean: true }
// //
// //   When autoClean=true, the saved proxy list is overwritten with ONLY the
// //   healthy proxies — guaranteeing the next "Start" run uses a clean pool.
// // ─────────────────────────────────────────────────────────────────────────────
// proxyRouter.post('/:profile/validate-all', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

//     // Source list: body override, else saved config
//     let source = req.body?.proxyList;
//     if (!source || (Array.isArray(source) && source.length === 0)) {
//       const cfg = db.getProxyConfig();
//       source = cfg?.proxyList || [];
//     }
//     if (typeof source === 'string') source = source.split('\n');
//     const list = parseProxyList(source.join('\n'));

//     if (list.length === 0) {
//       return res.json({ success: false, error: 'No proxies to validate' });
//     }

//     const concurrency = Math.max(1, Math.min(50, parseInt(req.body?.concurrency) || 20));
//     const autoClean   = req.body?.autoClean !== false; // default ON

//     const room = `profile:${req.userId}:${req.params.profile.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
//     const io   = req.app.get('botManager').io;

//     io.to(room).emit('proxy:validate:start', {
//       _profile: req.params.profile,
//       total: list.length,
//       concurrency,
//     });

//     const result = await validateProxyList(list, {
//       concurrency,
//       onProgress: (done, total, last) => {
//         io.to(room).emit('proxy:validate:progress', {
//           _profile: req.params.profile,
//           done, total,
//           last,
//         });
//       },
//     });

//     // Auto-clean: persist only healthy proxies
//     let cleaned = false;
//     if (autoClean && result.healthy.length > 0) {
//       const cfg = db.getProxyConfig() || {};
//       db.saveProxyConfig({
//         enabled:   cfg.enabled !== false,
//         proxyList: result.healthy,
//       });
//       cleaned = true;
//     }

//     io.to(room).emit('proxy:validate:done', {
//       _profile: req.params.profile,
//       ...result,
//       cleaned,
//     });

//     res.json({
//       success: true,
//       ...result,
//       cleaned,
//       message: `Tested ${result.total} | ✅ ${result.healthyCount} healthy | ❌ ${result.deadCount} dead${cleaned ? ' (auto-cleaned)' : ''}`,
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// module.exports.proxyRouter = proxyRouter;

// // ── Stats Routes ──────────────────────────────────────────────────────────────
// const statsRouter = require('express').Router();

// statsRouter.get('/:profile', async (req, res) => {
//   try {
//     const botManager = req.app.get('botManager');
//     const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
//     const totals = db.getStatsTotals();
//     res.json({ totals });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// module.exports.statsRouter = statsRouter;




// claude version  



const { normalizeProxy, parseProxyList, testProxy } = require('../proxyUtils');
const { validateProxyList } = require('../proxyValidator');

// ── Proxy Routes ─────────────────────────────────────────────────────────────
const proxyRouter = require('express').Router();

// GET /api/proxy/:profile — load saved config
proxyRouter.get('/:profile', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
    res.json({ config: db.getProxyConfig() || { enabled: false, proxyList: [] } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/proxy/:profile/normalize
proxyRouter.post('/:profile/normalize', (req, res) => {
  try {
    const raw   = req.body.proxyList || '';
    const lines = typeof raw === 'string' ? raw : raw.join('\n');
    const normalized = parseProxyList(lines);
    res.json({ success: true, normalized, count: normalized.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/proxy/:profile/test
proxyRouter.post('/:profile/test', async (req, res) => {
  try {
    const { proxyUrl } = req.body;
    if (!proxyUrl) return res.status(400).json({ error: 'No proxy URL provided' });
    const normalized = normalizeProxy(proxyUrl);
    if (!normalized) {
      return res.json({ success: false, message: `Cannot parse proxy format. Received: ${proxyUrl}` });
    }
    const result = await testProxy(normalized);
    res.json(result);
  } catch (err) {
    res.json({ success: false, message: `Test error: ${err.message}` });
  }
});

// POST /api/proxy/:profile/validate-all
proxyRouter.post('/:profile/validate-all', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

    let source = req.body?.proxyList;
    if (!source || (Array.isArray(source) && source.length === 0)) {
      const cfg = db.getProxyConfig();
      source = cfg?.proxyList || [];
    }
    if (typeof source === 'string') source = source.split('\n');
    const list = parseProxyList(source.join('\n'));

    if (list.length === 0) {
      return res.json({ success: false, error: 'No proxies to validate' });
    }

    const concurrency = Math.max(1, Math.min(50, parseInt(req.body?.concurrency) || 20));
    const autoClean   = req.body?.autoClean !== false;

    const room = `profile:${req.userId}:${req.params.profile.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const io   = req.app.get('botManager').io;

    io.to(room).emit('proxy:validate:start', {
      _profile: req.params.profile,
      total: list.length,
      concurrency,
    });

    const result = await validateProxyList(list, {
      concurrency,
      onProgress: (done, total, last) => {
        io.to(room).emit('proxy:validate:progress', {
          _profile: req.params.profile,
          done, total, last,
        });
      },
    });

    let cleaned = false;
    if (autoClean && result.healthy.length > 0) {
      const cfg = db.getProxyConfig() || {};
      db.saveProxyConfig({ enabled: cfg.enabled !== false, proxyList: result.healthy });
      cleaned = true;
    }

    io.to(room).emit('proxy:validate:done', { _profile: req.params.profile, ...result, cleaned });

    res.json({
      success: true,
      ...result,
      cleaned,
      message: `Tested ${result.total} | ✅ ${result.healthyCount} healthy | ❌ ${result.deadCount} dead${cleaned ? ' (auto-cleaned)' : ''}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/:profile — save config (MUST be LAST)
proxyRouter.post('/:profile', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

    const body = req.body || {};
    let proxyList = body.proxyList || [];
    if (typeof proxyList === 'string') proxyList = proxyList.split('\n');
    const normalized = parseProxyList(proxyList.join('\n'));

    db.saveProxyConfig({ enabled: !!body.enabled, proxyList: normalized });

    res.json({
      success: true,
      saved:   normalized.length,
      message: `Saved ${normalized.length} proxies`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports.proxyRouter = proxyRouter;

// ── Stats Routes ──────────────────────────────────────────────────────────────
const statsRouter = require('express').Router();

statsRouter.get('/:profile', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);
    const totals = db.getStatsTotals();
    res.json({ totals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports.statsRouter = statsRouter;