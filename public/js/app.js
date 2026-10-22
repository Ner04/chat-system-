import { api, session, setUnauthorizedHandler } from './api.js';
import {
  loadOrCreateDevice, rememberDeviceId, useDeviceKey,
  encryptMessage, decryptMessage, encryptFile, decryptFile,
} from './crypto.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  me: null, // { user_id, device_id, name, phone }
  chats: new Map(), // chat_id -> chat summary (+ preview fields)
  msgs: new Map(), // chat_id -> Map(message_id -> message)
  hasOlder: new Map(), // chat_id -> bool
  loaded: new Set(), // chat_ids whose history was fetched
  devices: new Map(), // chat_id -> Promise<[{device_id, public_key}]>
  devKeys: new Map(), // device_id -> Promise<public JWK>
  presence: new Map(), // user_id -> { online, last_seen }
  typing: new Map(), // chat_id -> { user_id, until }
  outbox: new Map(), // message_id -> { chatId, body, tries }
  active: null,
  ws: null,
  wsReady: false,
  everConnected: false,
  pendingDelivered: new Map(),
};
const mediaCache = new Map(); // media_id -> object URL of decrypted bytes
let sendChain = Promise.resolve();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Boot & auth
// ---------------------------------------------------------------------------
setUnauthorizedHandler((message) => signOut(message || 'Your session ended. Sign in again.'));

async function boot() {
  const s = session.get();
  if (s?.token) {
    try { await startApp(); return; } catch (e) { console.warn(e); }
  }
  showAuth();
}

function showAuth(message) {
  $('app').hidden = true;
  $('auth').hidden = false;
  showStep('phone-form');
  setAuthError(message);
  $('phone').focus();
}
const showStep = (id) => ['phone-form', 'otp-form', 'name-form'].forEach((f) => { $(f).hidden = f !== id; });
function setAuthError(msg) { $('auth-error').hidden = !msg; $('auth-error').textContent = msg || ''; }

async function withBusy(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  setAuthError();
  try { await fn(); } catch (e) { setAuthError(e.message); } finally { btn.disabled = false; }
}

let pendingPhone = null;
$('phone-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const r = await api('POST', '/v1/auth/register', { phone: $('phone').value });
    pendingPhone = r.phone;
    $('otp-phone').textContent = r.phone;
    $('dev-otp').hidden = !r.dev_otp;
    if (r.dev_otp) {
      $('dev-otp').textContent = `Development mode: your code is ${r.dev_otp} (also printed in the server console).`;
      $('otp').value = r.dev_otp;
    }
    showStep('otp-form');
    $('otp').focus();
  });
});
$('otp-back').addEventListener('click', () => { showStep('phone-form'); setAuthError(); });

$('otp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    const dev = await loadOrCreateDevice(pendingPhone);
    const r = await api('POST', '/v1/auth/verify', {
      phone: pendingPhone,
      otp: $('otp').value,
      device: { device_id: dev.device_id, public_key: dev.publicJwk, name: deviceName() },
    });
    rememberDeviceId(pendingPhone, r.device_id);
    session.set({ token: r.token, phone: pendingPhone, user_id: r.user_id, device_id: r.device_id });
    if (!r.name) { showStep('name-form'); $('display-name').focus(); return; }
    await startApp();
  });
});

$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    await api('PATCH', '/v1/users/me', { name: $('display-name').value });
    await startApp();
  });
});

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : 'Linux';
  return `${browser} on ${os}`;
}

function signOut(message) {
  session.clear();
  S.ws?.close(1000);
  S.ws = null;
  location.hash = '';
  if (message) sessionStorage.setItem('relay.flash', message);
  location.reload();
}
$('signout-btn').addEventListener('click', () => signOut());

