import { $, newRoomCode, extractRoomCode, toast, addressScope } from './common.js';

// Если сайт открыт по адресу, который друзья не увидят, говорим об этом сразу — до создания комнаты.
const scope = addressScope();
if (scope !== 'public') {
  const note = $('#local-note');
  note.textContent =
    scope === 'local'
      ? 'Сейчас сайт открыт по локальному адресу — по нему зайдут только с этого компьютера. Чтобы позвать друзей, открой сайт по его адресу в интернете (например, на Vercel) и создай комнату там.'
      : 'Сейчас сайт открыт по адресу домашней сети — по нему зайдут только те, кто подключён к твоему Wi-Fi. Чтобы позвать друзей из интернета, открой сайт по его адресу в интернете (например, на Vercel).';
  note.hidden = false;
}

$('#create').addEventListener('click', () => {
  location.href = `/r/${newRoomCode()}`;
});

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = extractRoomCode($('#code').value);
  if (!code) {
    toast('Не похоже на код комнаты. Вставь ссылку целиком или код вида abcd-efgh.', 'error');
    return;
  }
  location.href = `/r/${code}`;
});
