#!/usr/bin/env node
// cast-worker: runs on any LAN machine with Node 20+ and ffmpeg.
//  - shares local folders read-only so the hub can browse/stream them;
//  - does all decoding/encoding (subtitle burn-in, transcode) — the Pi hub never decodes.
// Joins the hub with a pairing code (`--hub http://pi:8790 --pair ABC123`), then polls the hub every
// 30 s to report health and receive settings. The hub dispatches jobs to it over HTTP.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeJoin, normRel, listLocalDir, searchLocal, serveFile, sendJson, isMedia, isSubFile, mimeOf, httpErr, readJsonBody, VERSION } from './lib.mjs';
import { localIpFor } from './upnp.mjs';
import { bins, hasBinary, detectEncoders, buildFfmpegArgs, spawnFfmpeg, ffprobe, extractSubtitle, dumpFonts, subOutput, pickEncoder, benchEncoder, gpuNames } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- config ----------------
function argv() {
  const o = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; }
  return o;
}
const args = argv();
const CONFIG_FILE = args.config || process.env.CAST_AGENT_CONFIG || path.join(HERE, '..', 'agent.config.json');
const cfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
if (args.hub) cfg.hub = String(args.hub).replace(/\/$/, '');
if (args.pair) cfg.pairCode = String(args.pair).toUpperCase();
if (args.name) cfg.name = String(args.name);
if (args.port) cfg.port = Number(args.port);
if (args.ffmpeg) cfg.ffmpeg = String(args.ffmpeg);
if (args.ffprobe) cfg.ffprobe = String(args.ffprobe);
if (!cfg.token) cfg.token = crypto.randomBytes(16).toString('hex');
if (!cfg.id) cfg.id = `${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
cfg.port ||= 8791;
cfg.roots ||= [];
const saveCfg = () => { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); };
saveCfg();
if (!cfg.hub) { console.error('缺少 hub 地址：node agent.mjs --hub http://<树莓派>:8790 --pair <配对码>'); process.exit(1); }
if (cfg.ffmpeg) bins.ffmpeg = cfg.ffmpeg;
if (cfg.ffprobe) bins.ffprobe = cfg.ffprobe;

const roots = () => Object.fromEntries((cfg.roots || []).map((r) => [r.id, r]));
let prefs = { enabled: true, encoder: 'auto', codec: 'auto', quality: 'high', maxHeight: 1080, maxJobs: 2 };
let approved = false;
const caps = { transcode: false, families: {}, libass: false, gpus: [], platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30) };
let bench = null;

function rootOf(rid) { const r = roots()[rid]; if (!r) throw httpErr(404, '未知目录'); return r; }
const authed = (req, token) => token === cfg.token || req.headers['x-cast-token'] === cfg.token;

// ---------------- transcode jobs ----------------
const SUB_DIR = path.join(os.tmpdir(), 'cast-agent-subs');
const subJobs = new Map();
const jobs = new Map(); // id -> { spec, input, enc, procs:Set, touched, started }
function jobInput(spec) {
  if (spec.url) { if (!/^https?:\/\//i.test(spec.url)) throw httpErr(400, 'bad url'); return spec.url; }
  const rel = normRel(spec.path);
  if (!isMedia(rel)) throw httpErr(400, 'not media');
  return safeJoin(rootOf(spec.root).path, rel);
}
function killJob(jid) {
  const j = jobs.get(jid); if (!j) return;
  for (const p of j.procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  jobs.delete(jid);
}
const activeJobs = () => [...jobs.values()].filter((j) => j.procs.size > 0).length;
setInterval(() => { const now = Date.now(); for (const [jid, j] of jobs) if (!j.procs.size && now - j.touched > 10 * 60e3) killJob(jid); }, 60e3).unref();

function subPrep(spec) {
  const key = String(spec.key || '');
  if (!/^[a-f0-9]{8,64}$/.test(key)) throw httpErr(400, 'bad key');
  const dir = path.join(SUB_DIR, key);
  const manifest = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifest)) return { state: 'ready' };
  const cur = subJobs.get(key);
  if (cur) { if (cur.state === 'error') subJobs.delete(key); return { state: cur.state, error: cur.error }; }
  const job = { state: 'working' };
  subJobs.set(key, job);
  (async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(dir, 'fonts'), { recursive: true });
    let sub; let fonts = [];
    if (spec.download) {
      for (const f of spec.download) {
        const name = normRel(f.name);
        const r = await fetch(f.url, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`下载字幕失败 ${r.status}`);
        await fs.promises.writeFile(safeJoin(dir, name), Buffer.from(await r.arrayBuffer()));
        if (name.startsWith('fonts/')) fonts.push(name.slice(6)); else sub = name;
      }
    } else {
      const input = jobInput(spec.input);
      if (spec.sidecar) {
        const src = safeJoin(rootOf(spec.sidecar.root).path, normRel(spec.sidecar.path));
        sub = `sub${path.extname(src).toLowerCase()}`;
        await fs.promises.copyFile(src, path.join(dir, sub));
      } else {
        sub = `sub${subOutput(spec.embedded.codec)[0]}`;
        await extractSubtitle(input, Number(spec.embedded.n), spec.embedded.codec, path.join(dir, sub));
      }
      fonts = await dumpFonts(input, spec.attachments || [], path.join(dir, 'fonts').replace(/\\/g, '/'));
    }
    if (!sub) throw new Error('没有字幕文件');
    await fs.promises.writeFile(manifest, JSON.stringify({ sub, fonts }));
    job.state = 'ready';
    log(`subtitle ready ${key} (${fonts.length} fonts)`);
  })().catch((e) => { job.state = 'error'; job.error = e.message; log('subtitle prep failed', key, e.message); });
  return { state: 'working' };
}
function subFor(key) {
  const dir = path.join(SUB_DIR, String(key));
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); return { dir, file: m.sub, fontsDir: 'fonts' }; } catch { return null; }
}

function streamJob(req, res, jid) {
  const j = jobs.get(jid);
  if (!j) { res.writeHead(410); return res.end(); }
  j.touched = Date.now();
  res.writeHead(200, {
    'Content-Type': 'video/mp2t', 'transferMode.dlna.org': 'Streaming', 'Cache-Control': 'no-store',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  });
  if (req.method === 'HEAD') return res.end();
  let subtitle; let cwd;
  if (j.spec.sub?.key) { const s = subFor(j.spec.sub.key); if (s) { subtitle = { file: s.file, fontsDir: s.fontsDir }; cwd = s.dir; } }
  else if (j.spec.sub?.overlay !== undefined) subtitle = { overlay: Number(j.spec.sub.overlay) };
  const argsF = buildFfmpegArgs({ input: j.input, offset: j.spec.offset || 0, mode: j.spec.mode || 'video', enc: j.enc, maxHeight: prefs.maxHeight || 1080, subtitle });
  const proc = spawnFfmpeg(argsF, { cwd });
  j.procs.add(proc);
  // Renderers may open a probe connection plus the real one; keep the newest two encoders.
  if (j.procs.size > 2) { const oldest = j.procs.values().next().value; try { oldest.kill('SIGKILL'); } catch { /* gone */ } j.procs.delete(oldest); }
  let errTail = '';
  proc.stderr.on('data', (c) => { errTail = (errTail + c).slice(-2000); });
  proc.stdout.pipe(res);
  proc.on('close', (code) => { j.procs.delete(proc); j.touched = Date.now(); if (code && code !== 255 && errTail.trim()) log(`ffmpeg exit ${code}: ${errTail.trim().split('\n').pop()}`); res.end(); });
  res.on('close', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    let m;
    if ((m = u.pathname.match(/^\/f\/([a-f0-9]+)\/([^/]+)\/(.+)$/))) {
      if (!authed(req, m[1])) throw httpErr(403, 'forbidden');
      const rel = normRel(decodeURIComponent(m[3]));
      if (!isMedia(rel)) throw httpErr(403, 'not media');
      const file = safeJoin(rootOf(decodeURIComponent(m[2])).path, rel);
      return await serveFile(req, res, file, mimeOf(file));
    }
    if ((m = u.pathname.match(/^\/sub\/([a-f0-9]+)\/([^/]+)\/(.+)$/))) {
      if (!authed(req, m[1])) throw httpErr(403, 'forbidden');
      const rel = normRel(decodeURIComponent(m[3]));
      if (!isSubFile(rel)) throw httpErr(403, 'not a subtitle');
      return await serveFile(req, res, safeJoin(rootOf(decodeURIComponent(m[2])).path, rel), 'application/octet-stream');
    }
    if ((m = u.pathname.match(/^\/t\/([a-f0-9]+)\/([a-f0-9]+)\.ts$/))) {
      if (!authed(req, m[1])) throw httpErr(403, 'forbidden');
      return streamJob(req, res, m[2]);
    }
    if (!authed(req)) throw httpErr(403, 'forbidden');
    if (u.pathname === '/api/ping') return sendJson(res, 200, { ok: true, id: cfg.id, version: VERSION, active: activeJobs() });
    if (u.pathname === '/api/list') {
      const dir = safeJoin(rootOf(u.searchParams.get('root')).path, u.searchParams.get('path') || '');
      try { return sendJson(res, 200, await listLocalDir(dir)); } catch (e) { if (e.status) throw e; throw httpErr(404, '目录不存在或无法读取'); }
    }
    if (u.pathname === '/api/search') return sendJson(res, 200, await searchLocal(rootOf(u.searchParams.get('root')).path, u.searchParams.get('q') || ''));
    if (u.pathname === '/api/probe' && req.method === 'POST') {
      return sendJson(res, 200, { probe: caps.transcode ? await ffprobe(jobInput(await readJsonBody(req)), 30000) : null });
    }
    if (u.pathname === '/api/transcode' && req.method === 'POST') {
      if (!caps.transcode) throw httpErr(503, '这台机器没有可用的 ffmpeg');
      if (prefs.enabled === false) throw httpErr(503, '这台 worker 已被停用');
      const spec = await readJsonBody(req);
      if (spec.replace) killJob(String(spec.replace));
      if (activeJobs() >= (prefs.maxJobs || 2)) throw httpErr(503, `这台 worker 正忙（已有 ${activeJobs()} 个任务）`);
      const enc = pickEncoder({ families: caps.families, pref: prefs.encoder, codec: prefs.codec, sourceCodec: spec.sourceCodec, safe: !!spec.safe });
      if (!enc) throw httpErr(503, '没有可用的编码器');
      enc.quality = prefs.quality || 'high';
      const jid = crypto.randomBytes(8).toString('hex');
      jobs.set(jid, { spec, input: jobInput(spec), enc, procs: new Set(), touched: Date.now(), started: Date.now() });
      return sendJson(res, 200, { id: jid, url: `/t/${cfg.token}/${jid}.ts`, encoder: enc });
    }
    if ((m = u.pathname.match(/^\/api\/transcode\/([a-f0-9]+)$/)) && req.method === 'DELETE') { killJob(m[1]); return sendJson(res, 200, { ok: true }); }
    if (u.pathname === '/api/subprep' && req.method === 'POST') {
      if (!caps.transcode) throw httpErr(503, '这台机器没有可用的 ffmpeg');
      return sendJson(res, 200, subPrep(await readJsonBody(req, 1 << 20)));
    }
    if (u.pathname === '/api/bench' && req.method === 'POST') {
      if (!caps.transcode) throw httpErr(503, '这台机器没有可用的 ffmpeg');
      const enc = pickEncoder({ families: caps.families, pref: prefs.encoder, codec: prefs.codec === 'auto' ? 'hevc10' : prefs.codec });
      bench = { ...(await benchEncoder(enc.family, enc.codec, prefs.quality)), family: enc.family, codec: enc.codec, quality: prefs.quality, at: Date.now() };
      log('bench', bench);
      return sendJson(res, 200, bench);
    }
    throw httpErr(404, 'not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message }); else res.destroy();
  }
});

// ---------------- hub link ----------------
function advertisedUrl() {
  const hubHost = new URL(cfg.hub).hostname;
  const ip = cfg.advertiseIp || (/^\d+\.\d+\.\d+\.\d+$/.test(hubHost) ? localIpFor(hubHost) : localIpFor('192.168.1.1'));
  return `http://${ip}:${cfg.port}`;
}
const describe = () => ({
  id: cfg.id, name: cfg.name || os.hostname(), url: advertisedUrl(), token: cfg.token, version: VERSION,
  roots: (cfg.roots || []).map((r) => ({ id: r.id, name: r.name, path: r.path })),
  transcode: caps.transcode, caps, bench, active: activeJobs(),
});
async function hubPost(p, body) {
  const r = await fetch(`${cfg.hub}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': cfg.secret || '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
}
let warned = '';
async function heartbeat() {
  try {
    if (!cfg.secret) {
      if (!cfg.pairCode) { if (warned !== 'nocode') log('未配对：在投屏中心「Worker」页生成配对码后用 --pair <码> 启动'); warned = 'nocode'; return; }
      const r = await hubPost('/api/workers/pair', { code: cfg.pairCode, ...describe() });
      cfg.secret = r.secret; delete cfg.pairCode; saveCfg();
      log(`已加入投屏中心 ${cfg.hub}，等待在网页上批准`);
    }
    const r = await hubPost('/api/workers/heartbeat', describe());
    approved = !!r.approved;
    if (r.prefs) prefs = { ...prefs, ...r.prefs };
    if (r.roots && JSON.stringify(r.roots) !== JSON.stringify(cfg.roots)) { cfg.roots = r.roots; saveCfg(); log('共享目录已更新', cfg.roots.map((x) => x.path).join(', ')); }
    if (r.bench && caps.transcode) { // hub asked for a speed test
      const enc = pickEncoder({ families: caps.families, pref: prefs.encoder, codec: prefs.codec === 'auto' ? 'hevc10' : prefs.codec });
      try { bench = { ...(await benchEncoder(enc.family, enc.codec, prefs.quality)), family: enc.family, codec: enc.codec, quality: prefs.quality, at: Date.now() }; } catch (e) { bench = { error: e.message, at: Date.now() }; }
      await hubPost('/api/workers/heartbeat', describe());
    }
    warned = '';
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      if (warned !== 'auth') log(`投屏中心拒绝了这台 worker（${e.message}）。请在网页上生成新的配对码，用 --pair 重新加入`);
      warned = 'auth'; delete cfg.secret; saveCfg();
    } else if (warned !== 'net') { log('连不上投屏中心', cfg.hub, e.message); warned = 'net'; }
  }
}

// ---------------- start ----------------
caps.transcode = (await hasBinary('ffmpeg')) && (await hasBinary('ffprobe'));
if (caps.transcode) {
  const d = await detectEncoders();
  caps.families = d.families; caps.libass = d.libass;
} else log('没有找到 ffmpeg/ffprobe：这台 worker 只能共享文件，不能转码（可用 --ffmpeg 指定路径）');
caps.gpus = await gpuNames();
server.listen(cfg.port, '0.0.0.0', () => {
  log(`cast-worker ${cfg.id} v${VERSION} on :${cfg.port}; encoders: ${Object.entries(caps.families).map(([f, c]) => `${f}(${Object.keys(c).join('/')})`).join(' ') || 'none'}`);
  heartbeat();
});
setInterval(heartbeat, 30e3);
process.on('SIGTERM', () => { for (const jid of jobs.keys()) killJob(jid); process.exit(0); });
