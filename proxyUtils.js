// /**
//  * proxyUtils.js — Universal proxy support for all formats and protocols.
//  *
//  * Supported INPUT formats:
//  *
//  *   Full URL (pass-through):
//  *     socks5h://user:pass@host:port
//  *     socks5://user:pass@host:port
//  *     socks4://user:pass@host:port
//  *     http://user:pass@host:port
//  *     https://user:pass@host:port
//  *
//  *   Raw format (auto-converted to socks5h://):
//  *     user:pass@host:port
//  *     host:port:user:pass
//  *     user__cr.us:pass@host:port   ← DataImpulse geo-targeting format
//  *
//  * Why socks5h for hostnames?
//  *   socks5h = SOCKS5 + remote DNS resolution.
//  *   When the proxy server is gw.dataimpulse.com (a hostname, not an IP),
//  *   Node must resolve that hostname locally — this works fine.
//  *   But for the TARGET (game server), socks5h tells the proxy to resolve
//  *   it, bypassing local DNS. This is required for wss:// targets on some
//  *   proxy providers.
//  *
//  * Why do DataImpulse hostname proxies fail with socks-proxy-agent?
//  *   socks-proxy-agent v8 has a bug where authentication fails when the
//  *   proxy host is a domain rather than an IP. We work around this by:
//  *     1. Resolving the proxy hostname to an IP before connecting
//  *     2. Constructing the agent with the resolved IP
//  */

// const dns              = require('dns').promises;
// const { SocksProxyAgent } = require('socks-proxy-agent');
// const net              = require('net');

// // ── Format normalizer ────────────────────────────────────────────────────────

// /**
//  * normalizeProxy(raw) → canonical socks5h://user:pass@host:port string
//  *
//  * Handles every format users paste in the proxy textarea.
//  */
// function normalizeProxy(raw) {
//   if (!raw || typeof raw !== 'string') return null;
//   raw = raw.trim();
//   if (!raw) return null;

//   // Already has a scheme → validate and return as-is
//   const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
//   for (const scheme of KNOWN_SCHEMES) {
//     if (raw.toLowerCase().startsWith(scheme)) {
//       // Validate it parses
//       try { new URL(raw); return raw; } catch (_) { return null; }
//     }
//   }

//   // ── Raw formats — no scheme ──────────────────────────────────────────────

//   // Format: host:port:user:pass  (common in proxy lists)
//   //   e.g. 45.39.25.184:5619:nxzeeeks:e841o539cuer
//   const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
//   if (hostPortUserPass) {
//     const [, host, port, user, pass] = hostPortUserPass;
//     return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
//   }

//   // Format: user:pass@host:port  (no scheme)
//   //   e.g. nxzeeeks:e841o539cuer@45.39.25.184:5619
//   //   e.g. e0bd617b3b2f662f1ca6__cr.us:324f69fb3e3b0f14@gw.dataimpulse.com:10037
//   const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
//   if (userPassAtHostPort) {
//     const [, user, pass, host, port] = userPassAtHostPort;
//     return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
//   }

//   // Format: user:pass@host:port (user contains no colon — already matched above,
//   // but catch edge case where pass contains special chars)
//   // Try wrapping as socks5h and parsing
//   try {
//     const attempt = `socks5h://${raw}`;
//     new URL(attempt);
//     return attempt;
//   } catch (_) {}

//   console.warn(`[proxyUtils] Could not normalize proxy: ${raw.substring(0, 60)}`);
//   return null;
// }

// /**
//  * parseProxyList(text) → array of normalized proxy URLs
//  * Accepts newline-separated list, skips blanks and unparseable lines.
//  */
// function parseProxyList(text) {
//   if (!text) return [];
//   const lines = Array.isArray(text) ? text : text.split('\n');
//   return lines
//     .map(l => normalizeProxy(l.trim()))
//     .filter(Boolean);
// }

// // ── Agent factory ────────────────────────────────────────────────────────────

// /**
//  * makeProxyAgent(proxyUrl) → WebSocket-compatible agent or null
//  *
//  * For http/https proxies  → uses hpagent (HTTP CONNECT tunnel)
//  * For socks proxies       → uses socks-proxy-agent
//  *   Special case: if the proxy HOST is a domain (not an IP), we pre-resolve
//  *   it to an IP to avoid the socks-proxy-agent hostname auth bug.
//  */
// async function makeProxyAgent(proxyUrl) {
//   if (!proxyUrl) return null;

