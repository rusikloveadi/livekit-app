// Локальный сервер: раздаёт страницы из public/ и выдаёт пропуска в комнаты LiveKit (POST /api/token).
// На Vercel то же самое делают статика из public/ (vercel.json) и функция api/token.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { issueToken, liveKitConnectSources } from './token.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// /r/abcd-efgh — страница комнаты (одна и та же для любого кода)
const ROOM_PATH = /^\/r\/[a-z0-9]{4}-[a-z0-9]{4}\/?$/i;
const MAX_BODY = 4096;

/** Политика безопасности страницы: свои скрипты и стили, подключаться можно только к себе и к LiveKit. */
export function buildCsp(livekit) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    ["connect-src 'self'", ...liveKitConnectSources(livekit)].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createApp({ publicDir, livekit = null, maxPeers = 8, countParticipants } = {}) {
  if (!publicDir) throw new Error('createApp: нужен publicDir');
  const root = path.resolve(publicDir);
  const csp = buildCsp(livekit);

  function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Код комнаты лежит в адресе — не отдаём его другим сайтам через Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'display-capture=(self), camera=(), microphone=(), geolocation=()');
  }

  function serveFile(req, res, file, status = 200) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        if (status === 404) return plain(res, 404, 'Не найдено');
        return serveFile(req, res, path.join(root, '404.html'), 404);
      }
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
    });
  }

  async function handleToken(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'method' });
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        json(res, 413, { error: 'too-large' });
        req.destroy();
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'bad-request' });
    }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad-request' });
    const result = await issueToken(body, { livekit, maxPeers, count: countParticipants });
    json(res, result.status, result.json);
  }

  function handle(req, res) {
    setSecurityHeaders(res);

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return plain(res, 400, 'Некорректный адрес');
    }
    if (pathname.includes('\0')) return plain(res, 400, 'Некорректный адрес');

    if (pathname === '/api/token') {
      handleToken(req, res).catch((err) => {
        console.error('[token]', err);
        if (!res.headersSent) json(res, 500, { error: 'internal' });
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    if (pathname === '/healthz') return plain(res, 200, 'ok');

    let rel;
    if (pathname === '/') rel = 'index.html';
    else if (ROOM_PATH.test(pathname)) rel = 'room.html';
    else rel = pathname.slice(1);

    // скрытые файлы и выход за пределы public/ — нельзя
    if (rel.split(/[\\/]/).some((part) => part.startsWith('.'))) return serveFile(req, res, '', 404);
    const file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return serveFile(req, res, '', 404);

    serveFile(req, res, file);
  }

  const server = http.createServer(handle);

  return {
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
