#!/usr/bin/env node
// cast-agent (runs on the PC):
//  1. read-only file server for local folders so cast-hub can browse/stream them;
//  2. the transcoder: all ffmpeg decode/encode happens here, never on the Pi.
// Registers itself with the hub every minute.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeJoin, normRel, listLocalDir, searchLocal, serveFile, sendJson, isMedia, mimeOf, httpErr, readJsonBody } from './lib.mjs';
import { localIpFor } from './upnp.mjs';
import { bins, hasBinary, detectEncoder, buildFfmpegArgs, spawnFfmpeg, ffprobe } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.CAST_AGENT_CONFIG || path.join(HERE, '..', 'agent.config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
if (!cfg.token) { cfg.token = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
if (cfg.ffmpeg) bins.ffmpeg = cfg.ffmpeg;
if (cfg.ffprobe) bins.ffprobe = cfg.ffprobe;
const port = cfg.port || 8791;
const id = cfg.id || os.hostname().toLowerCase();
const roots = Object.fromEntries((cfg.roots || []).map((r) => [r.id, r]));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const caps = { transcode: false, encoder: 'libx264' };
function rootOf(rid) { const r = roots[rid]; if (!r) throw httpErr(404, '未知目录'); return r; }
const authed = (req, token) => token === cfg.token || req.headers['x-cast-token'] === cfg.token;

// Transcode jobs: hub POSTs a spec, gets an id; the renderer then GETs /t/<token>/<id>.ts.
// Only accepted inputs: one of our own roots, or an http(s) URL the hub hands us (a Pi file URL).
const jobs = new Map(); // id -> { spec, procs:Set, created }
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
// Reap jobs nobody is streaming any more.
setInterval(() => { const now = Date.now(); for (const [jid, j] of jobs) if (!j.procs.size && now - j.touched > 10 * 60e3) killJob(jid); }, 60e3).unref();

function streamJob(req, res, jid) {
  const j = jobs.get(jid);
  if (!j) { res.writeHead(410); return res.end(); }
  j.touched = Date.now();
  res.writeHead(200, {
    'Content-Type': 'video/mp2t', 'transferMode.dlna.org': 'Streaming', 'Cache-Control': 'no-store',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  });
  if (req.method === 'HEAD') return res.end();
  const args = buildFfmpegArgs({ input: j.input, offset: j.spec.offset || 0, mode: j.spec.mode || 'video', encoder: caps.encoder, maxHeight: cfg.maxHeight || 1080 });
  const proc = spawnFfmpeg(args);
  j.procs.add(proc);
  // Renderers may open a probe connection plus the real one; keep the newest two encoders.
  if (j.procs.size > 2) { const oldest = j.procs.values().next().value; try { oldest.kill('SIGKILL'); } catch { /* gone */ } j.procs.delete(oldest); }
  let errTail = '';
  proc.stderr.on('data', (c) => { errTail = (errTail + c).slice(-2000); });
  proc.stdout.pipe(res);
  proc.on('close', (code) => { j.procs.delete(proc); j.touched = Date.now(); if (code && code !== 255 && errTail.trim()) log(`ffmpeg exit ${code}: ${errTail.trim().split('\n').pop()}`); res.end(); });
  res.on('close', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
}

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
    if ((m = u.pathname.match(/^\/t\/([a-f0-9]+)\/([a-f0-9]+)\.ts$/))) {
      if (!authed(req, m[1])) throw httpErr(403, 'forbidden');
      return streamJob(req, res, m[2]);
    }
    if (!authed(req)) throw httpErr(403, 'forbidden');
    if (u.pathname === '/api/list') {
      const dir = safeJoin(rootOf(u.searchParams.get('root')).path, u.searchParams.get('path') || '');
      try { return sendJson(res, 200, await listLocalDir(dir)); } catch (e) { if (e.status) throw e; throw httpErr(404, '目录不存在或无法读取'); }
    }
    if (u.pathname === '/api/search') {
      return sendJson(res, 200, await searchLocal(rootOf(u.searchParams.get('root')).path, u.searchParams.get('q') || ''));
    }
    if (u.pathname === '/api/probe' && req.method === 'POST') {
      return sendJson(res, 200, { probe: caps.transcode ? await ffprobe(jobInput(await readJsonBody(req)), 30000) : null });
    }
    if (u.pathname === '/api/transcode' && req.method === 'POST') {
      if (!caps.transcode) throw httpErr(503, '电脑上没有可用的 ffmpeg');
      const spec = await readJsonBody(req);
      if (spec.replace) killJob(String(spec.replace));
      const jid = crypto.randomBytes(8).toString('hex');
      jobs.set(jid, { spec, input: jobInput(spec), procs: new Set(), touched: Date.now() });
      return sendJson(res, 200, { id: jid, url: `/t/${cfg.token}/${jid}.ts` });
    }
    if ((m = u.pathname.match(/^\/api\/transcode\/([a-f0-9]+)$/)) && req.method === 'DELETE') { killJob(m[1]); return sendJson(res, 200, { ok: true }); }
    if (u.pathname === '/api/ping') return sendJson(res, 200, { ok: true, id, caps });
    throw httpErr(404, 'not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message }); else res.destroy();
  }
});

function advertisedUrl() {
  const hubHost = new URL(cfg.hub).hostname;
  const ip = cfg.advertiseIp || (/^\d+\.\d+\.\d+\.\d+$/.test(hubHost) ? localIpFor(hubHost) : localIpFor('192.168.1.1'));
  return `http://${ip}:${port}`;
}
async function announce() {
  const body = JSON.stringify({
    key: cfg.agentKey, id, name: cfg.name || os.hostname(), url: advertisedUrl(), token: cfg.token,
    roots: Object.values(roots).map((r) => ({ id: r.id, name: r.name })),
    transcode: caps.transcode, encoder: caps.encoder,
  });
  try {
    const r = await fetch(`${cfg.hub.replace(/\/$/, '')}/api/agents/announce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
    if (!r.ok) log('announce failed', r.status, await r.text());
  } catch (e) { log('announce error', e.message); }
}

caps.transcode = (await hasBinary('ffmpeg')) && (await hasBinary('ffprobe'));
if (caps.transcode) caps.encoder = cfg.encoder || await detectEncoder();
server.listen(port, '0.0.0.0', () => { log(`cast-agent ${id} on :${port}, roots: ${Object.keys(roots).join(', ')}, transcode: ${caps.transcode ? caps.encoder : 'off'}`); announce(); });
setInterval(announce, 60e3);
process.on('SIGTERM', () => { for (const jid of jobs.keys()) killJob(jid); process.exit(0); });
