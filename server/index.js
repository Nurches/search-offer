// W&T Job Finder server: serves the site and adds email discovery, an Overpass proxy
// with caching, and optional Google Places search. No dependencies (Node 18+).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findEmailsOnSite } from './emails.js';
import { searchPlaces } from './places.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

// ---------- tiny per-IP rate limiter ----------
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

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- Overpass proxy with cache ----------
const overpassCache = new Map();
async function handleOverpass(req, res) {
  const raw = await readBody(req);
  const query = new URLSearchParams(raw).get('data') || '';
  if (!query.startsWith('[out:json]')) return send(res, 400, { error: 'Bad query' });
  const key = crypto.createHash('sha1').update(query).digest('hex');
  const hit = overpassCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return send(res, 200, hit.body, { 'Content-Type': 'application/json' });

  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'wt-job-finder/1.0' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(130_000),
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
}

// ---------- static files ----------
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, `.${rel}`);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, 'Forbidden');
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    try {
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      }
      if (url.pathname === '/api/health') {
        return send(res, 200, { app: 'wt-job-finder', emails: true, places: Boolean(GOOGLE_KEY) });
      }
      if (url.pathname === '/api/emails' && req.method === 'GET') {
        if (rateLimited(ip, 'emails', 90)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
        const site = url.searchParams.get('url');
        if (!site) return send(res, 400, { error: 'url required' });
        const result = await findEmailsOnSite(site);
        return send(res, 200, result);
      }
      if (url.pathname === '/api/overpass' && req.method === 'POST') {
        if (rateLimited(ip, 'overpass', 20)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
        return await handleOverpass(req, res);
      }
      if (url.pathname === '/api/places' && req.method === 'GET') {
        if (!GOOGLE_KEY) return send(res, 501, { error: 'На сервере не задан GOOGLE_MAPS_API_KEY' });
        if (rateLimited(ip, 'places', 30)) return send(res, 429, { error: 'Слишком часто, подожди минуту' });
        const q = (url.searchParams.get('q') || '').slice(0, 200);
        if (!q) return send(res, 400, { error: 'q required' });
        const places = await searchPlaces({
          apiKey: GOOGLE_KEY,
          query: q,
          lat: Number(url.searchParams.get('lat')),
          lon: Number(url.searchParams.get('lon')),
          radius: Number(url.searchParams.get('radius')),
        });
        return send(res, 200, { places });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`W&T Job Finder: http://localhost:${PORT}  (Google Places: ${GOOGLE_KEY ? 'on' : 'off'})`);
  });
}
