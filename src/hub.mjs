#!/usr/bin/env node
// cast-hub: LAN casting service. Discovers DLNA renderers, browses sources (local folders, PC agents, URLs),
// streams direct, and exposes a web remote with seekable progress.
// The Pi never decodes video: transcoding is delegated to a PC running cast-agent. The Pi only runs
// header-only ffprobe and serves bytes.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  normRel, safeJoin, httpErr, listLocalDir, searchLocal, serveFile, sendJson, readJsonBody, mimeOf, isMedia,
  natural, siblingPath, estimatePosition, classifyStop, seekTarget, toSec, extOf,
} from './lib.mjs';
import { discover, Renderer, localIpFor } from './upnp.mjs';
import { chooseMode, fallbackMode, ffprobe, hasBinary, extForInput } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const CONFIG_FILE = process.env.CAST_HUB_CONFIG || path.join(APP_DIR, 'config.json');
const DATA_DIR = process.env.CAST_HUB_DATA || path.join(APP_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- config & persisted state ----------------
const config = {
  port: 8790, roots: [], agents: [], agentKey: '', autoNext: true,
  ...JSON.parse(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '{}'),
};
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = { lastDevice: null, history: {}, agents: {}, devices: [], ...(() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })() };
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  }, 1000);
}

// ---------------- capabilities ----------------
const caps = { ffprobe: false };
async function detectCaps() {
  caps.ffprobe = await hasBinary('ffprobe');
  log('caps', caps);
}

// ---------------- devices ----------------
const devices = new Map((store.devices || []).map((d) => [d.id, { ...d, online: false }]));
let scanning = null;
async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const found = await discover();
      const now = Date.now();
      for (const d of devices.values()) d.online = false;
      for (const d of found) devices.set(d.id, { ...devices.get(d.id), ...d, online: true, seenAt: now });
      store.devices = [...devices.values()].map(({ online, ...d }) => d);
      persist();
      log(`scan: ${found.length} renderer(s)`);
    } catch (e) { log('scan error', e.message); }
    finally { scanning = null; }
  })();
  return scanning;
}
const deviceList = () => [...devices.values()].map((d) => ({
  id: d.id, name: d.name, ip: d.ip, manufacturer: d.manufacturer, model: d.model, online: !!d.online,
})).sort((a, b) => (b.online - a.online) || natural(a.name, b.name));
function getDevice(id) {
  const d = devices.get(id || store.lastDevice);
  if (!d) throw httpErr(404, '没有找到这个设备，请先刷新设备列表');
  return d;
}

