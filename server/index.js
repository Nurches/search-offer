// W&T Job Finder local server: serves the site from public/ and the API from handlers.js.
// No dependencies (Node 18+). On Vercel the same handlers run as functions in api/.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, send } from './handlers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

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
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const handler = routes[pathname];
      if (handler) return await handler(req, res);
      if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(req, res, pathname);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`W&T Job Finder: http://localhost:${PORT}  (Google Places: ${process.env.GOOGLE_MAPS_API_KEY ? 'on' : 'off'})`);
  });
}
