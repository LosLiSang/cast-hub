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
  findSidecars, embeddedTracks, pickDefaultSub, hubUrlFromHost, renderTemplate, VERSION,
} from './lib.mjs';
import { createWorkers } from './workers.mjs';
import { discover, Renderer, localIpFor } from './upnp.mjs';
import { chooseMode, fallbackMode, ffprobe, hasBinary, extForInput, dumpFonts, encoderLabel } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const CONFIG_FILE = process.env.CAST_HUB_CONFIG || path.join(APP_DIR, 'config.json');
const DATA_DIR = process.env.CAST_HUB_DATA || path.join(APP_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- config & persisted state ----------------
const config = {
  port: 8790, roots: [], autoNext: true,
  ...JSON.parse(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '{}'),
};
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = { lastDevice: null, history: {}, devices: [], ...(() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })() };
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  }, 1000);
}

delete store.agents; // pre-pairing registry
const workers = createWorkers({ store, persist, log });

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
// agent:<workerId>:<rootId> -> folder shared by a worker
const agentsAll = () => Object.fromEntries(workers.all().filter((w) => w.approved).map((w) => [w.id, w]));
/** Worker for a transcode job (honours the user's choice), or null. */
function pickTranscoder(sourceWorkerId) { return workers.pick(sourceWorkerId).worker; }
async function agentPost(agent, p, body, method = 'POST', timeout = 30000) {
  const r = await fetch(`${agent.url}${p}`, {
    method, headers: { 'X-Cast-Token': agent.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status === 503 ? 503 : 502, `${agent.name}：${data.error || r.status}`);
  return data;
}
function sourcesList() {
  const list = (config.roots || []).map((r) => ({ id: `local:${r.id}`, name: r.name, kind: 'local', online: fs.existsSync(r.path) }));
  for (const a of Object.values(agentsAll())) {
    for (const r of a.roots || []) list.push({ id: `agent:${a.id}:${r.id}`, name: `${a.name} · ${r.name}`, kind: 'agent', online: a.online });
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
    if (!agent) throw httpErr(404, '这台 worker 不存在或未批准');
    if (!agent.online) throw httpErr(503, `${agent.name} 不在线`);
    return { kind, agent, rootId: b };
  }
  throw httpErr(400, '未知的来源');
}
async function agentFetch(agent, p) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${agent.url}${p}`, { headers: { 'X-Cast-Token': agent.token }, signal: ctrl.signal });
    if (!r.ok) throw httpErr(r.status === 404 ? 404 : 502, `${agent.name} 返回 ${r.status}`);
    return await r.json();
  } catch (e) { if (e.status) throw e; throw httpErr(502, `连不上 ${agent.name}（${e.name === 'AbortError' ? '超时' : e.message}）`); }
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
    this.subs = []; this.subId = 'off'; this.subState = null; this.subKey = null;
    this.transport = ''; this.relTime = 0; this.rendererDuration = 0;
    this.volume = null; this.mute = false; this.failures = 0; this.timer = null;
    this.resetClock();
  }
  resetClock() { this.nudged = false; this.userPaused = false; this.loadAt = Date.now(); this.everPlayed = false; this.playedMs = 0; this.lastTick = 0; this.relTime = 0; this.graceUntil = Date.now() + 6000; }
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
    const agent = this.worker && workers.all().find((w) => w.id === this.worker.id && w.online) ? this.worker : pickTranscoder(this.item.agentId);
    if (!agent) throw httpErr(503, '需要转码，但没有可用的 worker（树莓派不做解码）。到「Worker」页添加或启用一台');
    let sub;
    const t = this.subTrack();
    if (t?.image) sub = { overlay: t.n };
    else if (t && this.subState === 'ready') sub = { key: this.subKey };
    this.loadedSubKey = sub?.key || null;
    // The worker picks family/codec from its own prefs. sourceCodec lets it choose HEVC 10-bit when the
    // renderer evidently decodes HEVC; safe=true (renderer refused the source) forces H.264.
    const replace = this.job && this.job.agent.id === agent.id ? this.job.id : undefined;
    if (this.job && !replace) this.killProcs();
    const job = await agentPost(agent, '/api/transcode', {
      ...this.transcodeSpec(agent), offset: this.offset, mode: this.mode, replace, sub,
      sourceCodec: this.item.probe?.video?.codec, safe: !!this.fellBack,
    });
    if (!replace) workers.busy[agent.id] = (workers.busy[agent.id] || 0) + 1;
    this.job = { agent, id: job.id }; this.worker = agent; this.encoder = job.encoder || null;
    return `${agent.url}${job.url}`;
  }
  killProcs() {
    const j = this.job; this.job = null;
    if (j) {
      workers.busy[j.agent.id] = Math.max(0, (workers.busy[j.agent.id] || 1) - 1);
      agentPost(j.agent, `/api/transcode/${j.id}`, null, 'DELETE').catch(() => {});
    }
  }

  async start(item, { mode = 'auto', start = 0 } = {}) {
    this.killProcs();
    if (this.token) byToken.delete(this.token);
    this.token = crypto.randomBytes(8).toString('hex'); byToken.set(this.token, this);
    this.item = item; this.requestedMode = mode; this.error = null; this.note = null; this.rendererDuration = 0;
    if (this.subsFor !== item.key) this.fellBack = false;
    this.status = 'loading';
    if (!item.probe) item.probe = await this.probe(item);
    const tc = pickTranscoder(item.agentId);
    this.worker = tc;
    // Subtitle: keep the current choice when re-starting the same item, else pick by preference.
    const sameItem = this.subsFor === item.key;
    if (!sameItem) {
      this.subs = await subtitleTracks(item);
      this.subsFor = item.key;
      const want = store.subPref === 'off' ? null : pickDefaultSub(this.subs, store.subPref);
      this.subId = want ? want.id : 'off';
      this.subState = null; this.subKey = null;
    }
    const burning = this.subId !== 'off';
    let prep = null;
    if (burning && tc && !this.subTrack()?.image && this.subState !== 'ready') {
      // Wait briefly (sidecar files / cache are fast) so the first load already has subtitles.
      this.prepInline = true;
      prep = this.prepareSubtitle(tc).catch(() => {});
      await Promise.race([prep, new Promise((r) => setTimeout(r, 6000))]);
      this.prepInline = false;
    }
    let m;
    if (mode === 'direct') m = { mode: 'direct', reason: '手动选择直连' };
    else if (mode === 'transcode') m = { mode: 'video', reason: '手动选择转码' };
    else if (burning && tc) m = { mode: 'video', reason: '字幕烧录进画面' };
    else m = chooseMode(item.probe, { ext: item.ext, isUrl: item.source === 'url' });
    if (m.mode !== 'direct' && !tc) m = { mode: 'direct', reason: `${m.reason}；没有可用的 worker，先直连尝试` };
    this.note = m.reason;
    await this.load(m.mode, start);
    if (prep && this.subState !== 'ready' && this.subState !== 'error') {
      this.note = '字幕准备中，就绪后自动加上';
      const key = item.key;
      prep.then(() => this.run(async () => {
        if (this.item?.key === key && this.mode === 'video' && this.subState === 'ready' && this.loadedSubKey !== this.subKey) await this.load('video', this.position);
      }));
    }
  }

  subTrack() { return this.subId === 'off' ? null : this.subs.find((t) => t.id === this.subId) || null; }

  /**
   * Ask the transcoding PC to prepare the chosen text subtitle (+ embedded fonts). Extraction of an
   * embedded track has to read the whole file once, so it runs in the background; playback starts
   * immediately and the stream is restarted with subtitles as soon as they are ready.
   */
  async prepareSubtitle(agent) {
    const t = this.subTrack();
    if (!t || t.image) { this.subState = t ? 'ready' : null; return; }
    const item = this.item;
    const key = crypto.createHash('sha1').update(`${item.key}|${t.id}`).digest('hex').slice(0, 24);
    this.subKey = key;
    const spec = { key };
    const sameAgent = item.agentId && item.agentId === agent.id;
    if (t.kind === 'external') {
      const parent = path.posix.dirname(item.path);
      const subRel = parent === '.' ? t.name : `${parent}/${t.name}`;
      if (sameAgent) spec.input = { root: item.agentRoot, path: item.path }, spec.sidecar = { root: item.agentRoot, path: subRel };
      else spec.download = [{ name: `sub${extOf(t.name)}`, url: this.subFileUrl(agent, subRel) }];
      if (spec.download || spec.sidecar) spec.attachments = item.probe?.attachments || [];
      if (spec.download) spec.download.push(...(await this.fontDownloads(agent)));
    } else {
      spec.input = sameAgent ? { root: item.agentRoot, path: item.path } : this.transcodeSpec(agent);
      spec.embedded = { n: t.n, codec: t.codec };
      spec.attachments = item.probe?.attachments || [];
    }
    // External sidecar on the same PC: let the agent dump fonts from the video itself.
    if (spec.sidecar) spec.attachments = item.probe?.attachments || [];
    this.subState = 'working';
    const startedFor = `${item.key}|${t.id}`;
    for (let i = 0; i < 240; i++) {
      let r;
      try { r = await agentPost(agent, '/api/subprep', spec); } catch (e) { r = { state: 'error', error: e.message }; }
      if (`${this.item?.key}|${this.subId}` !== startedFor) return; // user moved on
      if (r.state === 'ready') {
        this.subState = 'ready';
        this.note = '字幕已就绪';
        // Background completion: restart the stream with subtitles if it is still running without them.
        // Queued on the session chain so it can never race a user-triggered load.
        if (!this.prepInline) {
          await this.run(async () => {
            if (this.mode === 'video' && this.item && this.loadedSubKey !== this.subKey) await this.load('video', this.position);
          });
        }
        return;
      }
      if (r.state === 'error') { this.subState = 'error'; this.note = `字幕准备失败：${r.error}`; return; }
      // Sidecar copies finish in well under a second: poll fast first so the caller loads only once.
      await new Promise((res) => setTimeout(res, i < 10 ? 300 : 2500));
      delete spec.download; // already handed over; just poll
    }
    this.subState = 'error'; this.note = '字幕准备超时';
  }

  /** URL the PC can fetch a sidecar subtitle from (Pi file server or the source PC). */
  subFileUrl(agent, subRel) {
    const it = this.item;
    if (it.agentId) {
      const a = agentsAll()[it.agentId];
      return `${a.url}/sub/${a.token}/${encodeURIComponent(it.agentRoot)}/${encPath(subRel)}`;
    }
    const s = parseSource(it.source);
    const tok = crypto.randomBytes(8).toString('hex');
    subFiles.set(tok, { file: safeJoin(s.root.path, subRel), expires: Date.now() + 10 * 60e3 });
    return `http://${localIpFor(new URL(agent.url).hostname)}:${config.port}/s/${tok}`;
  }

  /** Embedded fonts for an external .ass that styles with them: Pi dumps them (stream copy, no decode). */
  async fontDownloads(agent) {
    const it = this.item;
    if (it.agentId || !it.probe?.attachments?.length || !caps.ffprobe) return [];
    const dir = path.join(DATA_DIR, 'fonts', crypto.createHash('sha1').update(it.key).digest('hex').slice(0, 16));
    await fsp.mkdir(dir, { recursive: true });
    const names = await dumpFonts(it.input, it.probe.attachments, dir);
    return names.map((n) => {
      const tok = crypto.randomBytes(8).toString('hex');
      subFiles.set(tok, { file: path.join(dir, n), expires: Date.now() + 10 * 60e3 });
      return { name: `fonts/${n}`, url: `http://${localIpFor(new URL(agent.url).hostname)}:${config.port}/s/${tok}` };
    });
  }

  async setSubtitle(id) {
    if (!this.item) throw httpErr(409, '当前没有在播放');
    if (id !== 'off' && !this.subs.find((t) => t.id === id)) throw httpErr(404, '没有这个字幕');
    this.subId = id; this.subState = null; this.subKey = null;
    store.subPref = id === 'off' ? 'off' : this.subTrack().label; persist();
    const tc = this.worker || pickTranscoder(this.item.agentId);
    if (id === 'off') {
      // Back to whatever the format needs (often direct).
      const m = this.requestedMode === 'transcode' ? 'video' : chooseMode(this.item.probe, { ext: this.item.ext, isUrl: this.item.source === 'url' }).mode;
      this.note = '已关闭字幕';
      return this.load(m !== 'direct' && !tc ? 'direct' : m, this.position);
    }
    if (!tc) throw httpErr(503, '显示字幕需要一台可用的 worker（树莓派不做解码）');
    this.note = this.subTrack().image ? '字幕烧录进画面' : '正在准备字幕…';
    if (this.subTrack().image) return this.load('video', this.position);
    // Give a cached subtitle a moment to come back so we load exactly once; a slow extraction
    // finishes in the background and reloads itself.
    this.prepInline = true;
    const prep = this.prepareSubtitle(tc).catch(() => {});
    await Promise.race([prep, new Promise((r) => setTimeout(r, 4000))]);
    this.prepInline = false;
    const want = this.subState === 'ready' ? this.subKey : null;
    log(`[${this.dev.name}] subtitle -> ${id} state=${this.subState} loaded=${this.loadedSubKey} want=${want}`);
    if (this.mode !== 'video' || this.loadedSubKey !== want || want === null) await this.load('video', this.position);
    if (this.subState !== 'ready' && this.subState !== 'error') {
      // Still extracting: when it lands, reload with it.
      prep.then(() => this.run(async () => {
        if (this.mode === 'video' && this.subState === 'ready' && this.loadedSubKey !== this.subKey) await this.load('video', this.position);
      }));
    }
  }

  /** Header-only probe. Pi-local files use the Pi's ffprobe (cheap); PC files are probed on the PC. */
  async probe(item) {
    try {
      if (item.agentId) {
        const a = agentsAll()[item.agentId];
        if (a?.transcode && a.online) return (await agentPost(a, '/api/probe', { root: item.agentRoot, path: item.path })).probe;
      }
      if (caps.ffprobe) return await ffprobe(item.input, item.source === 'url' ? 30000 : 20000);
    } catch (e) { log('probe failed', e.message); }
    return null;
  }

  async load(mode, offset) {
    this.mode = mode; this.offset = mode === 'direct' ? 0 : Math.max(0, Math.floor(offset || 0)); this.gen++;
    if (mode === 'direct') { this.killProcs(); this.loadedSubKey = null; }
    this.resetClock(); this.status = 'loading'; this.loading = true; this.error = null;
    try {
      const url = await this.mediaUrl();
      this.currentUrl = url;
      log(`[${this.dev.name}] load mode=${mode} offset=${this.offset} sub=${this.loadedSubKey || '-'} ${this.item.title}`);
      await this.r.load(url, { title: this.item.title, mime: mode === 'direct' ? this.item.mime : 'video/mp2t' });
    } finally { this.loading = false; }
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
    } else if (st.transport === 'PAUSED_PLAYBACK') {
      // Some renderers land in PAUSED after a load/seek even though Play was sent; nudge them once.
      if (!this.userPaused && now < this.loadAt + 20000 && !this.nudged) { this.nudged = true; this.r.play().catch(() => {}); }
      this.status = 'paused'; this.everPlayed = true;
    }
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
    const next = this.requestedMode === 'auto' && pickTranscoder(this.item.agentId) ? fallbackMode(this.mode, this.item.probe) : null;
    if (next) {
      this.fellBack = true;
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
          this.loadAt = Date.now(); this.nudged = false;
          return;
        } catch (e) {
          if (!pickTranscoder(this.item.agentId)) throw httpErr(502, `设备不支持跳转：${e.message}`);
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
    this.userPaused = true;
    await this.r.pause();
    if (this.transport === 'PLAYING' && this.lastTick) this.playedMs += Date.now() - this.lastTick;
    this.lastTick = Date.now(); this.transport = 'PAUSED_PLAYBACK'; this.status = 'paused';
    this.recordHistory(false);
  }
  async resume() {
    this.userPaused = false;
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
      subtitles: this.subs.map((t) => ({ id: t.id, label: t.label, kind: t.kind, codec: t.codec })),
      subtitle: this.subId, subState: this.subState,
      worker: this.mode !== 'direct' && this.job ? { id: this.job.agent.id, name: this.job.agent.name } : null,
      encoder: this.mode === 'video' && this.job ? encoderLabel(this.encoder) : null,
      item: it ? {
        title: it.title, source: it.source, path: it.path,
        video: it.probe?.video || null, audio: it.probe?.audio || null,
      } : null,
    };
  }
}
// One-shot file tokens the transcoding PC uses to fetch subtitles/fonts from the Pi.
const subFiles = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of subFiles) if (v.expires < now) subFiles.delete(k); }, 60e3).unref();

