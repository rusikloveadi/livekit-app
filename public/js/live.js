// Связь с комнатой через LiveKit: участники, показ экрана (видео + звук), чат.
//
// Ведущий отправляет поток один раз — сервер LiveKit сам раздаёт его каждому зрителю
// и пробивается даже через «закрытые» сети (мобильный интернет, корпоративный Wi-Fi).
// Чат идёт тем же каналом (data-сообщения); историю новичку отправляет тот, кто в комнате дольше всех.
import { Room, RoomEvent, Track, ConnectionState, setLogLevel } from '/vendor/livekit-client.js';

setLogLevel('warn');

export const QUALITY = {
  eco: { label: '720p · экономный', width: 1280, height: 720, bitrate: 2_000_000 },
  high: { label: '1080p · хороший', width: 1920, height: 1080, bitrate: 4_500_000 },
  max: { label: '1080p · максимум', width: 1920, height: 1080, bitrate: 8_000_000 },
};
export const DEFAULT_QUALITY = 'high';

const AUDIO_BITRATE = 128_000;
const CHAT_MAX = 500;
const NAME_MAX = 24;
const HISTORY_MAX = 100;
const HISTORY_CHUNK_BYTES = 12_000; // одно data-сообщение LiveKit — не больше ~15 КБ
const SCREEN_SOURCES = new Set([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
const INVISIBLE = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const noop = () => {};

const clip = (text, max) => Array.from(text).slice(0, max).join('');
export const cleanText = (value) => clip(String(value ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim(), CHAT_MAX);
const cleanName = (value) => clip(String(value ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), NAME_MAX) || 'Гость';
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Просим у своего сервера пропуск в комнату. Ошибка содержит code: bad-room, room-full, not-configured, network. */
export async function requestToken(room, name) {
  let res;
  try {
    res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, name }),
      cache: 'no-store',
    });
  } catch {
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* не JSON — разберёмся по коду ответа */
  }
  if (!res.ok || !data?.token) {
    const code = data?.error || (res.status === 404 ? 'not-configured' : 'network');
    throw Object.assign(new Error(code), { code });
  }
  return data; // { url, token, identity, name }
}

