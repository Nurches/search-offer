// Finds contact emails on a business website: homepage + likely contact/careers pages.
import dns from 'node:dns/promises';
import net from 'node:net';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,24}/gi;
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|woff2?|ttf|eot|mp4|webm|pdf)$/i;
const JUNK_DOMAINS = [
  'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain.com', 'yoursite.com', 'mysite.com',
  'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com', 'sentry.wixpress.com', 'squarespace.com',
  'schema.org', 'w3.org', 'godaddy.com', 'wordpress.com', 'wordpress.org', 'mailchimp.com', 'yelp.com',
  'tripadvisor.com', 'sentry.dev', 'cloudflare.com', 'googlegroups.com', 'gstatic.com', 'jquery.com',
];
const JUNK_LOCAL = /^(name|user|username|your|youremail|email|example|test|someone|john\.?doe|jane\.?doe|first\.?last|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|privacy|webmaster|wordpress)$/i;
const HR_LOCAL = /^(jobs?|careers?|hr|humanresources|human\.resources|employment|hiring|recruit\w*|apply|work|staffing|seasonal|summerjobs?|personnel)$/i;
const GENERAL_LOCAL = /^(info|contact|hello|office|frontdesk|front\.desk|reservations?|manager|gm|generalmanager|management|admin\w*|events|guestservices|guest\.services)$/i;
const LINK_HINT = /(career|job|employ|hiring|work-?with-?us|join|recruit|seasonal|staff|contact|about|team)/i;

export function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&commat;|&#0*64;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/g, '&');
}

/** Extracts candidate emails from raw HTML. */
export function extractEmails(html) {
  const found = new Set();
  const add = (e) => {
    const clean = cleanEmail(e);
    if (clean) found.add(clean);
  };
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try { add(decodeURIComponent(m[1])); } catch { add(m[1]); }
  }
  const text = decodeEntities(html)
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  for (const m of text.matchAll(EMAIL_RE)) add(m[0]);
  return [...found];
}

export function cleanEmail(raw) {
  if (!raw) return null;
  let e = String(raw).trim().toLowerCase()
    .replace(/^(u003e|u0022|x22|%20)+/, '')
    .replace(/[.,;:]+$/, '');
  const m = e.match(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/);
  if (!m) return null;
  e = m[0];
  const [local, domain] = e.split('@');
  if (ASSET_EXT_RE.test(e)) return null;
  if (JUNK_LOCAL.test(local)) return null;
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  if (/^[0-9a-f]{16,}$/.test(local)) return null; // tracking hashes (e.g. Sentry DSNs)
  if (local.length > 48) return null;
  return e;
}

export function rankEmails(emails, siteHost = '') {
  const host = siteHost.replace(/^www\./, '');
  const base = host.split('.').slice(-2).join('.');
  const score = (e) => {
    const [local, domain] = e.split('@');
    let s = 0;
    if (base && (domain === base || domain.endsWith(`.${base}`))) s += 3;
    if (HR_LOCAL.test(local)) s += 3;
    else if (GENERAL_LOCAL.test(local)) s += 1;
    return s;
  };
  return [...new Set(emails)].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** Picks same-site links that likely lead to contact / careers info. */
export function pickContactLinks(html, pageUrl, max = 5) {
  const base = new URL(pageUrl);
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const [, href, inner] = m;
    if (/^(mailto|tel|javascript):/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (ASSET_EXT_RE.test(u.pathname)) continue;
    const label = `${u.pathname} ${inner.replace(/<[^>]+>/g, ' ')}`;
    if (!LINK_HINT.test(label)) continue;
    u.hash = '';
    const key = u.href;
    if (key === base.href) continue;
    const prio = /(career|job|employ|hiring|recruit|seasonal|join)/i.test(label) ? 0 : /contact/i.test(label) ? 1 : 2;
    if (!out.has(key) || out.get(key) > prio) out.set(key, prio);
  }
  return [...out.entries()].sort((a, b) => a[1] - b[1]).slice(0, max).map(([k]) => k);
}

// ---------- safe fetching (SSRF protection) ----------
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return true;
}

async function assertPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Только http/https');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Недопустимый порт');
  if (u.username || u.password) throw new Error('Недопустимый URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Адрес недоступен');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 1_500_000;

export async function safeFetchText(url, { timeoutMs = 9000, fetchImpl = fetch, checkUrl = assertPublicUrl } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop += 1) {
    await checkUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current.href, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) return { url: current.href, html: '' };
      const reader = res.body?.getReader?.();
      if (!reader) return { url: current.href, html: (await res.text()).slice(0, MAX_BYTES) };
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) { await reader.cancel(); break; }
      }
      return { url: current.href, html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Слишком много редиректов');
}

const cache = new Map();
const CACHE_MS = 24 * 3600 * 1000;

/** Crawls a site (homepage + up to 5 contact-like pages) and returns ranked emails. */
export async function findEmailsOnSite(siteUrl, opts = {}) {
  const start = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  const key = start.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const pages = [];
  const emails = new Set();
  const home = await safeFetchText(start.href, opts);
  pages.push(home.url);
  extractEmails(home.html).forEach((e) => emails.add(e));

  const links = pickContactLinks(home.html, home.url);
  const results = await Promise.allSettled(links.map((l) => safeFetchText(l, opts)));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    pages.push(r.value.url);
    extractEmails(r.value.html).forEach((e) => emails.add(e));
  }
  const value = { emails: rankEmails([...emails], new URL(home.url).hostname).slice(0, 8), pages };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return value;
}