//   const normalized = normalizeProxy(proxyUrl);
//   if (!normalized) {
//     console.warn(`[proxyUtils] makeProxyAgent: bad proxy URL: ${proxyUrl}`);
//     return null;
//   }

//   let parsed;
//   try { parsed = new URL(normalized); }
//   catch (err) {
//     console.warn(`[proxyUtils] URL parse failed: ${err.message}`);
//     return null;
//   }

//   const scheme = parsed.protocol; // e.g. 'socks5h:'

//   // ── HTTP / HTTPS proxy ───────────────────────────────────────────────────
//   if (scheme === 'http:' || scheme === 'https:') {
//     try {
//       const { HttpsProxyAgent } = require('hpagent');
//       return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
//     } catch (err) {
//       console.warn(`[proxyUtils] hpagent not installed — falling back to socks-proxy-agent: ${err.message}`);
//       // Fall through to socks handler which will fail gracefully
//       return null;
//     }
//   }

//   // ── SOCKS proxy ──────────────────────────────────────────────────────────
//   // Check if the proxy HOST is a domain (not a raw IPv4/IPv6)
//   const proxyHost = parsed.hostname;
//   const isIp = net.isIP(proxyHost) !== 0; // returns 4, 6, or 0

//   let agentUrl = normalized;

//   if (!isIp) {
//     // Resolve hostname → IP to avoid socks-proxy-agent hostname auth bug
//     // (affects v8 when proxy host is a domain like gw.dataimpulse.com)
//     try {
//       const result = await dns.lookup(proxyHost, { family: 4 });
//       const resolvedIp = result.address;

//       // Reconstruct URL with resolved IP
//       const withIp = new URL(normalized);
//       withIp.hostname = resolvedIp;
//       agentUrl = withIp.toString();

//       console.log(`[proxyUtils] Resolved ${proxyHost} → ${resolvedIp}`);
//     } catch (dnsErr) {
//       console.warn(`[proxyUtils] DNS resolve failed for ${proxyHost}: ${dnsErr.message} — using hostname directly`);
//       // Continue with original URL — let socks-proxy-agent try
//     }
//   }

//   try {
//     return new SocksProxyAgent(agentUrl, { timeout: 15000 });
//   } catch (err) {
//     console.warn(`[proxyUtils] SocksProxyAgent create failed: ${err.message}`);
//     return null;
//   }
// }

// // ── Live proxy tester ────────────────────────────────────────────────────────

// /**
//  * testProxy(proxyUrl) → { success, message, ip, latencyMs }
//  *
//  * Makes a real HTTP request through the proxy to api.ipify.org
//  * to verify the proxy actually works end-to-end.
//  */
// async function testProxy(proxyUrl) {
//   const normalized = normalizeProxy(proxyUrl);
//   if (!normalized) {
//     return { success: false, message: `❌ Cannot parse proxy format: ${proxyUrl}` };
//   }

//   const start = Date.now();
//   try {
//     const agent = await makeProxyAgent(normalized);
//     if (!agent) {
//       return { success: false, message: `❌ Could not create proxy agent for: ${normalized}` };
//     }

//     // Use https module directly — no axios/node-fetch needed
//     const result = await new Promise((resolve, reject) => {
//       const https = require('https');
//       const http  = require('http');

//       // Try ipify first (returns JSON with IP)
//       const req = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (res) => {
//         let data = '';
//         res.on('data', chunk => { data += chunk; });
//         res.on('end', () => {
//           try {
//             const parsed = JSON.parse(data);
//             resolve({ ip: parsed.ip });
//           } catch (_) {
//             resolve({ ip: data.trim() });
//           }
//         });
//       });

//       req.on('error', reject);
//       req.on('timeout', () => {
//         req.destroy();
//         reject(new Error('Request timed out after 12s'));
//       });
//     });

//     const latencyMs = Date.now() - start;
//     const parsed    = new URL(normalized);
//     const masked    = `${parsed.protocol}//${parsed.username}:****@${parsed.hostname}:${parsed.port}`;

//     return {
//       success:   true,
//       message:   `✅ Proxy works! Exit IP: ${result.ip} | Latency: ${latencyMs}ms | Proxy: ${masked}`,
//       ip:        result.ip,
//       latencyMs,
//     };

//   } catch (err) {
//     const latencyMs = Date.now() - start;
//     return {
//       success:   false,
//       message:   `❌ Proxy failed (${latencyMs}ms): ${err.message}`,
//       latencyMs,
//     };
//   }
// }

// // ── Proxy rotator ────────────────────────────────────────────────────────────