async function startApp() {
  const s = session.get();
  const dev = await loadOrCreateDevice(s.phone);
  useDeviceKey(dev.privateKey);
  const me = await api('GET', '/v1/users/me');
  S.me = { ...me, phone: s.phone };
  $('auth').hidden = true;
  $('app').hidden = false;
  $('me-name').textContent = me.name;
  paintAvatar($('me-avatar'), me.user_id, me.name);
  await loadChats();
  connect();
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function getDevices(chatId) {
  if (!S.devices.has(chatId)) {
    const p = api('GET', `/v1/chats/${chatId}/devices`).then((list) => {
      for (const d of list) S.devKeys.set(d.device_id, Promise.resolve(d.public_key));
      return list;
    });
    p.catch(() => S.devices.delete(chatId));
    S.devices.set(chatId, p);
  }
  return S.devices.get(chatId);
}

function getDeviceKey(deviceId) {
  if (!S.devKeys.has(deviceId)) {
    const p = api('GET', `/v1/devices/${deviceId}`).then((d) => d.public_key);
    p.catch(() => S.devKeys.delete(deviceId));
    S.devKeys.set(deviceId, p);
  }
  return S.devKeys.get(deviceId);
}

const chatMsgs = (chatId) => {
  if (!S.msgs.has(chatId)) S.msgs.set(chatId, new Map());
  return S.msgs.get(chatId);
};

async function loadChats() {
  const list = await api('GET', '/v1/chats');
  const seen = new Set();
  for (const c of list) {
    const prev = S.chats.get(c.chat_id);
    S.chats.set(c.chat_id, { ...prev, ...c });
    seen.add(c.chat_id);
  }
  for (const id of [...S.chats.keys()]) if (!seen.has(id)) S.chats.delete(id);
  if (S.active && !S.chats.has(S.active)) closeChat();
  renderChatList();
  // Previews: fetch + decrypt the latest message of each chat that lacks one.
  await Promise.all(list.filter((c) => c.last_seq > 0 && !S.chats.get(c.chat_id).preview).slice(0, 40).map(async (c) => {
    const [m] = await api('GET', `/v1/chats/${c.chat_id}/messages?limit=1`).catch(() => []);
    if (m) await ingest(m, { live: false });
  }));
  renderChatList();
  if (S.active) renderConversationHeader();
}

/** Decrypt and store one server message. */
async function ingest(m, { live }) {
  const store = chatMsgs(m.chat_id);
  const existing = store.get(m.message_id);
  if (existing?.body) { if (m.seq && !existing.seq) existing.seq = m.seq; return existing; }
  let body = null;
  try {
    body = await decryptMessage(m, await getDeviceKey(m.sender_device_id));
  } catch (e) {
    console.warn('decrypt failed', m.message_id, e);
  }
  const msg = {
    message_id: m.message_id, chat_id: m.chat_id, seq: m.seq,
    sender_user_id: m.sender_user_id, sender_device_id: m.sender_device_id,
    created_at: m.created_at, body, cipher: m.payload.ciphertext, status: 'sent',
  };
  store.set(m.message_id, msg);
  const chat = S.chats.get(m.chat_id);
  if (chat) {
    chat.last_seq = Math.max(chat.last_seq || 0, m.seq);
    updatePreview(chat, msg);
    const mine = m.sender_user_id === S.me.user_id;
    if (live && !mine) {
      if (S.active === m.chat_id && pageVisible()) {
        // read immediately below
      } else {
        chat.unread = (chat.unread || 0) + 1;
        notify(chat, msg);
      }
      chat.last_message_at = m.created_at;
    }
  }
  if (m.sender_user_id !== S.me.user_id) queueDelivered(m.chat_id, m.seq);
  return msg;
}

function updatePreview(chat, msg) {
  const cur = chat.previewSeq || 0;
  if (msg.seq && msg.seq < cur) return;
  chat.previewSeq = msg.seq || cur;
  chat.preview = previewText(msg, chat);
  chat.previewCipher = msg.cipher;
  chat.previewAt = msg.created_at;
}

function previewText(msg, chat) {
  const who = msg.sender_user_id === S.me.user_id ? 'You: ' : chat?.type === 'group' ? `${memberName(chat, msg.sender_user_id)}: ` : '';
  if (!msg.body) return `${who}Encrypted message`;
  if (msg.body.kind === 'media') return `${who}${msg.body.mime?.startsWith('image/') ? 'Photo' : msg.body.name || 'File'}`;
  return who + msg.body.text;
}

const memberName = (chat, userId) => chat?.members?.find((m) => m.user_id === userId)?.name || 'Someone';
const pageVisible = () => document.visibilityState === 'visible' && document.hasFocus();

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let backoff = 1000;
function connect() {
  const s = session.get();
  if (!s) return;
  setConn('Connecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/connect?token=${encodeURIComponent(s.token)}`);
  S.ws = ws;
  ws.onopen = () => {
    S.wsReady = true;
    backoff = 1000;
    setConn('Connected', 'ok');
    if (S.active) ws.send(JSON.stringify({ type: 'presence_subscribe', chat_id: S.active }));
    for (const id of S.outbox.keys()) transmit(id); // resend anything not yet acked
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
  ws.onclose = (e) => {
    S.wsReady = false;
    if (S.ws !== ws) return;
    if (e.code === 4000) { setConn('Open in another tab', 'bad'); return; }
    setConn('Offline · reconnecting…', 'bad');
    setTimeout(async () => {
      try { await api('GET', '/v1/users/me'); } catch { /* 401 handler signs out */ }
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

function wsSend(ev) {
  if (S.ws && S.wsReady) { S.ws.send(JSON.stringify(ev)); return true; }
  return false;
}

function setConn(text, cls = '') { const el = $('conn'); el.textContent = text; el.className = `conn ${cls}`; }

async function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      await ingest(ev, { live: !ev.backlog });
      if (!S.chats.has(ev.chat_id)) { await loadChats(); }
      afterChange(ev.chat_id);
      break;
    }
    case 'ack': {
      const msg = chatMsgs(ev.chat_id).get(ev.message_id);
      S.outbox.delete(ev.message_id);
      if (msg) { msg.seq = ev.seq; msg.status = 'sent'; }
      const chat = S.chats.get(ev.chat_id);
      if (chat) {
        chat.last_seq = Math.max(chat.last_seq || 0, ev.seq);
        chat.my_read_seq = Math.max(chat.my_read_seq || 0, ev.seq);
        if (msg) updatePreview(chat, msg);
      }
      afterChange(ev.chat_id);
      break;
    }
    case 'nack': {
      const job = S.outbox.get(ev.message_id);
      if (ev.error === 'devices_changed' && job && job.tries < 3) {
        S.devices.delete(job.chatId); // someone added/removed a device: re-encrypt for the new set
        transmit(ev.message_id);
        break;
      }
      S.outbox.delete(ev.message_id);
      for (const store of S.msgs.values()) {
        const msg = store.get(ev.message_id);
        if (msg) { msg.status = 'failed'; afterChange(msg.chat_id); }
      }
      toast(ev.message || 'Message not sent');
      break;
    }
    case 'receipt': {
      const chat = S.chats.get(ev.chat_id);
      if (!chat) break;
      chat.delivered_up_to = Math.max(chat.delivered_up_to || 0, ev.delivered_up_to);
      chat.read_up_to = Math.max(chat.read_up_to || 0, ev.read_up_to);
      if (S.active === ev.chat_id) renderMessages(false);
      break;
    }
    case 'read_sync': {
      const chat = S.chats.get(ev.chat_id);
      if (chat) { chat.my_read_seq = Math.max(chat.my_read_seq || 0, ev.up_to_seq); chat.unread = 0; renderChatList(); }
      break;
    }
    case 'chat_updated':
      S.devices.delete(ev.chat_id);
      await loadChats();
      break;
    case 'presence':
      S.presence.set(ev.user_id, ev);
      if (S.active) renderConversationHeader();
      break;
    case 'typing': {
      S.typing.set(ev.chat_id, { user_id: ev.user_id, until: Date.now() + 5000 });
      if (S.active === ev.chat_id) renderConversationHeader();
      setTimeout(() => { if (S.active === ev.chat_id) renderConversationHeader(); }, 5100);
      break;
    }
    case 'sync_done':
      if (S.everConnected && ev.count) await loadChats(); // refresh unread counts after a reconnect
      S.everConnected = true;
      break;
    default:
      break;
  }
}

function afterChange(chatId) {
  renderChatList();
  if (S.active === chatId) { renderMessages(); markRead(chatId); }
}

// Delivery receipts are batched into one high-water mark per chat.
let deliveredTimer = null;
function queueDelivered(chatId, seq) {
  S.pendingDelivered.set(chatId, Math.max(S.pendingDelivered.get(chatId) || 0, seq));
  clearTimeout(deliveredTimer);
  deliveredTimer = setTimeout(flushDelivered, 250);
}
function flushDelivered() {
  for (const [chatId, seq] of S.pendingDelivered) {
    const chat = S.chats.get(chatId);
    if (chat && (chat.my_delivered_seq || 0) >= seq) continue;
    if (wsSend({ type: 'receipt', chat_id: chatId, receipt_type: 'delivered', up_to_seq: seq })) {
      if (chat) chat.my_delivered_seq = seq;
    }
  }
  S.pendingDelivered.clear();
}

function markRead(chatId) {
  const chat = S.chats.get(chatId);
  if (!chat || !pageVisible()) return;
  let max = 0;
  for (const m of chatMsgs(chatId).values()) if (m.seq && m.seq > max) max = m.seq;
  if (max > (chat.my_read_seq || 0)) {
    if (wsSend({ type: 'receipt', chat_id: chatId, receipt_type: 'read', up_to_seq: max })) chat.my_read_seq = max;
  }
  if (chat.unread) { chat.unread = 0; renderChatList(); }
}
window.addEventListener('focus', () => S.active && markRead(S.active));
document.addEventListener('visibilitychange', () => S.active && markRead(S.active));

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function sendBody(chatId, body) {
  const id = crypto.randomUUID();
  const msg = {
    message_id: id, chat_id: chatId, seq: null, sender_user_id: S.me.user_id, sender_device_id: S.me.device_id,
    created_at: new Date().toISOString(), body, cipher: '', status: 'pending',
  };
  chatMsgs(chatId).set(id, msg);
  S.outbox.set(id, { chatId, body, tries: 0 });
  const chat = S.chats.get(chatId);
  if (chat) { updatePreview(chat, msg); chat.last_message_at = msg.created_at; }
  afterChange(chatId);
  scrollToBottom();
  transmit(id);
  askNotificationPermission();
}

// Serialised so the server sees messages in the order they were typed.
function transmit(id) {
  sendChain = sendChain.then(async () => {
    const job = S.outbox.get(id);
    if (!job || !S.wsReady) return; // flushed again on reconnect
    job.tries++;
    try {
      const devices = await getDevices(job.chatId);
      const payload = await encryptMessage(job.body, { chatId: job.chatId, messageId: id, senderDeviceId: S.me.device_id }, devices);
      const msg = chatMsgs(job.chatId).get(id);
      if (msg) msg.cipher = payload.ciphertext;
      wsSend({ type: 'send', message_id: id, chat_id: job.chatId, payload, client_ts: Date.now() });
    } catch (e) {
      console.error(e);
      toast('Could not encrypt the message. Check your connection and try again.');
    }
  });
}

const input = $('input');
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !S.active) return;
  input.value = '';
  autosize();
  sendBody(S.active, { kind: 'text', text });
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
let lastTypingSent = 0;
input.addEventListener('input', () => {
  autosize();
  if (S.active && Date.now() - lastTypingSent > 3000 && input.value) {
    lastTypingSent = Date.now();
    wsSend({ type: 'typing', chat_id: S.active });
  }
});
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }

// Media: compress-free for simplicity, but encrypted BEFORE upload; the key travels in the message.
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !S.active) return;
  if (file.size > 25 * 1024 * 1024) { toast('Files must be under 25 MB'); return; }
  const chatId = S.active;
  toast(`Encrypting and uploading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const isImage = file.type.startsWith('image/');
    const thumb = isImage ? await makeThumb(file) : null;
    const enc = await encryptFile(buf);
    const { media_id, upload_url } = await api('POST', '/v1/media/upload-url', { mime: 'application/octet-stream', size: enc.bytes.byteLength });
    const up = await fetch(upload_url, { method: 'PUT', body: enc.bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!up.ok) throw new Error('upload failed');
    mediaCache.set(media_id, URL.createObjectURL(file));
    sendBody(chatId, {
      kind: 'media', media_id, key: enc.key, iv: enc.iv, sha256: enc.sha256,
      mime: file.type || 'application/octet-stream', name: file.name, size: file.size, thumb: thumb?.data, w: thumb?.w, h: thumb?.h,
    });
    hideToast();
  } catch (err) {
    console.error(err);
    toast(`Couldn't send ${file.name}. Try again.`);
  }
});

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = 24 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.6), w: bmp.width, h: bmp.height };
  } catch { return null; }
}

