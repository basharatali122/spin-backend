/**
 * proxyUtils.js — Universal proxy support for all formats and protocols.
 *
 * Supported INPUT formats:
 *
 *   Full URL (pass-through):
 *     socks5h://user:pass@host:port
 *     socks5://user:pass@host:port
 *     socks4://user:pass@host:port
 *     http://user:pass@host:port
 *     https://user:pass@host:port
 *
 *   Raw format (auto-converted to socks5h://):
 *     user:pass@host:port
 *     host:port:user:pass
 *     user__cr.us:pass@host:port   ← DataImpulse geo-targeting format
 *
 * Why socks5h for hostnames?
 *   socks5h = SOCKS5 + remote DNS resolution.
 *   When the proxy server is gw.dataimpulse.com (a hostname, not an IP),
 *   Node must resolve that hostname locally — this works fine.
 *   But for the TARGET (game server), socks5h tells the proxy to resolve
 *   it, bypassing local DNS. This is required for wss:// targets on some
 *   proxy providers.
 *
 * Why do DataImpulse hostname proxies fail with socks-proxy-agent?
 *   socks-proxy-agent v8 has a bug where authentication fails when the
 *   proxy host is a domain rather than an IP. We work around this by:
 *     1. Resolving the proxy hostname to an IP before connecting
 *     2. Constructing the agent with the resolved IP
 */

const dns              = require('dns').promises;
const { SocksProxyAgent } = require('socks-proxy-agent');
const net              = require('net');

// ── Format normalizer ────────────────────────────────────────────────────────

/**
 * normalizeProxy(raw) → canonical socks5h://user:pass@host:port string
 *
 * Handles every format users paste in the proxy textarea.
 */
function normalizeProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw) return null;

  // Already has a scheme → validate and return as-is
  const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
  for (const scheme of KNOWN_SCHEMES) {
    if (raw.toLowerCase().startsWith(scheme)) {
      // Validate it parses
      try { new URL(raw); return raw; } catch (_) { return null; }
    }
  }

  // ── Raw formats — no scheme ──────────────────────────────────────────────

  // Format: host:port:user:pass  (common in proxy lists)
  //   e.g. 45.39.25.184:5619:nxzeeeks:e841o539cuer
  const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
  if (hostPortUserPass) {
    const [, host, port, user, pass] = hostPortUserPass;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format: user:pass@host:port  (no scheme)
  //   e.g. nxzeeeks:e841o539cuer@45.39.25.184:5619
  //   e.g. e0bd617b3b2f662f1ca6__cr.us:324f69fb3e3b0f14@gw.dataimpulse.com:10037
  const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
  if (userPassAtHostPort) {
    const [, user, pass, host, port] = userPassAtHostPort;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format: user:pass@host:port (user contains no colon — already matched above,
  // but catch edge case where pass contains special chars)
  // Try wrapping as socks5h and parsing
  try {
    const attempt = `socks5h://${raw}`;
    new URL(attempt);
    return attempt;
  } catch (_) {}

  console.warn(`[proxyUtils] Could not normalize proxy: ${raw.substring(0, 60)}`);
  return null;
}

/**
 * parseProxyList(text) → array of normalized proxy URLs
 * Accepts newline-separated list, skips blanks and unparseable lines.
 */
function parseProxyList(text) {
  if (!text) return [];
  const lines = Array.isArray(text) ? text : text.split('\n');
  return lines
    .map(l => normalizeProxy(l.trim()))
    .filter(Boolean);
}

// ── Agent factory ────────────────────────────────────────────────────────────

/**
 * makeProxyAgent(proxyUrl) → WebSocket-compatible agent or null
 *
 * For http/https proxies  → uses hpagent (HTTP CONNECT tunnel)
 * For socks proxies       → uses socks-proxy-agent
 *   Special case: if the proxy HOST is a domain (not an IP), we pre-resolve
 *   it to an IP to avoid the socks-proxy-agent hostname auth bug.
 */
async function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;

  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    console.warn(`[proxyUtils] makeProxyAgent: bad proxy URL: ${proxyUrl}`);
    return null;
  }

  let parsed;
  try { parsed = new URL(normalized); }
  catch (err) {
    console.warn(`[proxyUtils] URL parse failed: ${err.message}`);
    return null;
  }

  const scheme = parsed.protocol; // e.g. 'socks5h:'

  // ── HTTP / HTTPS proxy ───────────────────────────────────────────────────
  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const { HttpsProxyAgent } = require('hpagent');
      return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
    } catch (err) {
      console.warn(`[proxyUtils] hpagent not installed — falling back to socks-proxy-agent: ${err.message}`);
      // Fall through to socks handler which will fail gracefully
      return null;
    }
  }

  // ── SOCKS proxy ──────────────────────────────────────────────────────────
  // Check if the proxy HOST is a domain (not a raw IPv4/IPv6)
  const proxyHost = parsed.hostname;
  const isIp = net.isIP(proxyHost) !== 0; // returns 4, 6, or 0

  let agentUrl = normalized;

  if (!isIp) {
    // Resolve hostname → IP to avoid socks-proxy-agent hostname auth bug
    // (affects v8 when proxy host is a domain like gw.dataimpulse.com)
    try {
      const result = await dns.lookup(proxyHost, { family: 4 });
      const resolvedIp = result.address;

      // Reconstruct URL with resolved IP
      const withIp = new URL(normalized);
      withIp.hostname = resolvedIp;
      agentUrl = withIp.toString();

      console.log(`[proxyUtils] Resolved ${proxyHost} → ${resolvedIp}`);
    } catch (dnsErr) {
      console.warn(`[proxyUtils] DNS resolve failed for ${proxyHost}: ${dnsErr.message} — using hostname directly`);
      // Continue with original URL — let socks-proxy-agent try
    }
  }

  try {
    return new SocksProxyAgent(agentUrl, { timeout: 15000 });
  } catch (err) {
    console.warn(`[proxyUtils] SocksProxyAgent create failed: ${err.message}`);
    return null;
  }
}