// /**
//  * ProxyRotator — round-robin proxy selection for batch processing.
//  * Each processor gets one rotator; call .next() per account.
//  */
// class ProxyRotator {
//   constructor(proxyList = []) {
//     this.proxies = parseProxyList(
//       Array.isArray(proxyList) ? proxyList.join('\n') : proxyList
//     );
//     this.index = 0;
//     console.log(`[ProxyRotator] Loaded ${this.proxies.length} proxies`);
//   }

//   get enabled() { return this.proxies.length > 0; }

//   /** Returns next normalized proxy URL, or null if no proxies configured */
//   next() {
//     if (!this.enabled) return null;
//     const proxy = this.proxies[this.index % this.proxies.length];
//     this.index++;
//     return proxy;
//   }

//   /** Returns a ready-to-use agent for the next proxy in rotation */
//   async nextAgent() {
//     const url = this.next();
//     if (!url) return null;
//     return makeProxyAgent(url);
//   }

//   summary() {
//     return `${this.proxies.length} proxies loaded`;
//   }
// }

// module.exports = { normalizeProxy, parseProxyList, makeProxyAgent, testProxy, ProxyRotator };




// loveable version started 



// /**
//  * proxyUtils.js — Universal proxy support for all formats and protocols.
//  *
//  * Supported INPUT formats:
//  *
//  *   Full URL (pass-through):
//  *     socks5h://user:pass@host:port
//  *     socks5://user:pass@host:port
//  *     socks4://user:pass@host:port
//  *     http://user:pass@host:port
//  *     https://user:pass@host:port
//  *
//  *   Raw format (auto-converted to socks5h://):
//  *     user:pass@host:port
//  *     host:port:user:pass
//  *     user__cr.us:pass@host:port   ← DataImpulse geo-targeting format
//  *
//  * Why socks5h for hostnames?
//  *   socks5h = SOCKS5 + remote DNS resolution.
//  *   When the proxy server is gw.dataimpulse.com (a hostname, not an IP),
//  *   Node must resolve that hostname locally — this works fine.
//  *   But for the TARGET (game server), socks5h tells the proxy to resolve
//  *   it, bypassing local DNS. This is required for wss:// targets on some
//  *   proxy providers.
//  *
//  * Why do DataImpulse hostname proxies fail with socks-proxy-agent?
//  *   socks-proxy-agent v8 has a bug where authentication fails when the
//  *   proxy host is a domain rather than an IP. We work around this by:
//  *     1. Resolving the proxy hostname to an IP before connecting
//  *     2. Constructing the agent with the resolved IP
//  */

// const dns              = require('dns').promises;
// const { SocksProxyAgent } = require('socks-proxy-agent');
// const net              = require('net');

// // FIX: DNS cache to avoid repeated lookups (TTL 5 min)
// const _dnsCache = new Map(); // hostname → { ip, expires }
// const DNS_TTL_MS = 5 * 60 * 1000;

// async function cachedDnsLookup(hostname) {
//   const cached = _dnsCache.get(hostname);
//   if (cached && cached.expires > Date.now()) return cached.ip;
//   const result = await dns.lookup(hostname, { family: 4 });
//   _dnsCache.set(hostname, { ip: result.address, expires: Date.now() + DNS_TTL_MS });
//   return result.address;
// }

// // ── Format normalizer ────────────────────────────────────────────────────────

// /**
//  * normalizeProxy(raw) → canonical socks5h://user:pass@host:port string
//  *
//  * Handles every format users paste in the proxy textarea.
//  */
// function normalizeProxy(raw) {
//   if (!raw || typeof raw !== 'string') return null;
//   raw = raw.trim();
//   if (!raw) return null;

//   // Already has a scheme → validate and return as-is
//   const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
//   for (const scheme of KNOWN_SCHEMES) {
//     if (raw.toLowerCase().startsWith(scheme)) {
//       // Validate it parses
//       try { new URL(raw); return raw; } catch (_) { return null; }
//     }
//   }

//   // ── Raw formats — no scheme ──────────────────────────────────────────────

//   // Format: host:port:user:pass  (common in proxy lists)
//   //   e.g. 45.39.25.184:5619:nxzeeeks:e841o539cuer
//   const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
//   if (hostPortUserPass) {
//     const [, host, port, user, pass] = hostPortUserPass;
//     return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
//   }