async function loadMedia(body) {
  if (mediaCache.has(body.media_id)) return mediaCache.get(body.media_id);
  const { url } = await api('GET', `/v1/media/${body.media_id}/download-url`);
  const res = await fetch(url);
  if (!res.ok) throw new Error('missing');
  const plain = await decryptFile(await res.arrayBuffer(), body);
  const objectUrl = URL.createObjectURL(new Blob([plain], { type: body.mime }));
  mediaCache.set(body.media_id, objectUrl);
  return objectUrl;
}

// ---------------------------------------------------------------------------
// Rendering: chat list
// ---------------------------------------------------------------------------
const PALETTE = ['#3554E0', '#0F8A7E', '#B4562B', '#7A4FD0', '#B0306A', '#3D7A2E'];
function paintAvatar(el, id, name, group = false) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  el.style.background = PALETTE[h % PALETTE.length];
  el.textContent = initials(name);
  el.classList.toggle('group', group);
}
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diff = (now - d) / 86400000;
  if (diff < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function renderChatList() {
  const chats = [...S.chats.values()].sort((a, b) => new Date(b.previewAt || b.last_message_at) - new Date(a.previewAt || a.last_message_at));
  $('chat-list-empty').hidden = chats.length > 0;
  const ul = $('chat-list');
  ul.innerHTML = chats.map((c) => `
    <li class="chat-item" data-id="${esc(c.chat_id)}" tabindex="0" role="button" aria-current="${c.chat_id === S.active}">
      <span class="avatar${c.type === 'group' ? ' group' : ''}" data-avatar="${esc(c.chat_id)}"></span>
      <div class="body">
        <div class="row"><span class="name">${esc(c.name)}</span><span class="time">${esc(fmtTime(c.previewAt || (c.last_seq ? c.last_message_at : null)))}</span></div>
        <div class="row">
          <span class="preview">
            <span class="plain">${esc(c.preview || (c.last_seq ? 'Encrypted message' : c.type === 'group' ? `${c.members.length} members` : 'Say hello'))}</span>
            <span class="cipher">${esc((c.previewCipher || '').slice(0, 44))}</span>
          </span>
          ${c.unread && c.chat_id !== S.active ? `<span class="badge" aria-label="${c.unread} unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </div>
      </div>
    </li>`).join('');
  for (const el of ul.querySelectorAll('[data-avatar]')) {
    const c = S.chats.get(el.dataset.avatar);
    paintAvatar(el, c.chat_id, c.name, c.type === 'group');
  }
}

$('chat-list').addEventListener('click', (e) => {
  const li = e.target.closest('.chat-item');
  if (li) openChat(li.dataset.id);
});
$('chat-list').addEventListener('keydown', (e) => {
  const li = e.target.closest('.chat-item');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChat(li.dataset.id); }
});

// ---------------------------------------------------------------------------
// Rendering: conversation
// ---------------------------------------------------------------------------
async function openChat(chatId) {
  S.active = chatId;
  $('conv-empty').hidden = true;
  $('conv').hidden = false;
  $('app').classList.add('in-chat');
  renderConversationHeader();
  renderChatList();
  renderMessages();
  wsSend({ type: 'presence_subscribe', chat_id: chatId });
  if (!S.loaded.has(chatId)) {
    const list = await api('GET', `/v1/chats/${chatId}/messages?limit=50`);
    S.loaded.add(chatId);
    S.hasOlder.set(chatId, list.length === 50);
    for (const m of list) await ingest(m, { live: false });
    if (S.active !== chatId) return;
    renderMessages();
  }
  scrollToBottom();
  markRead(chatId);
  if (window.matchMedia('(min-width: 761px)').matches) input.focus();
}

function closeChat() {
  S.active = null;
  wsSend({ type: 'presence_subscribe', chat_id: null });
  $('conv').hidden = true;
  $('conv-empty').hidden = false;
  $('app').classList.remove('in-chat');
  renderChatList();
}
$('back-btn').addEventListener('click', closeChat);

function renderConversationHeader() {
  const chat = S.chats.get(S.active);
  if (!chat) return;
  $('conv-name').textContent = chat.name;
  paintAvatar($('conv-avatar'), chat.chat_id, chat.name, chat.type === 'group');
  $('members-btn').hidden = chat.type !== 'group';
  const status = $('conv-status');
  const t = S.typing.get(chat.chat_id);
  if (t && t.until > Date.now() && t.user_id !== S.me.user_id) {
    status.textContent = chat.type === 'group' ? `${memberName(chat, t.user_id)} is typing…` : 'typing…';
    status.className = 'conv-status typing';
    return;
  }
  status.className = 'conv-status';
  if (chat.type === 'group') {
    status.textContent = chat.members.map((m) => (m.user_id === S.me.user_id ? 'You' : m.name)).join(', ');
  } else {
    const other = chat.members.find((m) => m.user_id !== S.me.user_id);
    const p = other && S.presence.get(other.user_id);
    status.textContent = p?.online ? 'online' : p?.last_seen ? `last seen ${fmtLastSeen(p.last_seen)}` : other?.phone || '';
  }
}
const fmtLastSeen = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

const TICK = {
  pending: '<svg class="tick pending" viewBox="0 0 24 24" aria-label="Sending"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  sent: '<svg class="tick" viewBox="0 0 24 18" aria-label="Sent"><path d="M5 9.5l4 4L19 4"/></svg>',
  delivered: '<svg class="tick" viewBox="0 0 24 18" aria-label="Delivered"><path d="M2 9.5l4 4L15 4M10 13.5L19.5 4"/></svg>',
  read: '<svg class="tick read" viewBox="0 0 24 18" aria-label="Read"><path d="M2 9.5l4 4L15 4M10 13.5L19.5 4"/></svg>',
  failed: '<span aria-label="Not sent">Not sent</span>',
};
function tickFor(msg, chat) {
  if (msg.status === 'failed') return TICK.failed;
  if (!msg.seq) return TICK.pending;
  if ((chat.read_up_to || 0) >= msg.seq) return TICK.read;
  if ((chat.delivered_up_to || 0) >= msg.seq) return TICK.delivered;
  return TICK.sent;
}

function fmtSize(n) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

function renderBody(msg) {
  const b = msg.body;
  if (!b) return '<span class="undecryptable">This message can\'t be decrypted on this device.</span>';
  if (b.kind === 'media') {
    if (b.mime?.startsWith('image/')) {
      const cached = mediaCache.get(b.media_id);
      const ratio = b.w && b.h ? `aspect-ratio:${b.w}/${b.h};` : '';
      return `<img class="media-img${cached ? '' : ' loading'}" data-media="${esc(b.media_id)}" data-mid="${esc(msg.message_id)}" alt="${esc(b.name || 'Photo')}" style="${ratio}" src="${esc(cached || b.thumb || '')}">`;
    }
    const ext = (b.name?.split('.').pop() || 'file').slice(0, 4).toUpperCase();
    return `<a class="file-chip" href="#" data-file="${esc(msg.message_id)}"><span class="ext">${esc(ext)}</span><span><span class="fname">${esc(b.name)}</span><br><span class="fsize">${fmtSize(b.size)} · tap to download</span></span></a>`;
  }
  return esc(b.text);
}

function renderMessages(autoScroll = true) {
  const chat = S.chats.get(S.active);
  if (!chat) return;
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = [...chatMsgs(chat.chat_id).values()].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || new Date(a.created_at) - new Date(b.created_at));
  let html = '';
  let lastDay = '';
  let lastSender = null;
  for (const m of list) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      html += `<li class="day">${esc(new Date(m.created_at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</li>`;
      lastDay = day;
      lastSender = null;
    }
    const mine = m.sender_user_id === S.me.user_id;
    const first = m.sender_user_id !== lastSender;
    lastSender = m.sender_user_id;
    const cipher = m.cipher ? `${m.cipher.slice(0, 220)}${m.cipher.length > 220 ? '…' : ''}` : 'encrypting…';
    html += `<li class="msg ${mine ? 'mine' : 'theirs'}${first ? ' first' : ''}${m.status === 'failed' ? ' failed' : ''}">
      ${!mine && first && chat.type === 'group' ? `<div class="sender">${esc(memberName(chat, m.sender_user_id))}</div>` : ''}
      <div class="bubble"><div class="plain">${renderBody(m)}</div><div class="cipher">${esc(cipher)}</div><span class="meta">${esc(new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${mine ? tickFor(m, chat) : ''}</span></div>
    </li>`;
  }
  $('message-list').innerHTML = html;
  $('older-btn').hidden = !S.hasOlder.get(chat.chat_id);
  // Load full images (decrypting them) after the thumbnails are on screen.
  for (const img of $('message-list').querySelectorAll('img.loading')) {
    const msg = chatMsgs(chat.chat_id).get(img.dataset.mid);
    loadMedia(msg.body).then((url) => { img.src = url; img.classList.remove('loading'); })
      .catch(() => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'undecryptable', textContent: 'This media file appears to be missing' })); });
  }
  if (autoScroll && atBottom) scrollToBottom();
}

$('message-list').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-file]');
  if (!a) return;
  e.preventDefault();
  const msg = chatMsgs(S.active).get(a.dataset.file);
  try {
    const url = await loadMedia(msg.body);
    Object.assign(document.createElement('a'), { href: url, download: msg.body.name || 'file' }).click();
  } catch { toast('This media file appears to be missing'); }
});

$('older-btn').addEventListener('click', async () => {
  const chatId = S.active;
  const seqs = [...chatMsgs(chatId).values()].map((m) => m.seq).filter(Boolean);
  const before = Math.min(...seqs);
  const box = $('messages');
  const prevHeight = box.scrollHeight;
  const list = await api('GET', `/v1/chats/${chatId}/messages?before=${before}&limit=50`);
  S.hasOlder.set(chatId, list.length === 50);
  for (const m of list) await ingest(m, { live: false });
  renderMessages(false);
  box.scrollTop = box.scrollHeight - prevHeight;
});

function scrollToBottom() { const box = $('messages'); requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); }

// Cipher view toggle (remembered per browser).
const cipherToggle = $('cipher-toggle');
try { cipherToggle.checked = localStorage.getItem('relay.cipher') === '1'; } catch { /* ignore */ }
document.body.classList.toggle('show-cipher', cipherToggle.checked);
cipherToggle.addEventListener('change', () => {
  document.body.classList.toggle('show-cipher', cipherToggle.checked);
  try { localStorage.setItem('relay.cipher', cipherToggle.checked ? '1' : '0'); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// New chat / group dialogs
// ---------------------------------------------------------------------------
const newDlg = $('new-chat-dialog');
let newTab = 'direct';
function openNewChat() {
  $('new-chat-error').hidden = true;
  $('direct-phone').value = ''; $('group-name').value = ''; $('group-phones').value = '';
  newDlg.showModal();
  setTab('direct');
}
function setTab(tab) {
  newTab = tab;
  for (const t of newDlg.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  for (const p of newDlg.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  $('new-chat-submit').textContent = tab === 'direct' ? 'Start chat' : 'Create group';
  (tab === 'direct' ? $('direct-phone') : $('group-name')).focus();
}
newDlg.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('new-chat-btn').addEventListener('click', openNewChat);
$('first-chat-btn').addEventListener('click', openNewChat);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

$('new-chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('new-chat-submit');
  btn.disabled = true;
  $('new-chat-error').hidden = true;
  try {
    const chat = newTab === 'direct'
      ? await api('POST', '/v1/chats/direct', { phone: $('direct-phone').value })
      : await api('POST', '/v1/groups', { name: $('group-name').value, members: $('group-phones').value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) });
    S.chats.set(chat.chat_id, { ...S.chats.get(chat.chat_id), ...chat });
    newDlg.close();
    renderChatList();
    openChat(chat.chat_id);
  } catch (err) {
    $('new-chat-error').textContent = err.message;
    $('new-chat-error').hidden = false;
  } finally { btn.disabled = false; }
});

const memDlg = $('members-dialog');
function renderMembers() {
  const chat = S.chats.get(S.active);
  if (!chat) return;
  const amAdmin = chat.admins.includes(S.me.user_id);
  $('members-title').textContent = `${chat.name} · ${chat.members.length} members`;
  $('add-member-row').hidden = !amAdmin;
  $('members-list').innerHTML = chat.members.map((m) => `
    <li>
      <span class="avatar" data-uid="${esc(m.user_id)}" data-name="${esc(m.name)}"></span>
      <div class="who"><div>${esc(m.user_id === S.me.user_id ? `${m.name} (you)` : m.name)}</div><div class="phone">${esc(m.phone)}</div></div>
      ${chat.admins.includes(m.user_id) ? '<span class="role">Admin</span>' : ''}
      ${amAdmin && m.user_id !== S.me.user_id ? `<button type="button" class="btn link" data-remove="${esc(m.user_id)}">Remove</button>` : ''}
    </li>`).join('');
  for (const el of $('members-list').querySelectorAll('[data-uid]')) paintAvatar(el, el.dataset.uid, el.dataset.name);
}
$('members-btn').addEventListener('click', () => { $('members-error').hidden = true; renderMembers(); memDlg.showModal(); });

async function memberAction(fn) {
  $('members-error').hidden = true;
  try {
    await fn();
    S.devices.delete(S.active);
    await loadChats();
    renderMembers();
  } catch (err) {
    $('members-error').textContent = err.message;
    $('members-error').hidden = false;
  }
}
$('add-member-btn').addEventListener('click', () => memberAction(async () => {
  await api('POST', `/v1/groups/${S.active}/members`, { phone: $('add-member-phone').value });
  $('add-member-phone').value = '';
}));
$('members-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) memberAction(() => api('DELETE', `/v1/groups/${S.active}/members/${b.dataset.remove}`));
});
$('leave-btn').addEventListener('click', async () => {
  const id = S.active;
  await api('DELETE', `/v1/groups/${id}/members/${S.me.user_id}`).catch((err) => toast(err.message));
  memDlg.close();
  closeChat();
  await loadChats();
});

// ---------------------------------------------------------------------------
// Notifications & toast
// ---------------------------------------------------------------------------
let askedPermission = false;
function askNotificationPermission() {
  if (askedPermission || !('Notification' in window) || Notification.permission !== 'default') return;
  askedPermission = true;
  Notification.requestPermission().catch(() => {});
}
function notify(chat, msg) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(chat.name, { body: previewText(msg, chat), tag: chat.chat_id });
    n.onclick = () => { window.focus(); openChat(chat.chat_id); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() { $('toast').hidden = true; }

const flash = sessionStorage.getItem('relay.flash');
if (flash) { sessionStorage.removeItem('relay.flash'); }
boot().then(() => { if (flash && !$('auth').hidden) setAuthError(flash); });