/** All subtitle tracks for an item: sidecar files next to it, then embedded streams. */
async function subtitleTracks(item) {
  if (item.source === 'url') return embeddedTracks(item.probe);
  const parent = path.posix.dirname(item.path);
  let names = [];
  try { names = (await listSource(item.source, parent === '.' ? '' : parent)).subs || []; } catch { /* ignore */ }
  return [...findSidecars(item.title, names), ...embeddedTracks(item.probe)];
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
    return { caps, version: VERSION, transcoder: pickView(), autoNext: config.autoNext, lastDevice: store.lastDevice };
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
        case 'subtitle': await s.setSubtitle(String(v)); break;
        case 'restream': if (s.item && s.mode !== 'direct') { s.worker = null; await s.load(s.mode, s.position); } break;
        default: throw httpErr(400, '未知操作');
      }
    });
    if (body.action === 'volume' || body.action === 'mute') await s.refreshVolume();
    return s.view();
  },
  // ---- workers ----
  'GET /api/workers': async () => ({ select: workers.selected(), hubVersion: VERSION, workers: workers.list(), pick: pickView() }),
  'POST /api/workers/paircode': async () => workers.newPairCode(),
  'POST /api/workers/pair': async (_q, body, req) => workers.pair(body, req.socket.remoteAddress),
  'POST /api/workers/heartbeat': async (_q, body, req) => workers.heartbeat(req, body),
  'POST /api/workers/update': async (_q, body) => workers.update(String(body.id), body),
  'POST /api/workers/remove': async (_q, body) => { workers.remove(String(body.id)); return { ok: true }; },
  'POST /api/workers/select': async (_q, body) => { workers.select(String(body.id || 'auto')); return { select: workers.selected(), pick: pickView() }; },
  'POST /api/workers/bench': async (_q, body) => {
    const w = workers.get(String(body.id));
    if (!workers.all().find((x) => x.id === w.id)?.online) throw httpErr(503, `${w.name} 不在线`);
    const r = await agentPost(w, '/api/bench', {}, 'POST', 300000);
    store.workers[w.id].bench = r; persist();
    return r;
  },

};