//   // Format: user:pass@host:port  (no scheme)
//   //   e.g. nxzeeeks:e841o539cuer@45.39.25.184:5619
//   //   e.g. e0bd617b3b2f662f1ca6__cr.us:324f69fb3e3b0f14@gw.dataimpulse.com:10037
//   const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
//   if (userPassAtHostPort) {
//     const [, user, pass, host, port] = userPassAtHostPort;
//     return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
//   }

//   // Format: user:pass@host:port (user contains no colon — already matched above,
//   // but catch edge case where pass contains special chars)
//   // Try wrapping as socks5h and parsing
//   try {
//     const attempt = `socks5h://${raw}`;
//     new URL(attempt);
//     return attempt;
//   } catch (_) {}

//   console.warn(`[proxyUtils] Could not normalize proxy: ${raw.substring(0, 60)}`);
//   return null;
// }

// /**
//  * parseProxyList(text) → array of normalized proxy URLs
//  * Accepts newline-separated list, skips blanks and unparseable lines.
//  */
// function parseProxyList(text) {
//   if (!text) return [];
//   const lines = Array.isArray(text) ? text : text.split('\n');
//   return lines
//     .map(l => normalizeProxy(l.trim()))
//     .filter(Boolean);
// }

// // ── Agent factory ────────────────────────────────────────────────────────────

// /**
//  * makeProxyAgent(proxyUrl) → WebSocket-compatible agent or null
//  *
//  * For http/https proxies  → uses hpagent (HTTP CONNECT tunnel)
//  * For socks proxies       → uses socks-proxy-agent
//  *   Special case: if the proxy HOST is a domain (not an IP), we pre-resolve
//  *   it to an IP to avoid the socks-proxy-agent hostname auth bug.
//  */
// async function makeProxyAgent(proxyUrl) {
//   if (!proxyUrl) return null;

//   const normalized = normalizeProxy(proxyUrl);
//   if (!normalized) {
//     console.warn(`[proxyUtils] makeProxyAgent: bad proxy URL: ${proxyUrl}`);
//     return null;
//   }

//   let parsed;
//   try { parsed = new URL(normalized); }
//   catch (err) {
//     console.warn(`[proxyUtils] URL parse failed: ${err.message}`);
//     return null;
//   }

//   const scheme = parsed.protocol; // e.g. 'socks5h:'

//   // ── HTTP / HTTPS proxy ───────────────────────────────────────────────────
//   if (scheme === 'http:' || scheme === 'https:') {
//     try {
//       const { HttpsProxyAgent } = require('hpagent');
//       return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
//     } catch (err) {
//       console.warn(`[proxyUtils] hpagent not installed — falling back to socks-proxy-agent: ${err.message}`);
//       // Fall through to socks handler which will fail gracefully
//       return null;
//     }
//   }

//   // ── SOCKS proxy ──────────────────────────────────────────────────────────
//   // Check if the proxy HOST is a domain (not a raw IPv4/IPv6)
//   const proxyHost = parsed.hostname;
//   const isIp = net.isIP(proxyHost) !== 0; // returns 4, 6, or 0

//   let agentUrl = normalized;

//   if (!isIp) {
//     // Resolve hostname → IP to avoid socks-proxy-agent hostname auth bug
//     // (affects v8 when proxy host is a domain like gw.dataimpulse.com)
//     try {
//       const resolvedIp = await cachedDnsLookup(proxyHost);

//       // Reconstruct URL with resolved IP
//       const withIp = new URL(normalized);
//       withIp.hostname = resolvedIp;
//       agentUrl = withIp.toString();

//       console.log(`[proxyUtils] Resolved ${proxyHost} → ${resolvedIp}`);
//     } catch (dnsErr) {
//       console.warn(`[proxyUtils] DNS resolve failed for ${proxyHost}: ${dnsErr.message} — using hostname directly`);
//       // Continue with original URL — let socks-proxy-agent try
//     }
//   }

//   try {
//     return new SocksProxyAgent(agentUrl, { timeout: 15000 });
//   } catch (err) {
//     console.warn(`[proxyUtils] SocksProxyAgent create failed: ${err.message}`);
//     return null;
//   }
// }

// // ── Live proxy tester ────────────────────────────────────────────────────────

// /**
//  * testProxy(proxyUrl) → { success, message, ip, latencyMs }
//  *
//  * Makes a real HTTP request through the proxy to api.ipify.org
//  * to verify the proxy actually works end-to-end.
//  */
// async function testProxy(proxyUrl) {
//   const normalized = normalizeProxy(proxyUrl);
//   if (!normalized) {
//     return { success: false, message: `❌ Cannot parse proxy format: ${proxyUrl}` };
//   }

