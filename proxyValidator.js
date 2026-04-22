/**
 * proxyValidator.js — Bulk parallel proxy validator with concurrency control.
 *
 * Tests every proxy in a list against a real HTTP endpoint (api.ipify.org)
 * through the proxy tunnel. Returns healthy/dead splits so the system can
 * automatically prune bad proxies BEFORE processing begins, preventing
 * account failures caused by auth-failed or timed-out proxies.
 *
 * Usage:
 *   const { validateProxyList } = require('./proxyValidator');
 *   const { healthy, dead } = await validateProxyList(list, {
 *     concurrency: 20,
 *     onProgress: (done, total, result) => { ... },
 *   });
 */

const { testProxy, normalizeProxy } = require('./proxyUtils');

/**
 * Run an async task pool with bounded concurrency.
 * @param {Array} items
 * @param {number} concurrency
 * @param {(item, index) => Promise} worker
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }

  const runners = [];
  for (let k = 0; k < Math.min(concurrency, items.length); k++) {
    runners.push(next());
  }
  await Promise.all(runners);
  return results;
}

/**
 * Validate a list of proxies in parallel.
 *
 * @param {string[]} proxyList - raw or normalized proxy strings
 * @param {object}   opts
 * @param {number}   opts.concurrency  - parallel test count (default 20)
 * @param {number}   opts.timeoutMs    - per-test timeout (default 12000 — handled inside testProxy)
 * @param {function} opts.onProgress   - (done, total, lastResult) => void
 *
 * @returns {Promise<{ healthy:string[], dead:Array<{proxy,reason}>, total:number, durationMs:number }>}
 */
async function validateProxyList(proxyList, opts = {}) {
  const concurrency = Math.max(1, Math.min(50, opts.concurrency || 20));
  const onProgress  = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // Normalize + dedupe
  const normalized = [];
  const seen = new Set();
  for (const raw of proxyList || []) {
    const n = normalizeProxy(typeof raw === 'string' ? raw : String(raw));
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    normalized.push(n);
  }

  const total = normalized.length;
  const start = Date.now();
  let done = 0;

  const healthy = [];
  const dead    = [];

  const results = await runPool(normalized, concurrency, async (proxy) => {
    let r;
    try {
      r = await testProxy(proxy);
    } catch (err) {
      r = { success: false, message: `Test threw: ${err.message}` };
    }

    done++;

    if (r.success) {
      healthy.push(proxy);
    } else {
      const masked = maskProxy(proxy);
      const reason = (r.message || 'unknown error').replace(/\s+/g, ' ').trim();
      dead.push({ proxy: masked, raw: proxy, reason, latencyMs: r.latencyMs || 0 });
    }

    if (onProgress) {
      try { onProgress(done, total, { proxy: maskProxy(proxy), success: r.success, message: r.message, latencyMs: r.latencyMs }); } catch (_) {}
    }

    return r;
  });

  return {
    healthy,
    dead,
    total,
    healthyCount: healthy.length,
    deadCount:    dead.length,
    durationMs:   Date.now() - start,
  };
}

function maskProxy(p) {
  try {
    const u = new URL(p);
    return `${u.protocol}//${u.username ? u.username[0] + '***' : ''}:****@${u.hostname}:${u.port}`;
  } catch (_) {
    return p.length > 60 ? p.substring(0, 60) + '…' : p;
  }
}

module.exports = { validateProxyList, maskProxy };
