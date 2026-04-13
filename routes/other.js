const { normalizeProxy, parseProxyList, testProxy } = require('../proxyUtils');

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

// POST /api/proxy/:profile — save config
// Normalizes all proxy entries before saving so the DB always holds clean URLs.
proxyRouter.post('/:profile', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { db } = await botManager.getOrCreateInstance(req.userId, req.params.profile);

    const body = req.body || {};

    // Normalize the proxy list — converts all raw formats to socks5h:// etc.
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

// POST /api/proxy/:profile/normalize — preview normalized format without saving
proxyRouter.post('/:profile/normalize', (req, res) => {
  try {
    const raw   = req.body.proxyList || '';
    const lines = typeof raw === 'string' ? raw : raw.join('\n');
    const normalized = parseProxyList(lines);
    res.json({ success: true, normalized, count: normalized.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/proxy/:profile/test — LIVE test through actual proxy connection
proxyRouter.post('/:profile/test', async (req, res) => {
  try {
    const { proxyUrl } = req.body;
    if (!proxyUrl) return res.status(400).json({ error: 'No proxy URL provided' });

    const normalized = normalizeProxy(proxyUrl);
    if (!normalized) {
      return res.json({
        success: false,
        message: `Cannot parse proxy format. Supported:\n  socks5h://user:pass@host:port\n  socks5://user:pass@host:port\n  http://user:pass@host:port\n  user:pass@host:port\n  host:port:user:pass\n\nReceived: ${proxyUrl}`,
      });
    }

    const result = await testProxy(normalized);
    res.json(result);
  } catch (err) {
    res.json({ success: false, message: `Test error: ${err.message}` });
  }
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