//   const start = Date.now();
//   try {
//     const agent = await makeProxyAgent(normalized);
//     if (!agent) {
//       return { success: false, message: `❌ Could not create proxy agent for: ${normalized}` };
//     }

//     // Use https module directly — no axios/node-fetch needed
//     const result = await new Promise((resolve, reject) => {
//       const https = require('https');
//       const http  = require('http');

//       // Try ipify first (returns JSON with IP)
//       const req = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (res) => {
//         let data = '';
//         res.on('data', chunk => { data += chunk; });
//         res.on('end', () => {
//           try {
//             const parsed = JSON.parse(data);
//             resolve({ ip: parsed.ip });
//           } catch (_) {
//             resolve({ ip: data.trim() });
//           }
//         });
//       });

//       req.on('error', reject);
//       req.on('timeout', () => {
//         req.destroy();
//         reject(new Error('Request timed out after 12s'));
//       });
//     });

//     const latencyMs = Date.now() - start;
//     const parsed    = new URL(normalized);
//     const masked    = `${parsed.protocol}//${parsed.username}:****@${parsed.hostname}:${parsed.port}`;

//     return {
//       success:   true,
//       message:   `✅ Proxy works! Exit IP: ${result.ip} | Latency: ${latencyMs}ms | Proxy: ${masked}`,
//       ip:        result.ip,
//       latencyMs,
//     };

//   } catch (err) {
//     const latencyMs = Date.now() - start;
//     return {
//       success:   false,
//       message:   `❌ Proxy failed (${latencyMs}ms): ${err.message}`,
//       latencyMs,
//     };
//   }
// }

// // ── Proxy rotator ────────────────────────────────────────────────────────────

// /**
//  * ProxyRotator — round-robin proxy selection for batch processing.
//  * Each processor gets one rotator; call .next() per account.
//  */
// class ProxyRotator {
//   constructor(proxyList = []) {
//     this.proxies = parseProxyList(
//       Array.isArray(proxyList) ? proxyList.join('\n') : proxyList
//     );
//     this.index = 0;
//     console.log(`[ProxyRotator] Loaded ${this.proxies.length} proxies`);
//   }

//   get enabled() { return this.proxies.length > 0; }

//   /** Returns next normalized proxy URL, or null if no proxies configured */
//   next() {
//     if (!this.enabled) return null;
//     const proxy = this.proxies[this.index % this.proxies.length];
//     this.index++;
//     return proxy;
//   }

//   /** Returns a ready-to-use agent for the next proxy in rotation */
//   async nextAgent() {
//     const url = this.next();
//     if (!url) return null;
//     return makeProxyAgent(url);
//   }

//   summary() {
//     return `${this.proxies.length} proxies loaded`;
//   }
// }

// module.exports = { normalizeProxy, parseProxyList, makeProxyAgent, testProxy, ProxyRotator };




//claude version 





/**
 * proxyUtils.js — Universal proxy support for all formats and protocols.
 *
 * KEY FIXES vs previous version:
 *
 * FIX 1 — DataImpulse proxies are HTTP, not SOCKS5.
 *   DataImpulse (gw.dataimpulse.com, ports 10000-10999) sells HTTP proxies.
 *   Sending a SOCKS5 handshake to an HTTP proxy causes "Authentication failed"
 *   because the server doesn't speak SOCKS5 at all.
 *   Solution: detect DataImpulse by hostname/port and use http:// scheme.
 *
 * FIX 2 — testProxy now validates through WSS port 7878, not HTTP.
 *   The bot connects via wss://pandamaster.vip:7878. A proxy can pass an HTTP
 *   test to api.ipify.org but block port 7878 entirely. testProxy now opens a
 *   real TCP connection through the proxy to pandamaster.vip:7878 so the
 *   validate-all result actually predicts bot success.
 *
 * Supported INPUT formats:
 *   socks5h://user:pass@host:port   <- WebShare (SOCKS5)
 *   socks5://user:pass@host:port
 *   http://user:pass@host:port      <- DataImpulse (HTTP)
 *   user:pass@host:port             <- auto-detected
 *   host:port:user:pass             <- auto-detected
 */

const dns               = require('dns').promises;
const net               = require('net');
const { SocksProxyAgent } = require('socks-proxy-agent');

// DNS cache (TTL 5 min)
const _dnsCache = new Map();
const DNS_TTL_MS = 5 * 60 * 1000;

async function cachedDnsLookup(hostname) {
  const cached = _dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.ip;
  const result = await dns.lookup(hostname, { family: 4 });
  _dnsCache.set(hostname, { ip: result.address, expires: Date.now() + DNS_TTL_MS });
  return result.address;
}