// ---------------- sources ----------------
// local:<rootId>  -> folder on this machine
// agent:<agentId>:<rootId> -> folder on a PC running cast-agent
function agentsAll() {
  const out = {};
  for (const a of config.agents || []) out[a.id] = { ...a, static: true };
  for (const [id, a] of Object.entries(store.agents || {})) out[id] = { ...out[id], ...a };
  return out;
}
const agentOnline = (a) => !!a.lastSeen && Date.now() - a.lastSeen < 3 * 60e3;
/** An online PC agent that can transcode, or null. */
function pickTranscoder() {
  return Object.values(agentsAll()).filter((a) => a.transcode && agentOnline(a)).sort((x, y) => y.lastSeen - x.lastSeen)[0] || null;
}
async function agentPost(agent, p, body, method = 'POST') {
  const r = await fetch(`${agent.url}${p}`, {
    method, headers: { 'X-Cast-Token': agent.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, `电脑端 ${agent.name}：${data.error || r.status}`);
  return data;
}
function sourcesList() {
  const list = (config.roots || []).map((r) => ({ id: `local:${r.id}`, name: r.name, kind: 'local', online: fs.existsSync(r.path) }));
  for (const a of Object.values(agentsAll())) {
    const online = agentOnline(a);
    for (const r of a.roots || []) list.push({ id: `agent:${a.id}:${r.id}`, name: `${a.name} · ${r.name}`, kind: 'agent', online: online || !!a.static });
  }
  return list;
}
function parseSource(id) {
  const [kind, a, b] = String(id || '').split(':');
  if (kind === 'local') {
    const root = (config.roots || []).find((r) => r.id === a);
    if (!root) throw httpErr(404, '未知的来源');
    return { kind, root };
  }
  if (kind === 'agent') {
    const agent = agentsAll()[a];
    if (!agent) throw httpErr(404, '电脑端没有在线');
    return { kind, agent, rootId: b };
  }
  throw httpErr(400, '未知的来源');
}
async function agentFetch(agent, p) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${agent.url}${p}`, { headers: { 'X-Cast-Token': agent.token }, signal: ctrl.signal });
    if (!r.ok) throw httpErr(r.status === 404 ? 404 : 502, `电脑端返回 ${r.status}`);
    return await r.json();
  } catch (e) { if (e.status) throw e; throw httpErr(502, `连不上电脑端 ${agent.name}（${e.name === 'AbortError' ? '超时' : e.message}）`); }
  finally { clearTimeout(t); }
}
const encPath = (rel) => normRel(rel).split('/').map(encodeURIComponent).join('/');

async function listSource(sourceId, rel) {
  const s = parseSource(sourceId);
  if (s.kind === 'local') {
    try { return await listLocalDir(safeJoin(s.root.path, rel)); } catch (e) { if (e.status) throw e; throw httpErr(404, '目录不存在或无法读取'); }
  }
  return agentFetch(s.agent, `/api/list?root=${encodeURIComponent(s.rootId)}&path=${encodeURIComponent(normRel(rel))}`);
}
async function searchSource(sourceId, q) {
  const s = parseSource(sourceId);
  if (s.kind === 'local') return searchLocal(s.root.path, q);
  return agentFetch(s.agent, `/api/search?root=${encodeURIComponent(s.rootId)}&q=${encodeURIComponent(q)}`);
}
async function resolveItem({ source, path: rel, url, title }) {
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw httpErr(400, '只支持 http/https 链接');
    const name = title || decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url;
    return { source: 'url', path: url, title: name, input: url, directUrl: url, ext: extForInput(url), mime: mimeOf(url), key: `url|${url}` };
  }
  const r = normRel(rel);
  if (!isMedia(r)) throw httpErr(400, '不是支持的媒体文件');
  const s = parseSource(source);
  const name = path.posix.basename(r);
  if (s.kind === 'local') {
    const file = safeJoin(s.root.path, r);
    try { if (!(await fsp.stat(file)).isFile()) throw new Error(); } catch { throw httpErr(404, '文件不存在'); }
    return { source, path: r, title: name, input: file, directUrl: null, ext: extOf(name), mime: mimeOf(name), key: `${source}|${r}` };
  }
  const u = `${s.agent.url}/f/${s.agent.token}/${encodeURIComponent(s.rootId)}/${encPath(r)}`;
  return { source, path: r, title: name, input: u, directUrl: u, ext: extOf(name), mime: mimeOf(name), key: `${source}|${r}`, agentId: s.agent.id, agentRoot: s.rootId };
}

// ---------------- sessions ----------------
// Renderers echo TrackURI back with varying percent-encoding; compare decoded.
const sameUrl = (a, b) => { const d = (x) => { try { return decodeURIComponent(x); } catch { return x; } }; return d(a) === d(b); };
const sessions = new Map(); // deviceId -> Session
const byToken = new Map();  // token -> Session

class Session {
  constructor(dev) {
    this.dev = dev; this.r = new Renderer(dev);
    this.status = 'idle'; this.item = null; this.error = null; this.note = null;
    this.mode = 'direct'; this.requestedMode = 'auto'; this.offset = 0; this.gen = 0;
    this.job = null; this.token = null; this.chain = Promise.resolve();
    this.transport = ''; this.relTime = 0; this.rendererDuration = 0;
    this.volume = null; this.mute = false; this.failures = 0; this.timer = null;
    this.resetClock();
  }
  resetClock() { this.loadAt = Date.now(); this.everPlayed = false; this.playedMs = 0; this.lastTick = 0; this.relTime = 0; this.graceUntil = Date.now() + 6000; }
  get duration() { return this.item?.probe?.duration || this.rendererDuration || 0; }
  get position() {
    let played = this.playedMs;
    if (this.transport === 'PLAYING' && this.lastTick) played += Date.now() - this.lastTick;
    return estimatePosition({ mode: this.mode, offset: this.offset, relTime: this.relTime, playedMs: played, duration: this.duration });
  }
  run(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }

  host() { return localIpFor(this.dev.ip); }
  /** URL the transcoding PC uses to read the original (agent-local path, Pi file URL, or web URL). */
  transcodeSpec(agent) {
    const it = this.item;
    if (it.agentId && it.agentId === agent.id) return { root: it.agentRoot, path: it.path };
    if (it.directUrl) return { url: it.directUrl };
    return { url: `http://${localIpFor(new URL(agent.url).hostname)}:${config.port}/m/${this.token}/${encodeURIComponent(it.title)}` };
  }
  async mediaUrl() {
    if (this.mode === 'direct') {
      if (this.item.directUrl) return this.item.directUrl;
      return `http://${this.host()}:${config.port}/m/${this.token}/${encodeURIComponent(this.item.title)}`;
    }
    const agent = pickTranscoder();
    if (!agent) throw httpErr(503, '需要转码，但电脑端没有在线（树莓派不做解码）');
    const job = await agentPost(agent, '/api/transcode', { ...this.transcodeSpec(agent), offset: this.offset, mode: this.mode, replace: this.job?.id });
    this.job = { agent, id: job.id };
    return `${agent.url}${job.url}`;
  }
  killProcs() {
    const j = this.job; this.job = null;
    if (j) agentPost(j.agent, `/api/transcode/${j.id}`, null, 'DELETE').catch(() => {});
  }

  async start(item, { mode = 'auto', start = 0 } = {}) {
    this.killProcs();
    if (this.token) byToken.delete(this.token);
    this.token = crypto.randomBytes(8).toString('hex'); byToken.set(this.token, this);
    this.item = item; this.requestedMode = mode; this.error = null; this.note = null; this.rendererDuration = 0;
    this.status = 'loading';
    if (!item.probe) item.probe = await this.probe(item);
    const tc = pickTranscoder();
    let m;
    if (mode === 'direct') m = { mode: 'direct', reason: '手动选择直连' };
    else if (mode === 'transcode') m = { mode: 'video', reason: `手动选择转码（${tc ? tc.name : '电脑端不在线'}）` };
    else m = chooseMode(item.probe, { ext: item.ext, isUrl: item.source === 'url' });
    if (m.mode !== 'direct' && !tc) m = { mode: 'direct', reason: `${m.reason}；电脑端不在线，先直连尝试` };
    else if (m.mode !== 'direct') m.reason += `，由 ${tc.name} 转码`;
    this.note = m.reason;
    await this.load(m.mode, start);
  }

  /** Header-only probe. Pi-local files use the Pi's ffprobe (cheap); PC files are probed on the PC. */
  async probe(item) {
    try {
      if (item.agentId) {
        const a = agentsAll()[item.agentId];
        if (a?.transcode) return (await agentPost(a, '/api/probe', { root: item.agentRoot, path: item.path })).probe;
      }
      if (caps.ffprobe) return await ffprobe(item.input, item.source === 'url' ? 30000 : 20000);
    } catch (e) { log('probe failed', e.message); }
    return null;
  }

  async load(mode, offset) {
    this.mode = mode; this.offset = mode === 'direct' ? 0 : Math.max(0, Math.floor(offset || 0)); this.gen++;
    if (mode === 'direct') this.killProcs();
    this.resetClock(); this.status = 'loading';
    const url = await this.mediaUrl();
    this.currentUrl = url;
    log(`[${this.dev.name}] load mode=${mode} offset=${this.offset} ${this.item.title}`);
    await this.r.load(url, { title: this.item.title, mime: mode === 'direct' ? this.item.mime : 'video/mp2t' });
    this.pendingDirectSeek = mode === 'direct' && offset > 0 ? Math.floor(offset) : 0;
    this.ensurePolling();
  }

  ensurePolling() { if (!this.timer) this.timer = setInterval(() => this.tick().catch(() => {}), 1500); }
  stopPolling() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (!this.item || this.busy) return;
    let st;
    try { st = await this.r.state(); this.failures = 0; }
    catch (e) {
      if (++this.failures >= 6) { this.status = 'error'; this.error = `设备无响应：${e.message}`; this.stopPolling(); this.killProcs(); }
      return;
    }
    const now = Date.now();
    if (this.transport === 'PLAYING' && this.lastTick) this.playedMs += now - this.lastTick;
    this.lastTick = now;
    this.transport = st.transport;
    this.relTime = toSec(st.relTime);
    const d = toSec(st.duration); if (d > 0 && this.mode === 'direct') this.rendererDuration = d;

    // Someone else took over the renderer (phone app cast etc.)
    if (st.uri && this.currentUrl && !sameUrl(st.uri, this.currentUrl) && now > this.graceUntil) {
      this.status = 'idle'; this.note = '设备已被其他应用接管'; this.killProcs(); this.stopPolling(); return;
    }
    if (st.transport === 'PLAYING') {
      if (this.relTime > 0 || this.playedMs > 3000) this.everPlayed = true;
      this.status = 'playing';
      if (this.pendingDirectSeek && this.relTime > 0) { const t = this.pendingDirectSeek; this.pendingDirectSeek = 0; this.run(() => this.seekTo(t)); }
    } else if (st.transport === 'PAUSED_PLAYBACK') { this.status = 'paused'; this.everPlayed = true; }
    else if (st.transport === 'TRANSITIONING') { this.status = 'loading'; }
    else if (st.transport === 'STOPPED' || st.transport === 'NO_MEDIA_PRESENT') {
      if (this.status === 'stopped' || this.status === 'idle') return;
      if (!this.everPlayed && now < this.loadAt + 12000) return; // still spinning up
      const kind = classifyStop({ everPlayed: this.everPlayed, position: this.position, duration: this.duration });
      this.recordHistory(kind === 'ended');
      if (kind === 'failed') return this.run(() => this.onFailed());
      if (kind === 'ended') {
        this.killProcs();
        if (config.autoNext && this.item.source !== 'url') {
          const ok = await this.run(() => this.step(1).then(() => true).catch(() => false));
          if (ok) return;
        }
        this.status = 'stopped'; this.note = '播放结束'; this.stopPolling(); return;
      }
      this.status = 'stopped'; this.note = '已在设备上停止'; this.killProcs(); this.stopPolling(); return;
    }
    if (this.status === 'playing' || this.status === 'paused') this.recordHistory(false);
    if (this.status === 'loading' && !this.everPlayed && now > this.loadAt + 25000) this.run(() => this.onFailed());
  }

  async onFailed() {
    const next = this.requestedMode === 'auto' && pickTranscoder() ? fallbackMode(this.mode, this.item.probe) : null;
    if (next) {
      this.note = next === 'video' ? '设备无法直接播放，已自动转码' : '设备无法直接播放，已自动转换音频/封装';
      log(`[${this.dev.name}] fallback ${this.mode} -> ${next}`);
      return this.load(next, this.mode === 'direct' ? 0 : this.offset);
    }
    this.status = 'error'; this.error = '设备无法播放这个文件'; this.killProcs(); this.stopPolling();
  }

  recordHistory(finished) {
    if (!this.item) return;
    const pos = this.position; const dur = this.duration;
    if (!finished && pos < 5) return;
    store.history[this.item.key] = {
      source: this.item.source, path: this.item.path, title: this.item.title,
      position: finished ? 0 : Math.floor(pos), duration: Math.floor(dur), finished: !!finished, updatedAt: Date.now(),
    };
    const keys = Object.keys(store.history);
    if (keys.length > 300) keys.sort((a, b) => store.history[a].updatedAt - store.history[b].updatedAt).slice(0, keys.length - 300).forEach((k) => delete store.history[k]);
    persist();
  }

  async seekTo(t) {
    if (!this.item) throw httpErr(409, '当前没有在播放');
    const target = seekTarget({ value: t, current: this.position, duration: this.duration });
    this.busy = true;
    try {
      if (this.mode === 'direct') {
        try {
          await this.r.seek(target);
          this.relTime = target; this.graceUntil = Date.now() + 4000; this.lastTick = Date.now();
          return;
        } catch (e) {
          if (!pickTranscoder()) throw httpErr(502, `设备不支持跳转：${e.message}`);
          this.note = '设备不支持直接跳转，已切换为流式播放';
          await this.load(this.item.probe?.video && ['h264', 'hevc'].includes(this.item.probe.video.codec) ? 'remux' : 'video', target);
          return;
        }
      }
      // Streamed: restart ffmpeg at the new offset and point the renderer at a fresh URL.
      await this.load(this.mode, target);
    } finally { this.busy = false; }
  }

  async step(dir) {
    if (!this.item || this.item.source === 'url') throw httpErr(409, '没有上一集/下一集');
    const parent = path.posix.dirname(this.item.path);
    const { files } = await listSource(this.item.source, parent === '.' ? '' : parent);
    const target = siblingPath(this.item.path, files.map((f) => f.name), dir);
    if (!target) throw httpErr(404, dir > 0 ? '已经是最后一集' : '已经是第一集');
    this.recordHistory(false);
    const item = await resolveItem({ source: this.item.source, path: target });
    await this.start(item, { mode: this.requestedMode });
  }

  /** Freeze the wall clock at pause so streamed positions don't drift. */
  async pause() {
    await this.r.pause();
    if (this.transport === 'PLAYING' && this.lastTick) this.playedMs += Date.now() - this.lastTick;
    this.lastTick = Date.now(); this.transport = 'PAUSED_PLAYBACK'; this.status = 'paused';
    this.recordHistory(false);
  }
  async resume() {
    await this.r.play();
    this.lastTick = Date.now(); this.transport = 'PLAYING'; this.status = 'playing'; this.ensurePolling();
  }

  async stop() {
    this.recordHistory(false);
    this.stopPolling(); this.killProcs();
    try { await this.r.stop(); } catch { /* already idle */ }
    this.status = 'stopped'; this.transport = 'STOPPED';
  }

  async refreshVolume() {
    try { this.volume = await this.r.getVolume(); } catch { this.volume = null; }
    try { this.mute = await this.r.getMute(); } catch { /* optional */ }
  }

  view() {
    const it = this.item;
    return {
      device: { id: this.dev.id, name: this.dev.name, ip: this.dev.ip },
      status: this.status, transport: this.transport, error: this.error, note: this.note,
      mode: this.mode, requestedMode: this.requestedMode,
      position: Math.floor(this.position), duration: Math.floor(this.duration),
      seekable: !!it, volume: this.volume, mute: this.mute,
      item: it ? {
        title: it.title, source: it.source, path: it.path,
        video: it.probe?.video || null, audio: it.probe?.audio || null,
      } : null,
    };
  }
}
function sessionFor(deviceId) {
  const dev = getDevice(deviceId);
  let s = sessions.get(dev.id);
  if (!s) { s = new Session(dev); sessions.set(dev.id, s); }
  else s.dev = dev;
  return s;
}