function pickView() {
  const r = workers.pick();
  return r.worker ? { id: r.worker.id, name: r.worker.name, reason: r.reason } : { id: null, reason: 'none' };
}

// ---------------- worker install ----------------
// GET /install/worker.ps1?code=XXXXXX | /install/worker.sh?code=XXXXXX | /install/worker.tar
const INSTALL_DIR = path.join(APP_DIR, 'install');
const WORKER_FILES = ['src/agent.mjs', 'src/lib.mjs', 'src/media.mjs', 'src/upnp.mjs', 'package.json'];
/** Minimal ustar archive (no deps) of a few small files. */
function tarFiles(files) {
  const blocks = [];
  const oct = (n, w) => n.toString(8).padStart(w - 1, '0') + '\0';
  for (const rel of files) {
    const data = fs.readFileSync(path.join(APP_DIR, rel));
    const h = Buffer.alloc(512);
    h.write(rel, 0, 100, 'utf8');
    h.write(oct(0o644, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
    h.write(oct(data.length, 12), 124); h.write(oct(Math.floor(Date.now() / 1000), 12), 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
async function serveInstall(req, res, name, q) {
  if (name === 'worker.tar') {
    const body = tarFiles(WORKER_FILES);
    res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': body.length });
    return res.end(body);
  }
  const code = String(q.code || '').toUpperCase();
  if (code && !/^[A-Z0-9]{6}$/.test(code)) throw httpErr(400, 'bad code');
  const hub = hubUrlFromHost(req.headers.host, `http://localhost:${config.port}`);
  const body = renderTemplate(await fsp.readFile(path.join(INSTALL_DIR, name), 'utf8'), { HUB: hub, CODE: code, VERSION });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

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
    if ((m = u.pathname.match(/^\/s\/([a-f0-9]+)$/))) {
      const f = subFiles.get(m[1]);
      if (!f) { res.writeHead(404); return res.end(); }
      return await serveFile(req, res, f.file, 'application/octet-stream');
    }
    if ((m = u.pathname.match(/^\/install\/(worker\.(?:ps1|sh|tar))$/))) return await serveInstall(req, res, m[1], Object.fromEntries(u.searchParams));
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