// Detect proxies that use HTTP CONNECT (not SOCKS5).
// Sending a SOCKS5 handshake to an HTTP proxy causes silent auth failure.
// Add new providers here as needed.
function isHttpProxy(host, port) {
  const portNum = parseInt(port, 10);
  const h = (host || '').toLowerCase();
  // DataImpulse — HTTP on gw.dataimpulse.com or ports 10000-10999
  if (h.includes('dataimpulse.com')) return true;
  if (portNum >= 10000 && portNum <= 10999) return true;
  // IPRoyal residential — HTTP CONNECT on geo.iproyal.com:12321
  if (h.includes('iproyal.com')) return true;
  if (portNum === 12321) return true;
  return false;
}
// Keep old name as alias so nothing else breaks
const isDataImpulseProxy = isHttpProxy;

// ── Format normalizer ────────────────────────────────────────────────────────

function normalizeProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw || raw.startsWith('#')) return null;

  const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
  for (const scheme of KNOWN_SCHEMES) {
    if (raw.toLowerCase().startsWith(scheme)) {
      try {
        const parsed = new URL(raw);
        // Even if the user typed socks5h://, override to http:// for known HTTP providers
        // (IPRoyal, DataImpulse) — sending a SOCKS5 handshake to an HTTP proxy always fails
        if (isHttpProxy(parsed.hostname, parsed.port)) {
          const corrected = 'http://' + raw.slice(raw.indexOf('://') + 3);
          try { new URL(corrected); return corrected; } catch (_) {}
        }
        return raw;
      } catch (_) { return null; }
    }
  }

  // Format: host:port:user:pass
  const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
  if (hostPortUserPass) {
    const [, host, port, user, pass] = hostPortUserPass;
    const scheme = isDataImpulseProxy(host, port) ? 'http' : 'socks5h';
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format: user:pass@host:port
  const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
  if (userPassAtHostPort) {
    const [, user, pass, host, port] = userPassAtHostPort;
    const scheme = isDataImpulseProxy(host, port) ? 'http' : 'socks5h';
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  try {
    const attempt = `socks5h://${raw}`;
    new URL(attempt);
    return attempt;
  } catch (_) {}

  console.warn(`[proxyUtils] Could not normalize proxy: ${raw.substring(0, 60)}`);
  return null;
}

function parseProxyList(text) {
  if (!text) return [];
  const lines = Array.isArray(text) ? text : text.split('\n');
  return lines.map(l => normalizeProxy(l.trim())).filter(Boolean);
}

// ── Agent factory ────────────────────────────────────────────────────────────

async function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;

  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    console.warn(`[proxyUtils] makeProxyAgent: bad proxy URL: ${proxyUrl}`);
    return null;
  }

  let parsed;
  try { parsed = new URL(normalized); }
  catch (err) { console.warn(`[proxyUtils] URL parse failed: ${err.message}`); return null; }

  const scheme = parsed.protocol;

  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const { HttpsProxyAgent } = require('hpagent');
      return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
    } catch (err) {
      console.warn(`[proxyUtils] hpagent error: ${err.message}`);
      return null;
    }
  }

  // SOCKS proxy — pre-resolve hostname to avoid socks-proxy-agent v8 bug
  const proxyHost = parsed.hostname;
  const isIp = net.isIP(proxyHost) !== 0;
  let agentUrl = normalized;

  if (!isIp) {
    try {
      const resolvedIp = await cachedDnsLookup(proxyHost);
      const withIp = new URL(normalized);
      withIp.hostname = resolvedIp;
      agentUrl = withIp.toString();
      console.log(`[proxyUtils] Resolved ${proxyHost} -> ${resolvedIp}`);
    } catch (dnsErr) {
      console.warn(`[proxyUtils] DNS resolve failed for ${proxyHost}: ${dnsErr.message}`);
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
 * testProxy(proxyUrl) → { success, message, latencyMs }
 *
 * Tests by opening a real TCP connection to pandamaster.vip:7878 — the same
 * target the bot uses. This is the only reliable way to know if a proxy will
 * actually work during processing (HTTP tests to api.ipify.org are NOT enough).
 */
async function testProxy(proxyUrl) {
  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    return { success: false, message: `Cannot parse proxy format: ${proxyUrl}` };
  }

  const start = Date.now();
  let parsed;
  try { parsed = new URL(normalized); } catch (_) {
    return { success: false, message: `Invalid proxy URL: ${normalized}` };
  }

  const scheme    = parsed.protocol;
  const proxyHost = parsed.hostname;
  const proxyPort = parseInt(parsed.port, 10);
  const user      = decodeURIComponent(parsed.username || '');
  const pass      = decodeURIComponent(parsed.password || '');

  const TARGET_HOST = 'pandamaster.vip';
  const TARGET_PORT = 7878;
  const TIMEOUT_MS  = 12000;

  try {
    if (scheme === 'http:' || scheme === 'https:') {
      await httpConnectTest(proxyHost, proxyPort, user, pass, TARGET_HOST, TARGET_PORT, TIMEOUT_MS);
    } else {
      let resolvedHost = proxyHost;
      if (net.isIP(proxyHost) === 0) {
        try { resolvedHost = await cachedDnsLookup(proxyHost); } catch (_) {}
      }
      await socks5ConnectTest(resolvedHost, proxyPort, user, pass, TARGET_HOST, TARGET_PORT, TIMEOUT_MS);
    }

    const latencyMs = Date.now() - start;
    const masked = `${scheme}//${user ? user[0] + '***' : ''}:****@${proxyHost}:${proxyPort}`;
    return { success: true, message: `Port 7878 reachable | ${latencyMs}ms | ${masked}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { success: false, message: `Proxy failed (${latencyMs}ms): ${err.message}`, latencyMs };
  }
}

// HTTP CONNECT tunnel test
function httpConnectTest(proxyHost, proxyPort, user, pass, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort });
    let resolved = false;
    const done = (err) => { if (resolved) return; resolved = true; socket.destroy(); if (err) reject(err); else resolve(); };
    const timer = setTimeout(() => done(new Error(`CONNECT timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.on('connect', () => {
      const auth = user ? `\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : '';
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}${auth}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      clearTimeout(timer);
      const resp = chunk.toString();
      if (resp.startsWith('HTTP/1.1 200') || resp.startsWith('HTTP/1.0 200')) {
        done(null);
      } else {
        done(new Error(`HTTP CONNECT rejected: ${resp.split('\r\n')[0]}`));
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); done(new Error(`TCP error: ${err.message}`)); });
    socket.setTimeout(timeoutMs, () => { clearTimeout(timer); done(new Error('TCP timeout')); });
  });
}

// SOCKS5 handshake test (manual, no library dependency)
function socks5ConnectTest(proxyHost, proxyPort, user, pass, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort });
    let step = 0;
    let resolved = false;
    const done = (err) => { if (resolved) return; resolved = true; socket.destroy(); if (err) reject(err); else resolve(); };
    const timer = setTimeout(() => done(new Error(`SOCKS5 timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02])); // greeting: support no-auth + user/pass
      step = 1;
    });

    socket.on('data', (data) => {
      if (step === 1) {
        if (data.length < 2 || data[0] !== 0x05) { clearTimeout(timer); return done(new Error('Invalid SOCKS5 greeting')); }
        if (data[1] === 0xFF) { clearTimeout(timer); return done(new Error('SOCKS5: no acceptable auth method')); }
        if (data[1] === 0x02) {
          // Send username/password auth
          const uBuf = Buffer.from(user || '', 'utf8');
          const pBuf = Buffer.from(pass || '', 'utf8');
          const pkt  = Buffer.alloc(3 + uBuf.length + pBuf.length);
          pkt[0] = 0x01; pkt[1] = uBuf.length;
          uBuf.copy(pkt, 2);
          pkt[2 + uBuf.length] = pBuf.length;
          pBuf.copy(pkt, 3 + uBuf.length);
          socket.write(pkt);
          step = 2;
        } else {
          step = 3; sendConnect();
        }
        return;
      }
      if (step === 2) {
        if (data.length < 2 || data[1] !== 0x00) { clearTimeout(timer); return done(new Error('SOCKS5 auth failed — wrong credentials')); }
        step = 3; sendConnect(); return;
      }
      if (step === 3) {
        if (data.length < 2 || data[0] !== 0x05) { clearTimeout(timer); return done(new Error('Invalid SOCKS5 CONNECT response')); }
        if (data[1] !== 0x00) {
          const ERRS = { 0x01:'General failure', 0x02:'Not allowed', 0x03:'Network unreachable', 0x04:'Host unreachable', 0x05:'Connection refused' };
          clearTimeout(timer); return done(new Error(`SOCKS5 CONNECT error: ${ERRS[data[1]] || `code 0x${data[1].toString(16)}`}`));
        }
        clearTimeout(timer); done(null); return;
      }
    });

    function sendConnect() {
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const pkt = Buffer.alloc(7 + hostBuf.length);
      pkt[0] = 0x05; pkt[1] = 0x01; pkt[2] = 0x00; pkt[3] = 0x03;
      pkt[4] = hostBuf.length;
      hostBuf.copy(pkt, 5);
      pkt.writeUInt16BE(targetPort, 5 + hostBuf.length);
      socket.write(pkt);
    }

    socket.on('error', (err) => { clearTimeout(timer); done(new Error(`TCP error: ${err.message}`)); });
    socket.setTimeout(timeoutMs, () => { clearTimeout(timer); done(new Error('TCP timeout')); });
  });
}