export function createLive(handlers = {}) {
  const on = {
    connection: noop, // 'online' | 'offline'
    peers: noop, // список участников, их имена или «смотрит» изменились
    presenter: noop, // (id, previousId) — кто показывает экран
    stream: noop, // MediaStream с картинкой и звуком ведущего (или null)
    link: noop, // 'connecting' | 'failed' — как дела с получением картинки
    chat: noop, // (message, { history })
    stats: noop, // для ведущего: { kbps, limited }
    conflict: noop, // (name) — кто-то начал показ одновременно с нами, экран остался у него
    disconnected: noop, // связь потеряна окончательно
    ...handlers,
  };

  const room = new Room({
    adaptiveStream: false, // показ должен идти в полном качестве, даже когда вкладка в фоне или видео в «картинке в картинке»
    dynacast: false,
    disconnectOnPageLeave: true,
    stopLocalTrackOnUnpublish: true,
  });

  const history = []; // последние сообщения — отдаём тем, кто зашёл позже
  let leaving = false;
  let presenterId = null;
  let share = null; // { stream, quality, video, audio, timer, lastBytes, lastAt, limitedStreak }
  let inbound = null; // { from, stream }
  let historyBuffer = null; // ответы с историей, пока собираем их после входа

  const me = () => room.localParticipant;

  // ——— участники ———

  function peers() {
    return [...room.remoteParticipants.values()].map((p) => ({
      id: p.identity,
      name: cleanName(p.name),
      online: true,
      watching: p.attributes?.watching === '1',
    }));
  }

  // ——— кто показывает экран ———

  function findPresenter() {
    if (share) return me().identity;
    const ids = [...room.remoteParticipants.values()]
      .filter((p) => p.getTrackPublication(Track.Source.ScreenShare))
      .map((p) => p.identity)
      .sort();
    return ids[0] ?? null;
  }

  function refreshPresenter() {
    // Двое нажали «Показать экран» одновременно: экран остаётся у того, чей id «меньше».
    if (share) {
      const rival = [...room.remoteParticipants.values()].find(
        (p) => p.getTrackPublication(Track.Source.ScreenShare) && p.identity < me().identity,
      );
      if (rival) {
        stopShare();
        on.conflict(cleanName(rival.name));
        return;
      }
    }
    const next = findPresenter();
    if (next === presenterId) return;
    const previous = presenterId;
    presenterId = next;
    if (inbound && inbound.from !== next) {
      inbound = null;
      on.stream(null);
    }
    on.presenter(next, previous);
    if (next && next !== me().identity) attachExisting(next);
  }

  // ——— получаем картинку ведущего ———

  function addToInbound(mediaTrack, from) {
    if (!inbound || inbound.from !== from) inbound = { from, stream: new MediaStream() };
    const { stream } = inbound;
    if (!stream.getTracks().includes(mediaTrack)) {
      for (const t of stream.getTracks()) if (t.kind === mediaTrack.kind) stream.removeTrack(t);
      stream.addTrack(mediaTrack);
    }
    on.stream(stream);
  }

  function attachExisting(id) {
    const p = room.remoteParticipants.get(id);
    if (!p) return;
    let hasVideo = false;
    for (const pub of p.trackPublications.values()) {
      if (!SCREEN_SOURCES.has(pub.source) || !pub.track?.mediaStreamTrack) continue;
      addToInbound(pub.track.mediaStreamTrack, id);
      if (pub.source === Track.Source.ScreenShare) hasVideo = true;
    }
    if (!hasVideo) on.link('connecting');
  }

  function onSubscribed(track, publication, participant) {
    if (!SCREEN_SOURCES.has(publication.source)) return;
    refreshPresenter();
    if (participant.identity !== presenterId) return;
    addToInbound(track.mediaStreamTrack, participant.identity);
  }

  function onUnsubscribed(track, publication, participant) {
    if (!inbound || inbound.from !== participant.identity) return;
    if (track.mediaStreamTrack) inbound.stream.removeTrack(track.mediaStreamTrack);
    if (publication.source === Track.Source.ScreenShare && participant.identity === presenterId) on.link('connecting');
  }

  /** Попросить картинку заново (кнопка «Переподключиться» у зрителя). */
  function resubscribe() {
    const p = presenterId && room.remoteParticipants.get(presenterId);
    if (!p) return;
    on.link('connecting');
    for (const pub of p.trackPublications.values()) {
      if (!SCREEN_SOURCES.has(pub.source)) continue;
      pub.setSubscribed(false);
      setTimeout(() => pub.setSubscribed(true), 400);
    }
  }

  async function setWatching(watching) {
    if (room.state !== ConnectionState.Connected) return;
    try {
      await me().setAttributes({ watching: watching ? '1' : '' });
    } catch {
      /* не страшно: ведущий просто не увидит отметку «смотрит» */
    }
  }

  // ——— показываем свой экран ———

  async function startShare(stream, { quality = DEFAULT_QUALITY, hint = 'motion', codec = 'h264' } = {}) {
    const [video] = stream.getVideoTracks();
    const [audio] = stream.getAudioTracks();
    const q = QUALITY[quality] ?? QUALITY[DEFAULT_QUALITY];
    video.contentHint = hint;
    share = { stream, quality, video: null, audio: null, timer: null, lastBytes: null, lastAt: 0, limitedStreak: 0 };
    refreshPresenter();
    try {
      const encoding = { maxBitrate: q.bitrate, maxFramerate: 30 };
      share.video = await me().publishTrack(video, {
        source: Track.Source.ScreenShare,
        name: 'screen',
        stream: 'screen',
        simulcast: false,
        videoCodec: codec,
        videoEncoding: encoding,
        screenShareEncoding: encoding,
        degradationPreference: hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
      });
      if (audio && share) {
        // звук фильма: стерео, высокий битрейт, без «экономии тишины»
        share.audio = await me().publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          name: 'screen-audio',
          stream: 'screen',
          dtx: false,
          red: false,
          forceStereo: true,
          audioPreset: { maxBitrate: AUDIO_BITRATE },
        });
      }
    } catch (err) {
      await stopShare();
      throw err;
    }
    if (share) share.timer = setInterval(collectStats, 3000);
  }

  async function stopShare() {
    if (!share) return;
    const current = share;
    share = null;
    clearInterval(current.timer);
    for (const pub of [current.video, current.audio]) {
      if (!pub?.track) continue;
      try {
        await me().unpublishTrack(pub.track, true);
      } catch {
        /* уже снято */
      }
    }
    for (const t of current.stream.getTracks()) t.stop();
    refreshPresenter();
  }

  function setQuality(quality) {
    if (!share) return;
    share.quality = quality;
    const q = QUALITY[quality] ?? QUALITY[DEFAULT_QUALITY];
    const [video] = share.stream.getVideoTracks();
    video?.applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { max: 30 } }).catch(() => {});
    const sender = share.video?.track?.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = q.bitrate;
    sender.setParameters(params).catch(() => {});
  }

  function setContentHint(hint) {
    if (!share) return;
    for (const t of share.stream.getVideoTracks()) t.contentHint = hint;
  }

  async function collectStats() {
    if (!share) return;
    let bytes = 0;
    let limited = null;
    for (const pub of [share.video, share.audio]) {
      const sender = pub?.track?.sender;
      if (!sender) continue;
      try {
        const report = await sender.getStats();
        report.forEach((r) => {
          if (r.type !== 'outbound-rtp') return;
          bytes += r.bytesSent ?? 0;
          if (r.kind === 'video' && r.qualityLimitationReason && r.qualityLimitationReason !== 'none') limited = r.qualityLimitationReason;
        });
      } catch {
        /* соединение пересоздаётся — пропустим замер */
      }
    }
    if (!share) return;
    const now = performance.now();
    const kbps = share.lastBytes == null ? null : Math.max(0, Math.round(((bytes - share.lastBytes) * 8) / (now - share.lastAt)));
    share.lastBytes = bytes;
    share.lastAt = now;
    // в первые секунды оценка канала только растёт — предупреждаем лишь о стойкой нехватке
    share.limitedStreak = limited ? share.limitedStreak + 1 : 0;
    on.stats({ kbps, limited: share.limitedStreak >= 2 ? limited : null });
  }

  // ——— чат ———

  function remember(message) {
    if (history.some((m) => m.id === message.id)) return false;
    history.push(message);
    if (history.length > HISTORY_MAX) history.shift();
    return true;
  }

  async function sendChat(text) {
    const clean = cleanText(text);
    if (!clean) return null;
    const message = { id: randomId(), from: me().identity, name: cleanName(me().name), text: clean, ts: Date.now() };
    await me().publishData(encoder.encode(JSON.stringify({ id: message.id, text: clean })), { reliable: true, topic: 'chat' });
    remember(message);
    return message;
  }

  // Историю новичку присылают все, у кого она есть: кто-то мог зайти позже и знать не всё.
  // Новичок собирает ответы, убирает повторы и показывает сообщения по времени.
  async function sendHistory(to) {
    if (!history.length) return;
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const payload = encoder.encode(JSON.stringify({ items: chunk }));
      chunk = [];
      size = 0;
      await me().publishData(payload, { reliable: true, topic: 'chat-history', destinationIdentities: [to] });
    };
    for (const m of history) {
      const bytes = encoder.encode(JSON.stringify(m)).length;
      if (size + bytes > HISTORY_CHUNK_BYTES) await flush();
      chunk.push(m);
      size += bytes;
    }
    await flush();
  }

  // participant бывает undefined, если сообщение пришло раньше, чем мы узнали о новом участнике, —
  // тогда его id лежит в последнем аргументе.
  function onData(payload, participant, _kind, topic, _encryption, participantIdentity) {
    const senderId = participant?.identity ?? participantIdentity;
    if (!senderId) return;
    const senderName = cleanName(participant?.name ?? room.remoteParticipants.get(senderId)?.name);
    let data;
    try {
      data = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    if (topic === 'chat') {
      const text = cleanText(data?.text);
      if (!text) return;
      // имя берём у сервера (из пропуска), а не из сообщения — подделать его нельзя
      const message = { id: clip(String(data.id ?? randomId()), 32), from: senderId, name: senderName, text, ts: Date.now() };
      if (remember(message)) on.chat(message, { history: false });
    } else if (topic === 'chat-history-request') {
      sendHistory(senderId).catch(() => {});
    } else if (topic === 'chat-history' && Array.isArray(data?.items)) {
      for (const item of data.items) {
        const text = cleanText(item?.text);
        if (!text) continue;
        const message = {
          id: clip(String(item.id ?? randomId()), 32),
          from: clip(String(item.from ?? ''), 64),
          name: cleanName(item.name),
          text,
          ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : Date.now(),
        };
        if (historyBuffer) historyBuffer.set(message.id, message);
        else if (remember(message)) on.chat(message, { history: true });
      }
    }
  }

  function flushHistory() {
    if (!historyBuffer) return;
    const items = [...historyBuffer.values()].sort((a, b) => a.ts - b.ts);
    historyBuffer = null;
    for (const message of items) if (remember(message)) on.chat(message, { history: true });
  }

  // ——— события комнаты ———

  room
    .on(RoomEvent.ParticipantConnected, () => on.peers())
    .on(RoomEvent.ParticipantDisconnected, () => {
      refreshPresenter();
      on.peers();
    })
    .on(RoomEvent.ParticipantNameChanged, () => on.peers())
    .on(RoomEvent.ParticipantAttributesChanged, () => on.peers())
    .on(RoomEvent.TrackPublished, () => refreshPresenter())
    .on(RoomEvent.TrackUnpublished, () => refreshPresenter())
    .on(RoomEvent.TrackSubscribed, onSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
    .on(RoomEvent.TrackSubscriptionFailed, (_sid, participant) => {
      if (participant?.identity === presenterId) on.link('failed');
    })
    .on(RoomEvent.DataReceived, onData)
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Connected) on.connection('online');
      else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) on.connection('offline');
    })
    .on(RoomEvent.Disconnected, () => {
      if (share) {
        clearInterval(share.timer);
        for (const t of share.stream.getTracks()) t.stop();
        share = null;
      }
      if (!leaving) on.disconnected();
    });

  return {
    async connect(url, token) {
      await room.connect(url, token, { autoSubscribe: true });
      on.connection('online');
      on.peers();
      refreshPresenter();
      // попросим историю чата у тех, кто уже в комнате
      if (room.remoteParticipants.size) {
        historyBuffer = new Map();
        setTimeout(flushHistory, 1500);
        me().publishData(encoder.encode('{}'), { reliable: true, topic: 'chat-history-request' }).catch(() => {});
      }
    },
    me: () => ({ identity: me().identity, name: cleanName(me().name) }),
    peers,
    presenter: () => presenterId,
    startShare,
    stopShare,
    setQuality,
    setContentHint,
    setWatching,
    resubscribe,
    sendChat,
    async rename(name) {
      await me().setName(cleanName(name));
    },
    leave() {
      leaving = true;
      stopShare();
      return room.disconnect();
    },
  };
}
