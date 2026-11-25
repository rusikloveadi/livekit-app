// «Пропуск» в комнату LiveKit: JWT (HS256), подписанный секретом проекта LiveKit.
// Один и тот же код работает и на Vercel (api/token.js), и при локальном запуске (server/app.js).
// Секрет никогда не уходит в браузер — браузер получает только подписанный пропуск на одну комнату.
import crypto from 'node:crypto';

export const CODE_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

const NAME_MAX = 24;
// управляющие и «невидимые» символы, в том числе переворачивающие текст (bidi)
const INVISIBLE = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
const TOKEN_TTL_SECONDS = 6 * 60 * 60; // хватит на длинный фильм; LiveKit сам продлевает пропуск, пока ты в комнате

export function cleanName(value) {
  const text = String(value ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, NAME_MAX).join('') || 'Гость';
}

const base64url = (value) => Buffer.from(value).toString('base64url');

export function signJwt(payload, secret) {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/**
 * Пропуск участника: может войти только в свою комнату, смотреть, писать в чат,
 * менять своё имя и показывать экран — камера и микрофон ему не разрешены.
 */
export function createAccessToken({ apiKey, apiSecret, identity, name, room, ttlSeconds = TOKEN_TTL_SECONDS }) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: apiKey,
      sub: identity,
      jti: identity,
      name,
      nbf: now - 10,
      exp: now + ttlSeconds,
      video: {
        room,
        roomJoin: true,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        canPublishSources: ['screen_share', 'screen_share_audio'],
        canUpdateOwnMetadata: true,
      },
    },
    apiSecret,
  );
}

/** Настройки LiveKit из переменных окружения; null — если сайт ещё не настроен. */
export function readLiveKitEnv(env = process.env) {
  const url = String(env.LIVEKIT_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = String(env.LIVEKIT_API_KEY ?? '').trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET ?? '').trim();
  if (!url || !apiKey || !apiSecret) return null;
  if (!/^wss?:\/\//i.test(url)) return null;
  return { url, apiKey, apiSecret };
}

/** Адрес API LiveKit: wss://x.livekit.cloud → https://x.livekit.cloud */
export const apiUrl = (url) => url.replace(/^ws(s?):\/\//i, 'http$1://');

/** Сколько человек уже в комнате (через серверный API LiveKit). */
export async function countParticipants(livekit, room, { timeoutMs = 3000 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const adminToken = signJwt(
    { iss: livekit.apiKey, nbf: now - 10, exp: now + 60, video: { room, roomAdmin: true } },
    livekit.apiSecret,
  );
  const res = await fetch(`${apiUrl(livekit.url)}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return 0; // комнаты ещё нет — значит, никого нет
  if (!res.ok) throw new Error(`LiveKit ответил ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.participants) ? data.participants.length : 0;
}

/**
 * Обработка запроса «дай пропуск»: { room, name } → { url, token, identity, name }.
 * Возвращает { status, json } — так один код подходит и для Vercel, и для локального сервера.
 */
export async function issueToken(body, { livekit, maxPeers = 8, count = countParticipants } = {}) {
  if (!livekit) return { status: 503, json: { error: 'not-configured' } };
  const room = String(body?.room ?? '').toLowerCase();
  if (!CODE_RE.test(room)) return { status: 400, json: { error: 'bad-room' } };
  const name = cleanName(body?.name);

  try {
    if ((await count(livekit, room)) >= maxPeers) return { status: 403, json: { error: 'room-full' } };
  } catch (err) {
    // Не смогли посчитать — пускаем: лучше лишний гость, чем не пустить друзей из-за сбоя.
    console.warn('[token] не удалось узнать, сколько человек в комнате:', err.message);
  }

  const identity = `u-${crypto.randomBytes(6).toString('hex')}`;
  const token = createAccessToken({ ...livekit, identity, name, room });
  return { status: 200, json: { url: livekit.url, token, identity, name } };
}

/** Хосты LiveKit, к которым странице можно подключаться (для заголовка Content-Security-Policy). */
export function liveKitConnectSources(livekit) {
  if (!livekit) return [];
  const { host, protocol } = new URL(livekit.url);
  const secure = protocol === 'wss:';
  return [`${secure ? 'wss' : 'ws'}://${host}`, `${secure ? 'https' : 'http'}://${host}`];
}