// ── Proxy rotator ────────────────────────────────────────────────────────────

// ── Proxy rotator (concurrency-aware) ────────────────────────────────────────
//
// KEY FIX: The old ProxyRotator was a blind round-robin — it had no idea how
// many workers were already using each proxy. Under 20+ concurrent workers,
// multiple workers would hit the SAME proxy IP simultaneously, saturating its
// connection limit and causing "Proxy connection timed out" storms.
//
// This new implementation tracks active connections per proxy with a semaphore.
// Each proxy has a slot limit (maxPerProxy). When all slots are taken, the
// rotator skips to the next available proxy.
//
// Usage in processors:
//   const rotator = new ProxyRotator(proxyList, { maxPerProxy: 1 });
//   const { proxyUrl, release } = await rotator.acquire();
//   try { /* use proxyUrl */ } finally { release(); }  // MUST call release()

class ProxyRotator {
  constructor(proxyList = [], { maxPerProxy = 1, acquireTimeoutMs = 30000 } = {}) {
    this.proxies         = parseProxyList(Array.isArray(proxyList) ? proxyList.join('\n') : proxyList);
    this.maxPerProxy     = maxPerProxy;
    this.acquireTimeout  = acquireTimeoutMs;
    this.active          = new Array(this.proxies.length).fill(0);
    this.index           = 0;
    this._waiters        = [];
    console.log(`[ProxyRotator] Loaded ${this.proxies.length} proxies (maxPerProxy=${maxPerProxy})`);
  }

