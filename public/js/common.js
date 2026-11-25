// Мелкие общие помощники для обеих страниц.

export const ROOM_CODE_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

// Алфавит без похожих символов (i, l, o, 0, 1), чтобы код легко читался и диктовался.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newRoomCode() {
  const chars = [];
  const buf = new Uint8Array(16);
  while (chars.length < 8) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 248 = 31 × 8: отбрасываем «хвост», чтобы все символы выпадали равновероятно
      if (b < 248 && chars.length < 8) chars.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Достаёт код комнаты из ссылки, из набранного вручную кода или из целого сообщения
 * вроде «Вот ссылка: https://…/r/abcd-efgh — заходи».
 */
export function extractRoomCode(input) {
  const s = String(input ?? '').trim().toLowerCase();
  const m =
    s.match(/\/r\/([a-z0-9]{4})-([a-z0-9]{4})(?![a-z0-9-])/) ||
    s.match(/(?:^|[^a-z0-9-])([a-z0-9]{4})-([a-z0-9]{4})(?![a-z0-9-])/) ||
    s.match(/^([a-z0-9]{4})[\s_]?([a-z0-9]{4})$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Откуда сайт открыт: 'local' — только с этого компьютера, 'lan' — из домашней сети, 'public' — из интернета. */
export function addressScope(hostname = location.hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')) return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(hostname)) return 'lan';
  return 'public';
}

export function $(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`На странице нет элемента ${selector}`);
  return node;
}

/** Создаёт элемент. Текст всегда вставляется как текст, не как HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

export function icon(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? '?')[0];
  const second = words[1] ? Array.from(words[1])[0] : '';
  return (first + second).toUpperCase();
}

function hueFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Круглая «аватарка» с инициалами; цвет зависит от id, поэтому у всех одинаковый. */
export function avatar(name, id, small = false) {
  const node = el('span', { class: small ? 'avatar avatar-sm' : 'avatar', text: initials(name), 'aria-hidden': 'true' });
  node.style.setProperty('--h', String(hueFor(id)));
  return node;
}

export function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const node = el('div', { class: kind === 'error' ? 'toast is-error' : 'toast', text });
  box.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // запасной способ для http-страниц, где буфер обмена недоступен
    const area = el('textarea', { readonly: true });
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
