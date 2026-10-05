// API handlers shared by the local Node server (server/index.js) and Vercel functions (api/*.js).
// They take plain Node (req, res) objects, which is also what Vercel passes in.
import crypto from 'node:crypto';
import { findEmailsOnSite } from './emails.js';
import { searchPlaces } from './places.js';
import { jobsConfig, searchJobs } from './jobs.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const googleKey = () => process.env.GOOGLE_MAPS_API_KEY || '';
// Each page = one billed Text Search request (20 results). Default 1 page to stay in the free tier.
const googleMaxPages = () => Math.min(Math.max(Number(process.env.GOOGLE_MAX_PAGES) || 1, 1), 3);

// ---------- tiny per-IP rate limiter (per instance) ----------
const buckets = new Map();
function rateLimited(ip, key, perMinute) {
  const id = `${ip}|${key}`;
  const now = Date.now();
  const b = buckets.get(id) || { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) { buckets.set(id, b); return true; }
  b.tokens -= 1;
  buckets.set(id, b);
  if (buckets.size > 10000) buckets.clear();
  return false;
}

export function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
const queryOf = (req) => new URL(req.url, 'http://localhost').searchParams;

async function readBody(req, limit = 32 * 1024) {
  // Vercel exposes a lazily parsed req.body; plain Node needs the stream read.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    if (req.body && typeof req.body === 'object') return new URLSearchParams(req.body).toString();
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  // Vercel already parses JSON bodies into req.body.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

function wrap(fn) {
  return async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      }
      return await fn(req, res);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  };
}

export const health = wrap(async (req, res) => send(res, 200, {
  app: 'wt-job-finder', emails: true, places: Boolean(googleKey()), jobs: jobsConfig(),
  // OAuth client IDs are public by design (they ship to the browser).
  oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
}, { 'Cache-Control': 'no-store' }));

export const emails = wrap(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (rateLimited(clientIp(req), 'emails', 90)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
  const site = queryOf(req).get('url');
  if (!site) return send(res, 400, { error: 'url required' });
  return send(res, 200, await findEmailsOnSite(site));
});

const overpassCache = new Map();
export const overpass = wrap(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (rateLimited(clientIp(req), 'overpass', 20)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
  const query = new URLSearchParams(await readBody(req)).get('data') || '';
  if (!query.startsWith('[out:json]')) return send(res, 400, { error: 'Bad query' });
  const key = crypto.createHash('sha1').update(query).digest('hex');
  const hit = overpassCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return send(res, 200, hit.body, { 'Content-Type': 'application/json' });

  // Stay under the 60 s function limit; the browser falls back to mirrors directly on failure.
  const deadline = Date.now() + 50_000;
  let lastErr;
  for (const url of OVERPASS) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'wt-job-finder/1.0' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(Math.min(left, 45_000)),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.text();
      if (!body.trimStart().startsWith('{')) throw new Error('Invalid response');
      overpassCache.set(key, { at: Date.now(), body });
      if (overpassCache.size > 300) overpassCache.delete(overpassCache.keys().next().value);
      return send(res, 200, body, { 'Content-Type': 'application/json' });
    } catch (e) {
      lastErr = e;
    }
  }
  return send(res, 502, { error: `Overpass недоступен: ${lastErr?.message}` });
});

export const places = wrap(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  const apiKey = googleKey();
  if (!apiKey) return send(res, 501, { error: 'На сервере не задан GOOGLE_MAPS_API_KEY' });
  if (rateLimited(clientIp(req), 'places', 30)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
  const q = queryOf(req);
  const text = (q.get('q') || '').slice(0, 200);
  if (!text) return send(res, 400, { error: 'q required' });
  const list = await searchPlaces({
    apiKey,
    query: text,
    lat: Number(q.get('lat')),
    lon: Number(q.get('lon')),
    radius: Number(q.get('radius')),
    maxPages: googleMaxPages(),
  });
  return send(res, 200, { places: list });
});

export const jobs = wrap(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (rateLimited(clientIp(req), 'jobs', 20)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
  const body = await readJson(req);
  const result = await searchJobs({
    q: body.q,
    where: body.where,
    cursors: body.cursors && typeof body.cursors === 'object' ? body.cursors : {},
    boards: Array.isArray(body.boards) ? body.boards.map(String).slice(0, 40) : [],
    more: Boolean(body.more),
  });
  return send(res, 200, result, { 'Cache-Control': 'no-store' });
});

export const routes = {
  '/api/health': health,
  '/api/emails': emails,
  '/api/overpass': overpass,
  '/api/places': places,
  '/api/jobs': jobs,
};