// ---------------- streaming endpoints ----------------
async function handleMedia(req, res, token) {
  const s = byToken.get(token);
  if (!s || !s.item || s.item.directUrl) { res.writeHead(404); return res.end(); }
  return serveFile(req, res, s.item.input, s.item.mime);
}

// ---------------- API ----------------
const routes = {
  'GET /api/info': async () => {
    const tc = pickTranscoder();
    return { caps, transcoder: tc ? { name: tc.name, encoder: tc.encoder } : null, autoNext: config.autoNext, lastDevice: store.lastDevice };
  },
  'GET /api/devices': async () => ({ scanning: !!scanning, lastDevice: store.lastDevice, devices: deviceList() }),
  'POST /api/devices/scan': async () => { await scan(); return { lastDevice: store.lastDevice, devices: deviceList() }; },
  'GET /api/sources': async () => sourcesList(),
  'GET /api/list': async (q) => ({ source: q.source, path: normRel(q.path), ...(await listSource(q.source, q.path)) }),
  'GET /api/search': async (q) => ({ results: await searchSource(q.source, q.q || '') }),
  'GET /api/history': async () => Object.values(store.history).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
  'GET /api/state': async (q) => {
    const id = q.device || store.lastDevice;
    const s = id && sessions.get(id);
    if (s) return s.view();
    const d = id && devices.get(id);
    return d ? { device: { id: d.id, name: d.name, ip: d.ip }, status: 'idle', position: 0, duration: 0, item: null } : { status: 'idle', item: null };
  },
  'POST /api/play': async (_q, body) => {
    const s = sessionFor(body.device);
    store.lastDevice = s.dev.id; persist();
    const item = await resolveItem(body);
    let start = Number(body.start);
    if (!Number.isFinite(start)) { const h = store.history[item.key]; start = body.resume !== false && h && !h.finished && h.position > 15 ? h.position : 0; }
    await s.run(async () => { await s.start(item, { mode: body.mode || 'auto', start }); await s.refreshVolume(); });
    return s.view();
  },
  'POST /api/control': async (_q, body) => {
    const s = sessionFor(body.device);
    const v = body.value;
    await s.run(async () => {
      switch (body.action) {
        case 'pause': await s.pause(); break;
        case 'resume': await s.resume(); break;
        case 'toggle': if (s.transport === 'PLAYING') await s.pause(); else await s.resume(); break;
        case 'stop': await s.stop(); break;
        case 'seek': await s.seekTo(Number(v)); break;
        case 'seekRel': await s.seekTo(s.position + Number(v)); break;
        case 'next': await s.step(1); break;
        case 'prev': await s.step(-1); break;
        case 'volume': await s.r.setVolume(Number(v)); s.volume = Number(v); break;
        case 'mute': await s.r.setMute(!!v); s.mute = !!v; break;
        case 'mode': if (!s.item) throw httpErr(409, '当前没有在播放'); await s.start(s.item, { mode: v, start: s.position }); break;
        default: throw httpErr(400, '未知操作');
      }
    });
    if (body.action === 'volume' || body.action === 'mute') await s.refreshVolume();
    return s.view();
  },
  'POST /api/agents/announce': async (_q, body, req) => {
    if (!config.agentKey || body.key !== config.agentKey) throw httpErr(403, 'agent key 不正确');
    if (!body.id || !body.url || !body.token) throw httpErr(400, '缺少字段');
    store.agents[body.id] = {
      id: String(body.id), name: String(body.name || body.id), url: String(body.url).replace(/\/$/, ''), token: String(body.token),
      roots: (body.roots || []).map((r) => ({ id: String(r.id), name: String(r.name) })), lastSeen: Date.now(), from: req.socket.remoteAddress,
      transcode: !!body.transcode, encoder: String(body.encoder || ''),
    };
    persist();
    return { ok: true };
  },
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file;
  try { file = safeJoin(PUBLIC_DIR, rel); } catch { res.writeHead(404); return res.end(); }
  try {
    const body = await fsp.readFile(file);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    let m;
    if ((m = u.pathname.match(/^\/m\/([a-f0-9]+)\//))) return await handleMedia(req, res, m[1]);
    const key = `${req.method} ${u.pathname}`;
    const route = routes[key];
    if (route) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      return sendJson(res, 200, await route(Object.fromEntries(u.searchParams), body, req));
    }
    if (u.pathname.startsWith('/api/')) throw httpErr(404, '接口不存在');
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, u.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) log('error', req.method, u.pathname, e.message);
    if (!res.headersSent) sendJson(res, status, { error: e.message });
    else res.destroy();
  }
});

await detectCaps();
server.listen(config.port, '0.0.0.0', () => log(`cast-hub listening on :${config.port}`));
scan();
setInterval(scan, 5 * 60e3).unref();

const shutdown = () => { for (const s of sessions.values()) s.killProcs(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
