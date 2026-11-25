// Функция Vercel: POST /api/token { room, name } → пропуск в комнату LiveKit.
// Переменные окружения задаются в настройках проекта Vercel: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
import { issueToken, readLiveKitEnv } from '../server/token.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad-request' });

  const { status, json } = await issueToken(body, {
    livekit: readLiveKitEnv(),
    maxPeers: Number(process.env.MAX_PEERS_PER_ROOM) || 8,
  });
  return res.status(status).json(json);
}