// ── Live proxy tester ────────────────────────────────────────────────────────

/**
 * testProxy(proxyUrl) → { success, message, ip, latencyMs }
 *
 * Makes a real HTTP request through the proxy to api.ipify.org
 * to verify the proxy actually works end-to-end.
 */
async function testProxy(proxyUrl) {
  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    return { success: false, message: `❌ Cannot parse proxy format: ${proxyUrl}` };
  }

  const start = Date.now();
  try {
    const agent = await makeProxyAgent(normalized);
    if (!agent) {
      return { success: false, message: `❌ Could not create proxy agent for: ${normalized}` };
    }

    // Use https module directly — no axios/node-fetch needed
    const result = await new Promise((resolve, reject) => {
      const https = require('https');
      const http  = require('http');

      // Try ipify first (returns JSON with IP)
      const req = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ip: parsed.ip });
          } catch (_) {
            resolve({ ip: data.trim() });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out after 12s'));
      });
    });

    const latencyMs = Date.now() - start;
    const parsed    = new URL(normalized);
    const masked    = `${parsed.protocol}//${parsed.username}:****@${parsed.hostname}:${parsed.port}`;

    return {
      success:   true,
      message:   `✅ Proxy works! Exit IP: ${result.ip} | Latency: ${latencyMs}ms | Proxy: ${masked}`,
      ip:        result.ip,
      latencyMs,
    };

  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      success:   false,
      message:   `❌ Proxy failed (${latencyMs}ms): ${err.message}`,
      latencyMs,
    };
  }
}

// ── Proxy rotator ────────────────────────────────────────────────────────────

/**
 * ProxyRotator — round-robin proxy selection for batch processing.
 * Each processor gets one rotator; call .next() per account.
 */
class ProxyRotator {
  constructor(proxyList = []) {
    this.proxies = parseProxyList(
      Array.isArray(proxyList) ? proxyList.join('\n') : proxyList
    );
    this.index = 0;
    console.log(`[ProxyRotator] Loaded ${this.proxies.length} proxies`);
  }

  get enabled() { return this.proxies.length > 0; }

  /** Returns next normalized proxy URL, or null if no proxies configured */
  next() {
    if (!this.enabled) return null;
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index++;
    return proxy;
  }

  /** Returns a ready-to-use agent for the next proxy in rotation */
  async nextAgent() {
    const url = this.next();
    if (!url) return null;
    return makeProxyAgent(url);
  }

  summary() {
    return `${this.proxies.length} proxies loaded`;
  }
}

module.exports = { normalizeProxy, parseProxyList, makeProxyAgent, testProxy, ProxyRotator };
