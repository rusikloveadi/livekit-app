// Страница комнаты: список участников, чат, показ экрана и просмотр чужого экрана.
// Связь с комнатой (LiveKit) — в live.js, здесь только интерфейс.
import { $, el, avatar, icon, toast, copyText, addressScope, ROOM_CODE_RE } from './common.js';
import { createLive, requestToken, QUALITY, DEFAULT_QUALITY } from './live.js';

const code = location.pathname.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';

if (ROOM_CODE_RE.test(code)) main();
else location.replace('/');

function main() {
  const baseTitle = `Комната ${code} · Киновечер`;
  // ?codec=vp8 — запасной вариант, если у ведущего рябит или пропадает картинка (по умолчанию H.264 — его кодирует видеокарта)
  const preferCodec = (new URLSearchParams(location.search).get('codec') || 'h264').toLowerCase();
  const supportsShare = Boolean(navigator.mediaDevices?.getDisplayMedia);

  const ui = {
    stage: $('#stage'),
    video: $('#video'),
    preview: $('#preview'),
    previewOff: $('#preview-off'),
    previewOn: $('#preview-on'),
    previewToggle: $('#preview-toggle'),
    presentBadge: $('#present-badge'),
    presentHint: $('#present-hint'),
    presentPanel: $('#present-panel'),
    settingsBtn: $('#settings-btn'),
    pipBtnPresent: $('#pip-btn-present'),
    fsBtnPresent: $('#fs-btn-present'),
    shareBtn: $('#share-btn'),
    shareBtnText: $('#share-btn-text'),
    shareBtnIcon: $('#share-btn-icon'),
    idleShare: $('#idle-share'),
    idleUnsupported: $('#idle-unsupported'),
    stopBtn: $('#stop-btn'),
    inviteBtn: $('#invite-btn'),
    leaveBtn: $('#leave-btn'),
    roomCode: $('#room-code'),
    conn: $('#conn'),
    connText: $('#conn-text'),
    watchLabel: $('#watch-label'),
    watchStatusText: $('#watch-status-text'),
    retryBtn: $('#retry-btn'),
    unmuteHint: $('#unmute-hint'),
    muteBtn: $('#mute-btn'),
    muteIcon: $('#mute-icon'),
    volume: $('#volume'),
    pipBtn: $('#pip-btn'),
    fsBtn: $('#fs-btn'),
    noAudio: $('#no-audio'),
    quality: $('#quality'),
    hint: $('#hint'),
    meter: $('#meter'),
    viewers: $('#viewers'),
    people: $('#people'),
    peopleCount: $('#people-count'),
    chatList: $('#chat-list'),
    chatEmpty: $('#chat-empty'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    nameModal: $('#name-modal'),
    nameForm: $('#name-form'),
    nameTitle: $('#name-title'),
    nameText: $('#name-text'),
    nameInput: $('#name-input'),
    nameCancel: $('#name-cancel'),
    fatal: $('#fatal'),
    fatalTitle: $('#fatal-title'),
    fatalText: $('#fatal-text'),
    fatalRetry: $('#fatal-retry'),
  };

  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);
  const savedQuality = localStorage.getItem('kv_quality');

  const S = {
    name: (localStorage.getItem('kv_name') || '').trim(),
    me: null, // { identity, name }
    peers: [], // [{ id, name, online, watching }]
    presenter: null, // id того, кто показывает экран
    sharing: false, // показываем экран мы
    quality: savedQuality && savedQuality in QUALITY ? savedQuality : DEFAULT_QUALITY,
    hint: 'motion',
    stats: null,
    link: 'connecting', // для зрителя: connecting | live | failed
    volume: clamp01(Number(localStorage.getItem('kv_volume') ?? 1)),
    muted: localStorage.getItem('kv_muted') === '1',
    unread: 0,
    wake: null,
    wasOffline: false,
    localStream: null, // что мы показываем — его же видим в копии на сцене
    previewHidden: false, // копия скрыта (например, при показе всего экрана)
    settingsOpen: false,
    watching: false, // отметка «смотрю», которую видит ведущий
  };

  const seen = new Set(); // id уже показанных сообщений чата
  let live = null;
  let knownPeers = new Map(); // для сообщений «зашёл / вышел»
  let announceJoins = false; // пока подключаемся, тех, кто уже в комнате, не объявляем

  const VIEWER_TEXT = { connecting: 'подключается…', connected: 'смотрит' };
  const ERROR_TEXT = {
    'bad-room': ['Неверная ссылка', 'Такого кода комнаты не бывает. Проверь ссылку или создай новую комнату.'],
    'room-full': ['Комната заполнена', 'В комнате нет свободных мест. Создай новую комнату или попроси кого-то выйти.'],
    'not-configured': [
      'Сайт ещё не настроен',
      'Не заданы данные сервера видео: LIVEKIT_URL, LIVEKIT_API_KEY и LIVEKIT_API_SECRET. Если это твой сайт — смотри README, раздел про Vercel.',
    ],
    network: ['Не получилось подключиться', 'Проверь интернет и попробуй ещё раз.'],
  };

  const nameOf = (id) => (id === S.me?.identity ? S.name : S.peers.find((p) => p.id === id)?.name ?? 'Участник');
  const formatTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  ui.roomCode.textContent = code;
  document.title = baseTitle;
  for (const [key, q] of Object.entries(QUALITY)) ui.quality.append(el('option', { value: key, text: q.label }));
  ui.quality.value = S.quality;
  ui.hint.value = S.hint;
  if (!document.pictureInPictureEnabled) {
    ui.pipBtn.hidden = true;
    ui.pipBtnPresent.hidden = true;
  }

  // ——— отрисовка ———

  function renderPeople() {
    const rows = [];
    if (S.me) rows.push({ id: S.me.identity, name: S.name, me: true });
    for (const p of S.peers) rows.push({ ...p, me: false });
    ui.peopleCount.textContent = String(rows.length);
    ui.people.replaceChildren(
      ...rows.map((p) => {
        const isPresenter = p.id === S.presenter || (p.me && S.sharing);
        const row = el('li', { class: 'person' }, avatar(p.name, p.id), el('span', { class: 'person-name', text: p.name }));
        if (p.me) row.append(el('span', { class: 'tag', text: 'ты' }));
        if (isPresenter) row.append(el('span', { class: 'tag tag-live', text: 'показывает' }));
        if (p.me) {
          row.append(
            el('button', { class: 'icon-btn', type: 'button', title: 'Сменить имя', 'aria-label': 'Сменить имя', onclick: renameSelf }, icon('i-pencil')),
          );
        }
        return row;
      }),
    );
  }

  function renderViewers() {
    ui.viewers.replaceChildren(
      ...S.peers.map((p) => {
        const state = p.watching ? 'connected' : 'connecting';
        return el(
          'li',
          { class: 'viewer', 'data-state': state },
          avatar(p.name, p.id, true),
          el('span', { class: 'name', text: p.name }),
          el('span', { class: 'state', text: VIEWER_TEXT[state] }),
        );
      }),
    );
    renderPresentInfo();
    updateMeter();
  }

  // Сводка на сцене ведущего: сколько человек смотрят и нужно ли ещё кого-то позвать.
  function renderPresentInfo() {
    if (!S.sharing) return;
    const total = S.peers.length;
    const watching = S.peers.filter((p) => p.watching).length;
    ui.presentBadge.textContent =
      total === 0 ? 'Ты показываешь экран · пока никого нет' : `Ты показываешь экран · смотрят ${watching} из ${total}`;
    ui.presentHint.hidden = total !== 0;
  }

  function updateMeter() {
    if (!S.sharing) return;
    const viewers = S.peers.length;
    const stats = S.stats;
    let text;
    if (viewers === 0) {
      text = 'Пока никого нет — отправь друзьям ссылку (кнопка «Пригласить» сверху).';
    } else {
      const need = (QUALITY[S.quality].bitrate / 1e6).toFixed(1).replace(/\.0$/, '');
      text = `Зрителей: ${viewers} · ты отправляешь один поток ≈ ${need} Мбит/с, сервер раздаёт его всем`;
      if (stats?.kbps != null) text += ` · сейчас уходит ${(stats.kbps / 1000).toFixed(1)} Мбит/с`;
      if (stats?.limited) {
        text += stats.limited === 'bandwidth'
          ? '. Не хватает интернета — выбери качество пониже.'
          : '. Не хватает мощности компьютера — выбери качество пониже.';
      }
    }
    const warn = viewers > 0 && Boolean(stats?.limited);
    ui.meter.textContent = text;
    ui.meter.dataset.warn = warn ? '1' : '';
    ui.settingsBtn.dataset.warn = warn ? '1' : ''; // жёлтая точка на кнопке, пока панель настроек закрыта
  }

  function renderStage() {
    const mode = S.sharing ? 'presenting' : S.presenter ? 'watching' : 'idle';
    const previous = ui.stage.dataset.mode;
    ui.stage.dataset.mode = mode;
    if (mode === 'watching') {
      ui.watchLabel.textContent = `${nameOf(S.presenter)} показывает экран`;
      if (previous !== 'watching') setLink('connecting');
    } else if (previous === 'watching') {
      ui.video.srcObject = null;
      ui.unmuteHint.hidden = true;
      setWatching(false);
    }
    ui.stage.classList.toggle('no-share', !supportsShare);
    ui.idleShare.hidden = !supportsShare;
    ui.idleUnsupported.hidden = supportsShare;
    updateShareButton();
    renderPeople();
    renderViewers();
    updateWakeLock();
  }

  function updateShareButton() {
    if (!supportsShare) {
      ui.shareBtn.hidden = true;
      return;
    }
    const busy = Boolean(S.presenter) && !S.sharing;
    const label = S.sharing ? 'Остановить показ' : busy ? `Показывает ${nameOf(S.presenter)}` : 'Показать экран';
    ui.shareBtn.disabled = busy;
    ui.shareBtn.classList.toggle('btn-danger', S.sharing);
    ui.shareBtn.classList.toggle('btn-primary', !S.sharing);
    ui.shareBtnText.textContent = label;
    ui.shareBtn.setAttribute('aria-label', label);
    ui.shareBtnIcon.setAttribute('href', S.sharing ? '#i-screen-off' : '#i-screen');
  }

  function setConn(state) {
    ui.conn.dataset.state = state;
    ui.connText.textContent = { connecting: 'Подключаемся…', online: 'В комнате', offline: 'Нет связи — переподключаемся…' }[state];
  }

  function setLink(state) {
    S.link = state;
    ui.stage.dataset.link = state;
    ui.retryBtn.hidden = state !== 'failed';
    ui.watchStatusText.textContent =
      state === 'failed' ? 'Не удалось получить картинку от ведущего.' : `Подключаемся к ${nameOf(S.presenter)}…`;
    setWatching(state === 'live');
    updateWakeLock();
  }

  function setWatching(watching) {
    if (S.watching === watching) return;
    S.watching = watching;
    live?.setWatching(watching);
  }

  // ——— чат ———

  function linkify(text) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      let url = m[0];
      const tail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
      if (tail) url = url.slice(0, -tail.length);
      parts.push(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }));
      if (tail) parts.push(tail);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  function pushToChat(node, forceScroll = false) {
    const list = ui.chatList;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    ui.chatEmpty.hidden = true;
    list.append(node);
    if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function appendMessage(m, { silent = false } = {}) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const mine = m.from === S.me?.identity;
    const row = el(
      'div',
      { class: mine ? 'msg is-mine' : 'msg' },
      avatar(m.name, m.from),
      el(
        'div',
        { class: 'msg-body' },
        el('div', { class: 'msg-head' }, el('span', { class: 'msg-name', text: m.name }), el('time', { class: 'msg-time', text: formatTime(m.ts) })),
        el('div', { class: 'msg-text' }, ...linkify(m.text)),
      ),
    );
    pushToChat(row, mine);
    if (!mine && !silent && document.hidden) {
      S.unread++;
      document.title = `(${S.unread}) ${baseTitle}`;
    }
  }

  const appendSystem = (text) => pushToChat(el('div', { class: 'sys', text }));

  // ——— просмотр чужого экрана ———

  function persistAudio() {
    localStorage.setItem('kv_volume', String(S.volume));
    localStorage.setItem('kv_muted', S.muted ? '1' : '0');
  }

  function syncAudioUi() {
    ui.video.volume = S.volume;
    ui.video.muted = S.muted;
    const silent = S.muted || S.volume === 0;
    ui.volume.value = String(S.muted ? 0 : S.volume);
    ui.muteIcon.setAttribute('href', silent ? '#i-mute' : '#i-volume');
    ui.muteBtn.setAttribute('aria-label', silent ? 'Включить звук' : 'Выключить звук');
  }

  async function playVideo() {
    syncAudioUi();
    try {
      await ui.video.play();
      ui.unmuteHint.hidden = true;
    } catch (err) {
      if (err?.name !== 'NotAllowedError') return;
      // браузер не разрешил звук без нажатия: запускаем без звука и просим нажать
      ui.video.muted = true;
      ui.video.play().catch(() => {});
      ui.unmuteHint.hidden = S.muted;
    }
  }

  function attachStream(stream) {
    if (!stream) {
      ui.video.srcObject = null;
      if (S.presenter && !S.sharing) setLink('connecting');
      return;
    }
    if (ui.video.srcObject !== stream) ui.video.srcObject = stream;
    playVideo();
  }

  for (const event of ['playing', 'resize']) {
    ui.video.addEventListener(event, () => {
      if (ui.video.videoWidth > 0) setLink('live');
    });
  }

  ui.retryBtn.addEventListener('click', () => live?.resubscribe());

  ui.unmuteHint.addEventListener('click', () => {
    S.muted = false;
    if (S.volume === 0) S.volume = 0.8;
    persistAudio();
    syncAudioUi();
    ui.unmuteHint.hidden = true;
    ui.video.play().catch(() => {});
  });

  ui.muteBtn.addEventListener('click', () => {
    S.muted = !S.muted;
    if (!S.muted && S.volume === 0) S.volume = 0.8;
    persistAudio();
    syncAudioUi();
    ui.unmuteHint.hidden = true;
  });

  ui.volume.addEventListener('input', () => {
    S.volume = Number(ui.volume.value);
    S.muted = S.volume === 0;
    persistAudio();
    syncAudioUi();
    ui.unmuteHint.hidden = true;
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (ui.stage.requestFullscreen) {
      ui.stage.requestFullscreen().catch(() => {});
    } else if (ui.video.webkitEnterFullscreen) {
      ui.video.webkitEnterFullscreen(); // iPhone
    }
  }
  ui.fsBtn.addEventListener('click', toggleFullscreen);
  ui.fsBtnPresent.addEventListener('click', toggleFullscreen);
  ui.video.addEventListener('dblclick', toggleFullscreen);
  ui.preview.addEventListener('dblclick', toggleFullscreen);

  function togglePip(video) {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture?.().catch(() => {});
  }
  ui.pipBtn.addEventListener('click', () => togglePip(ui.video));
  ui.pipBtnPresent.addEventListener('click', () => togglePip(ui.preview));

  // панель управления прячется, когда мышь не двигается
  let controlsTimer = null;
  const pokeControls = () => {
    ui.stage.classList.add('show-controls');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => ui.stage.classList.remove('show-controls'), 2800);
  };
  ui.stage.addEventListener('pointermove', pokeControls);
  ui.stage.addEventListener('pointerdown', pokeControls);

  // пока смотрим или показываем — не даём экрану телефона погаснуть
  async function updateWakeLock() {
    const need = S.sharing || (ui.stage.dataset.mode === 'watching' && S.link === 'live');
    if (need && !S.wake && navigator.wakeLock && !document.hidden) {
      try {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', () => {
          S.wake = null;
        });
      } catch {
        /* не поддерживается или запрещено — не страшно */
      }
    } else if (!need && S.wake) {
      S.wake.release().catch(() => {});
      S.wake = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      S.unread = 0;
      document.title = baseTitle;
      updateWakeLock();
    }
  });

  // ——— показ своего экрана ———

  // Большая копия того, что видят друзья: ведущий тоже смотрит фильм в комнате, рядом с чатом.
  // Звук в копии выключен — ведущий слышит его из самой вкладки, иначе звук задваивался бы.
  function applyPreview() {
    const show = S.sharing && !S.previewHidden;
    ui.preview.hidden = !show;
    ui.preview.srcObject = show ? S.localStream : null;
    ui.previewOff.hidden = !(S.sharing && S.previewHidden);
    ui.previewToggle.textContent = S.previewHidden ? 'Показать копию экрана' : 'Скрыть копию экрана';
  }

  function setSettingsOpen(open) {
    S.settingsOpen = open;
    ui.presentPanel.hidden = !open;
    ui.settingsBtn.setAttribute('aria-expanded', String(open));
    ui.stage.classList.toggle('settings-open', open);
  }

  ui.settingsBtn.addEventListener('click', () => setSettingsOpen(!S.settingsOpen));
  ui.previewToggle.addEventListener('click', () => {
    S.previewHidden = !S.previewHidden;
    applyPreview();
  });
  ui.previewOn.addEventListener('click', () => {
    S.previewHidden = false;
    applyPreview();
  });
  ui.preview.addEventListener('pointerdown', () => setSettingsOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && S.settingsOpen) setSettingsOpen(false);
  });

  async function startShare() {
    if (S.sharing || !supportsShare) return;
    if (!live || !S.me) {
      toast('Ещё подключаемся к комнате — попробуй через секунду.');
      return;
    }
    const current = live.presenter();
    if (current && current !== S.me.identity) {
      toast(`Сейчас экран показывает ${nameOf(current)}.`);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
        // для фильма звук нужно отдавать «как есть», без шумоподавления и эхоподавления
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // подсказки для Chrome и Edge; остальные браузеры их игнорируют
        selfBrowserSurface: 'exclude', // не предлагать саму страницу комнаты
        surfaceSwitching: 'include', // можно сменить вкладку, не останавливая показ
        systemAudio: 'include',
        monitorTypeSurfaces: 'include',
      });
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        toast(`Не удалось начать показ: ${err?.message || err?.name}`, 'error');
      }
      return;
    }
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      toast('Браузер не передал картинку. Попробуй ещё раз.', 'error');
      return;
    }
    // «Прекратить показ» в панели браузера
    videoTrack.addEventListener('ended', () => stopShare(), { once: true });

    S.sharing = true;
    S.stats = null;
    S.localStream = stream;
    // Если показываем весь экран, копия внутри самой комнаты превратилась бы в «зеркало в зеркале»
    S.previewHidden = videoTrack.getSettings?.().displaySurface === 'monitor';
    setSettingsOpen(false);
    applyPreview();
    ui.noAudio.hidden = stream.getAudioTracks().length > 0;
    renderStage();
    try {
      await live.startShare(stream, { quality: S.quality, hint: S.hint, codec: preferCodec });
    } catch (err) {
      console.warn('[share]', err);
      stopShare();
      toast('Не удалось начать показ. Попробуй ещё раз.', 'error');
    }
  }

  function stopShare() {
    if (!S.sharing) return;
    S.sharing = false;
    S.localStream = null;
    S.previewHidden = false;
    S.stats = null;
    setSettingsOpen(false);
    applyPreview();
    live?.stopShare();
    renderStage();
  }

  ui.shareBtn.addEventListener('click', () => (S.sharing ? stopShare() : startShare()));
  ui.idleShare.addEventListener('click', startShare);
  ui.stopBtn.addEventListener('click', () => stopShare());

  ui.quality.addEventListener('change', () => {
    S.quality = ui.quality.value;
    localStorage.setItem('kv_quality', S.quality);
    live?.setQuality(S.quality);
    updateMeter();
  });

  ui.hint.addEventListener('change', () => {
    S.hint = ui.hint.value;
    live?.setContentHint(S.hint);
  });

  // ——— имя, приглашение, выход ———

  function askName({ title, text, initial = '', cancelable = false }) {
    return new Promise((resolve) => {
      ui.nameTitle.textContent = title;
      ui.nameText.textContent = text;
      ui.nameInput.value = initial;
      ui.nameCancel.hidden = !cancelable;
      ui.nameModal.hidden = false;
      ui.nameInput.focus();
      ui.nameInput.select();

      const finish = (value) => {
        ui.nameModal.hidden = true;
        ui.nameForm.removeEventListener('submit', onSubmit);
        ui.nameCancel.removeEventListener('click', onCancel);
        ui.nameModal.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onSubmit = (event) => {
        event.preventDefault();
        const value = Array.from(ui.nameInput.value.trim()).slice(0, 24).join('');
        if (value) finish(value);
      };
      const onCancel = () => finish(null);
      const onKey = (event) => {
        if (event.key === 'Escape' && cancelable) finish(null);
      };
      ui.nameForm.addEventListener('submit', onSubmit);
      ui.nameCancel.addEventListener('click', onCancel);
      ui.nameModal.addEventListener('keydown', onKey);
    });
  }

  async function renameSelf() {
    const value = await askName({
      title: 'Сменить имя',
      text: 'Новое имя увидят все в комнате.',
      initial: S.name,
      cancelable: true,
    });
    if (!value || value === S.name || !live) return;
    try {
      await live.rename(value);
      S.name = live.me().name;
      localStorage.setItem('kv_name', S.name);
      renderPeople();
    } catch {
      toast('Не получилось сменить имя. Попробуй ещё раз.', 'error');
    }
  }

  ui.inviteBtn.addEventListener('click', async () => {
    const url = `${location.origin}/r/${code}`;
    const scope = addressScope();
    // Ссылка на 127.0.0.1 или адрес домашней сети у друзей не откроется — предупреждаем, а не врём «скопировано».
    if (scope === 'local') {
      toast('Эта ссылка работает только на этом компьютере. Чтобы позвать друзей, открой сайт по его адресу в интернете (например, на Vercel) и создай комнату там.', 'error');
      return;
    }
    if (scope === 'lan') {
      await copyText(url);
      toast('Ссылка скопирована, но она работает только в твоей домашней сети. Для друзей из интернета открой сайт по его адресу в интернете.', 'error');
      return;
    }
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'Киновечер', text: 'Заходи смотреть вместе', url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) toast('Ссылка скопирована — отправь её друзьям.');
    else toast(`Не получилось скопировать. Ссылка: ${url}`, 'error');
  });

  ui.leaveBtn.addEventListener('click', async () => {
    if (S.sharing) stopShare();
    try {
      await live?.leave();
    } finally {
      location.href = '/';
    }
  });

  ui.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = ui.chatInput.value.trim();
    if (!text) return;
    if (!live || !S.me) {
      toast('Ещё подключаемся к комнате — сообщение не отправлено.', 'error');
      return;
    }
    ui.chatInput.value = '';
    try {
      const message = await live.sendChat(text);
      if (message) appendMessage(message);
    } catch {
      ui.chatInput.value = text;
      toast('Нет связи — сообщение не отправлено.', 'error');
    }
  });

  ui.fatalRetry.addEventListener('click', () => location.reload());

  function showFatal(code, { retry = false } = {}) {
    const [title, text] = ERROR_TEXT[code] ?? ERROR_TEXT.network;
    ui.fatalTitle.textContent = title;
    ui.fatalText.textContent = text;
    ui.fatalRetry.hidden = !retry;
    ui.fatal.hidden = false;
  }

  // ——— события комнаты ———

  function onPeers() {
    S.peers = live.peers();
    const next = new Map(S.peers.map((p) => [p.id, p.name]));
    if (announceJoins) {
      for (const [id, name] of next) if (!knownPeers.has(id)) appendSystem(`${name} зашёл(-ла) в комнату`);
      for (const [id, name] of knownPeers) if (!next.has(id)) appendSystem(`${name} вышел(-ла)`);
    }
    knownPeers = next;
    if (S.presenter && !S.sharing) ui.watchLabel.textContent = `${nameOf(S.presenter)} показывает экран`;
    updateShareButton();
    renderPeople();
    renderViewers();
  }

  function onPresenter(id, previous) {
    S.presenter = id;
    if (id && id !== S.me?.identity) appendSystem(`${nameOf(id)} показывает экран`);
    else if (!id && previous && previous !== S.me?.identity) appendSystem(`${nameOf(previous)} закончил(-а) показ`);
    renderStage();
  }

  function onConnection(state) {
    if (state === 'offline') {
      S.wasOffline = true;
      setConn('offline');
    } else {
      if (S.wasOffline) appendSystem('Связь восстановлена');
      S.wasOffline = false;
      setConn('online');
    }
  }

  // ——— запуск ———

  async function boot() {
    renderStage();
    if (!S.name) {
      S.name = await askName({
        title: 'Как тебя зовут?',
        text: 'Это имя увидят друзья в списке участников и в чате.',
      });
      localStorage.setItem('kv_name', S.name);
    }
    setConn('connecting');

    let access;
    try {
      access = await requestToken(code, S.name);
    } catch (err) {
      setConn('offline');
      showFatal(err.code, { retry: err.code === 'network' });
      return;
    }

    live = createLive({
      connection: onConnection,
      peers: onPeers,
      presenter: onPresenter,
      stream: attachStream,
      link: (state) => {
        if (state === 'failed') setLink('failed');
        else if (S.link !== 'live') setLink('connecting');
      },
      chat: (message, { history }) => appendMessage(message, { silent: history }),
      stats: (stats) => {
        S.stats = stats;
        updateMeter();
      },
      conflict: (name) => {
        stopShare();
        toast(`${name} начал(-а) показ одновременно с тобой — экран остался у него.`);
      },
      disconnected: () => {
        if (S.sharing) stopShare();
        setConn('offline');
        showFatal('network', { retry: true });
      },
    });

    try {
      S.me = { identity: access.identity, name: access.name };
      S.name = access.name;
      await live.connect(access.url, access.token);
      S.me = live.me();
      // кто уже был в комнате — без сообщений «зашёл»
      S.peers = live.peers();
      knownPeers = new Map(S.peers.map((p) => [p.id, p.name]));
      announceJoins = true;
      renderStage();
    } catch (err) {
      console.warn('[connect]', err);
      setConn('offline');
      showFatal('network', { retry: true });
    }
  }

  boot();
}
