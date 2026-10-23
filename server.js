'use strict';
/*
 * Bunker Siege game server.
 *
 * - Serves the game page (public/index.html) and the bundled three.js build.
 * - Runs a public room list over WebSocket (/ws): players create rooms, see every open room,
 *   and join with one click. Up to 4 players per room.
 * - Relays each player's state to the others in the room. The room host's browser runs the
 *   bots and waves (same model as the in-page version), so this server stays light.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX_ROOMS = +process.env.MAX_ROOMS || 200;
const MAX_PER_ROOM = 4;
const MAX_CONN_PER_IP = +process.env.MAX_CONN_PER_IP || 12;
const HOST_IDLE_MS = 20000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

/* ---------- static files ---------- */
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/three.min.js': ['three.min.js', 'application/javascript; charset=utf-8', 'public, max-age=86400']
};
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const f = FILES[url];
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(PUBLIC, f[0]), (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[2], 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

/* ---------- helpers ---------- */
const clients = new Map();   // id -> client
const rooms = new Map();     // code -> room
const ipCount = new Map();

function cleanNick(s) {
  s = String(s == null ? '' : s).replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 14);
  return s || 'Soldier';
}
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode() {
  for (let k = 0; k < 20; k++) {
    let c = '';
    const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function newId() { return 'u' + crypto.randomBytes(6).toString('hex'); }
function send(c, obj) {
  if (c.ws.readyState !== 1) return;
  try { c.ws.send(JSON.stringify(obj)); } catch (e) { /* closed */ }
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function mergeInto(dst, patch) {
  for (const k of Object.keys(patch)) {
    if (patch[k] === null) delete dst[k];
    else dst[k] = patch[k];
  }
}

/* A patch from a player is limited to a small, known set of fields. */
function sanitize(d, isHost) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  if ('p' in d) {
    if (d.p === null) out.p = null;
    else if (Array.isArray(d.p) && d.p.length <= 8 && d.p.every(isNum)) out.p = d.p;
  }
  if ('n' in d) out.n = cleanNick(d.n);
  if (!isHost && 'sh' in d) {
    if (d.sh === null) out.sh = null;
    else if (Array.isArray(d.sh) && d.sh.length <= 8 &&
             d.sh.every(a => Array.isArray(a) && a.length <= 8 && a.every(isNum))) out.sh = d.sh;
  }
  if (isHost && 'w' in d) {
    if (d.w === null) out.w = null;
    else if (d.w && typeof d.w === 'object' && !Array.isArray(d.w)) {
      let len = 0;
      try { len = JSON.stringify(d.w).length; } catch (e) { len = 1e9; }
      if (len <= 6000) out.w = d.w;
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- room list broadcasting (throttled) ---------- */
let listDirty = false, listTimer = null;
function markList() {
  listDirty = true;
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    if (!listDirty) return;
    listDirty = false;
    pushLists();
  }, 600);
}
function roomList() {
  const out = [];
  for (const r of rooms.values()) {
    out.push({ r: r.code, h: r.meta.h, n: r.players.size, m: MAX_PER_ROOM, w: r.meta.w, o: r.meta.o, t: r.created });
  }
  out.sort((a, b) => (a.n >= a.m) - (b.n >= b.m) || b.t - a.t);
  return out.slice(0, 50).map(x => ({ r: x.r, h: x.h, n: x.n, m: x.m, w: x.w, o: x.o }));
}
function pushLists() {
  const msg = { t: 'rooms', list: roomList(), online: clients.size };
  for (const c of clients.values()) if (!c.room) send(c, msg);
}

/* ---------- room lifecycle ---------- */
function closeRoom(room, why) {
  rooms.delete(room.code);
  for (const p of room.players.values()) {
    if (p.c.id !== room.host) send(p.c, { t: 'closed', why: why || 'host' });
    p.c.room = null;
    send(p.c, { t: 'rooms', list: roomList(), online: clients.size });
  }
  markList();
}
function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  if (room.host === c.id) {
    closeRoom(room, 'host');
    return;
  }
  room.players.delete(c.id);
  c.room = null;
  for (const p of room.players.values()) send(p.c, { t: 'left', id: c.id });
  send(c, { t: 'rooms', list: roomList(), online: clients.size });
  markList();
}

function relay(c, room, patch) {
  const common = {};
  const hasSh = 'sh' in patch;
  for (const k of Object.keys(patch)) if (k !== 'sh') common[k] = patch[k];
  const hasCommon = Object.keys(common).length > 0;
  for (const p of room.players.values()) {
    if (p.c.id === c.id) continue;
    let d = null;
    if (hasCommon) d = Object.assign({}, common);
    if (hasSh && p.c.id === room.host) { d = d || {}; d.sh = patch.sh; }   // shots only go to the host
    if (d) send(p.c, { t: 'pr', id: c.id, d: d });
  }
}

/* ---------- message handling ---------- */
function onMessage(c, raw) {
  const now = Date.now();
  if (now - c.win > 1000) { c.win = now; c.cnt = 0; }
  if (++c.cnt > 90) {
    if (++c.drops > 300) c.ws.terminate();
    return;
  }
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

  switch (m.t) {
    case 'list':
      send(c, { t: 'rooms', list: roomList(), online: clients.size });
      return;

    case 'create': {
      if (c.room) { send(c, { t: 'err', code: 'busy', msg: 'You are already in a room.' }); return; }
      if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', code: 'full', msg: 'The server is full. Try again in a few minutes.' }); return; }
      const code = newCode();
      if (!code) { send(c, { t: 'err', code: 'full', msg: 'Could not create a room. Try again.' }); return; }
      c.nick = cleanNick(m.nick);
      const room = {
        code: code, host: c.id, created: now, last: now,
        players: new Map(), meta: { h: c.nick, w: 0, o: 1 }
      };
      room.players.set(c.id, { c: c, pr: { n: c.nick } });
      rooms.set(code, room);
      c.room = room;
      send(c, { t: 'joined', room: code, id: c.id, host: c.id, peers: [] });
      markList();
      return;
    }

    case 'join': {
      if (c.room) { send(c, { t: 'err', code: 'busy', msg: 'You are already in a room.' }); return; }
      const room = typeof m.room === 'string' ? rooms.get(m.room) : null;
      if (!room) { send(c, { t: 'err', code: 'gone', msg: 'That room is not available any more.' }); return; }
      if (room.players.size >= MAX_PER_ROOM) { send(c, { t: 'err', code: 'full', msg: 'That room is full.' }); return; }
      c.nick = cleanNick(m.nick);
      const peers = [];
      for (const p of room.players.values()) {
        const pr = Object.assign({}, p.pr);
        delete pr.sh;
        peers.push({ id: p.c.id, pr: pr });
      }
      room.players.set(c.id, { c: c, pr: { n: c.nick } });
      c.room = room;
      send(c, { t: 'joined', room: room.code, id: c.id, host: room.host, peers: peers });
      for (const p of room.players.values()) {
        if (p.c.id !== c.id) send(p.c, { t: 'pr', id: c.id, d: { n: c.nick } });
      }
      markList();
      return;
    }

    case 'leave':
      leaveRoom(c);
      return;

    case 'info': {
      const room = c.room;
      if (!room || room.host !== c.id || !m.d || typeof m.d !== 'object') return;
      room.last = now;
      const w = Math.floor(+m.d.w);
      const nw = Number.isFinite(w) ? Math.max(0, Math.min(999, w)) : room.meta.w;
      const no = m.d.o ? 1 : 0;
      if (nw !== room.meta.w || no !== room.meta.o) { room.meta.w = nw; room.meta.o = no; markList(); }
      return;
    }

    case 'pr': {
      const room = c.room;
      if (!room) return;
      const isHost = room.host === c.id;
      if (isHost) room.last = now;
      const patch = sanitize(m.d, isHost);
      if (!patch) return;
      const me = room.players.get(c.id);
      if (!me) return;
      mergeInto(me.pr, patch);
      relay(c, room, patch);
      return;
    }
  }
}

/* ---------- WebSocket server ---------- */
const wss = new WebSocketServer({
  server: server,
  path: '/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
  verifyClient: (info, cb) => {
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(info.origin)) { cb(false, 403, 'Origin not allowed'); return; }
    cb(true);
  }
});
wss.on('connection', (ws, req) => {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || '?';
  const n = (ipCount.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.close(1013, 'Too many connections'); return; }
  ipCount.set(ip, n);

  const c = { id: newId(), ws: ws, ip: ip, room: null, nick: 'Soldier', win: 0, cnt: 0, drops: 0, alive: true };
  clients.set(c.id, c);
  send(c, { t: 'hi', id: c.id });
  send(c, { t: 'rooms', list: roomList(), online: clients.size });
  markList();

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { onMessage(c, data.toString()); } catch (e) { console.error('message error', e && e.message); }
  });
  ws.on('close', () => {
    leaveRoom(c);
    clients.delete(c.id);
    const left = (ipCount.get(ip) || 1) - 1;
    if (left <= 0) ipCount.delete(ip); else ipCount.set(ip, left);
    markList();
  });
  ws.on('error', () => { /* handled by close */ });
});

/* keep connections alive and drop dead ones; close rooms whose host went silent */
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { /* closed */ }
  }
  const now = Date.now();
  for (const r of Array.from(rooms.values())) {
    if (now - r.last > HOST_IDLE_MS) closeRoom(r, 'idle');
  }
}, 5000);

setInterval(() => {
  console.log(new Date().toISOString(), 'online', clients.size, 'rooms', rooms.size);
}, 60000).unref();

server.listen(PORT, () => console.log('Bunker Siege server on port ' + PORT));
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