  get enabled() { return this.proxies.length > 0; }

  /** Backwards-compatible synchronous next() — no concurrency tracking */
  next() {
    if (!this.enabled) return null;
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index++;
    return proxy;
  }

  /**
   * acquire() → Promise<{ proxyUrl, proxyIndex, release }>
   *
   * Finds a proxy with a free slot and reserves it. If all proxies are at
   * capacity, waits until one is released (or acquireTimeoutMs elapses).
   * ALWAYS call release() when done — use try/finally.
   */
  acquire() {
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (!this.enabled) {
          resolve({ proxyUrl: null, proxyIndex: -1, release: () => {} });
          return;
        }

        const len = this.proxies.length;
        for (let i = 0; i < len; i++) {
          const idx = (this.index + i) % len;
          if (this.active[idx] < this.maxPerProxy) {
            this.active[idx]++;
            this.index = (idx + 1) % len;
            const proxyUrl = this.proxies[idx];
            const release  = () => this._release(idx);
            resolve({ proxyUrl, proxyIndex: idx, release });
            return;
          }
        }

        // All proxies at capacity — queue this waiter
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          const pos = this._waiters.indexOf(wrapper);
          if (pos !== -1) this._waiters.splice(pos, 1);
          reject(new Error(`ProxyRotator: all ${this.proxies.length} proxies busy after ${this.acquireTimeout}ms`));
        }, this.acquireTimeout);

        const wrapper = () => {
          if (timedOut) return;
          clearTimeout(timer);
          tryAcquire();
        };
        this._waiters.push(wrapper);
      };

      tryAcquire();
    });
  }

  _release(idx) {
    if (this.active[idx] > 0) this.active[idx]--;
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      setImmediate(waiter);
    }
  }

  async nextAgent() {
    const url = this.next();
    if (!url) return null;
    return makeProxyAgent(url);
  }

  summary() {
    const busy = this.active.filter(n => n > 0).length;
    return `${this.proxies.length} proxies (maxPerProxy=${this.maxPerProxy}, ${busy} in use)`;
  }

  get availableCount() {
    return this.active.filter((n, i) => i < this.proxies.length && n < this.maxPerProxy).length;
  }
}

module.exports = { normalizeProxy, parseProxyList, makeProxyAgent, testProxy, ProxyRotator };
