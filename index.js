// Локальный запуск: читает .env, поднимает сайт и печатает адреса.
// На Vercel этот файл не нужен — там работают public/ и api/token.js.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readLiveKitEnv } from './token.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Мини-загрузчик .env (чтобы не тянуть лишнюю зависимость). Уже заданные переменные не трогает.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function lanAddresses() {
  const found = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const i of items ?? []) {
      if (i.family === 'IPv4' && !i.internal) found.push(i.address);
    }
  }
  return found;
}

// Windows разрешает занять порт «поверх» чужой программы, слушающей все адреса, — и тогда
// http://localhost:порт ведёт к чужой программе, а не к нам. Поэтому сначала проверяем,
// не отвечает ли на этом порту уже кто-то.
function somethingListens(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      socket.setTimeout(700);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((answers) => answers.some(Boolean));
}

loadEnvFile(path.join(root, '.env'));

const port = Number(process.env.PORT) || 3737;
// Дома слушаем только этот компьютер: Windows не спрашивает про брандмауэр, и сайт не виден в сети.
// На хостинге (там задан PORT) слушаем все адреса. Явно можно задать через HOST.
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const listensOnNetwork = host === '0.0.0.0' || host === '::';
const livekit = readLiveKitEnv();

const app = createApp({
  publicDir: path.join(root, 'public'),
  livekit,
  maxPeers: Number(process.env.MAX_PEERS_PER_ROOM) || 8,
});

const portBusy = () => {
  console.error(
    `\nПорт ${port} уже занят другой программой (возможно, сайт уже запущен в другом окне).\n` +
      `Закрой её или запусти сайт на другом порту:\n  $env:PORT=${port + 1}; npm start\n`,
  );
  process.exit(1);
};

if (await somethingListens(port)) portBusy();

try {
  await app.listen(port, host);
} catch (err) {
  if (err.code === 'EADDRINUSE') portBusy();
  console.error(err);
  process.exit(1);
}

// Адрес даём цифрами: «localhost» на Windows может вести и на IPv4, и на IPv6 (и не туда).
console.log('\nКиновечер запущен');
console.log(`  На этом компьютере:  http://127.0.0.1:${port}`);
if (listensOnNetwork) {
  for (const ip of lanAddresses()) {
    console.log(`  В домашней сети:     http://${ip}:${port}   (смотреть можно, показывать экран — только с localhost или по https)`);
  }
}
if (livekit) {
  console.log(`  Видео и чат идут через LiveKit: ${livekit.url}`);
} else {
  console.log('\n  ⚠ Не заданы LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET — войти в комнату не получится.');
  console.log('    Скопируй .env.example в .env и впиши данные своего проекта LiveKit Cloud (см. README).');
}
console.log('\nОстановить: Ctrl+C\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
