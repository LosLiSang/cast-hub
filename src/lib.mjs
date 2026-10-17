// Shared, dependency-free helpers for cast-hub (Pi) and cast-agent (PC).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Bumped whenever worker-side code changes; the hub flags workers running an older copy.
export const VERSION = '3';

export const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.rmvb': 'application/vnd.rn-realmedia-vbr', '.rm': 'application/vnd.rn-realmedia',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
};
export const extOf = (f) => path.extname(String(f)).toLowerCase();
export const isMedia = (f) => Object.hasOwn(MIME, extOf(f));
export const SUB_EXT = new Set(['.ass', '.ssa', '.srt', '.vtt']);
export const isSubFile = (f) => SUB_EXT.has(extOf(f));

// ---------------- subtitles (pure) ----------------
const LABELS = [
  [/(^|[.\s_\[(-])(zh-?hans|chs|sc|gb|zh-?cn|jpsc)($|[.\s_\])-])|简|簡/i, '简体中文'],
  [/(^|[.\s_\[(-])(zh-?hant|cht|tc|big5|zh-?tw|zh-?hk|jptc)($|[.\s_\])-])|繁/i, '繁體中文'],
  [/(^|[.\s_\[(-])(ja|jp|jpn|japanese)($|[.\s_\])-])|日/i, '日文'],
  [/(^|[.\s_\[(-])(en|eng|english)($|[.\s_\])-])|英/i, 'English'],
  [/(^|[.\s_\[(-])(zh|chi|zho|chinese|chs?)($|[.\s_\])-])|中/i, '中文'],
];
/** Human label from a filename tag ("zh-Hans"), stream title ("简体中文") or language code ("chi"). */
export function subLabel(...hints) {
  for (const h of hints) {
    const s = String(h || '').trim();
    if (!s) continue;
    for (const [re, label] of LABELS) if (re.test(s)) return label;
  }
  const first = hints.find((h) => String(h || '').trim());
  return first ? String(first).trim() : '字幕';
}

/** Sidecar subtitle files for a video: same basename followed by "." (e.g. "X.zh-Hans.ass", "X.srt"). */
export function findSidecars(videoName, names) {
  const base = String(videoName).replace(/\.[^.]+$/, '');
  return names
    .filter((n) => isSubFile(n) && n.startsWith(base) && n[base.length] === '.')
    .sort(natural)
    .map((n) => {
      const rest = n.slice(base.length + 1);
      const tagPart = rest.includes('.') ? rest.replace(/\.[^.]+$/, '') : '';
      return { id: `ext:${n}`, kind: 'external', name: n, codec: extOf(n).slice(1), label: tagPart ? subLabel(tagPart) : '外挂字幕' };
    });
}

export const IMAGE_SUB = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
export const TEXT_SUB = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text']);

/** Embedded subtitle tracks from a probe summary. `n` = index among subtitle streams (for -map 0:s:n). */
export function embeddedTracks(probe) {
  return (probe?.subtitles || [])
    .filter((s) => TEXT_SUB.has(s.codec) || IMAGE_SUB.has(s.codec))
    .map((s) => ({ id: `emb:${s.n}`, kind: 'embedded', n: s.n, codec: s.codec, image: IMAGE_SUB.has(s.codec), label: subLabel(s.title, s.lang) }));
}

// ---------------- workers (pure) ----------------
export const HW_FAMILIES = ['nvenc', 'qsv', 'amf'];
export const hasHardware = (w) => HW_FAMILIES.some((f) => w?.caps?.families?.[f]?.h264);
/** A worker the hub may dispatch transcode jobs to right now. */
export const workerUsable = (w) => !!(w && w.approved && w.prefs?.enabled !== false && w.online && w.reachable !== false && w.transcode);

/**
 * Pick the worker for a transcode job.
 * preferId: 'auto' or a worker id chosen by the user. When that worker is unusable we fall back to auto.
 * Auto order: hardware encoder first, then fewest running jobs, then the worker that already has the file
 * (no LAN hop), then most recently seen.
 */
export function rankWorkers(workers, { preferId = 'auto', sourceId = null, busy = {} } = {}) {
  const usable = workers.filter(workerUsable);
  if (preferId && preferId !== 'auto') {
    const w = usable.find((x) => x.id === preferId);
    if (w) return { worker: w, reason: 'manual' };
  }
  const sorted = [...usable].sort((a, b) =>
    (hasHardware(b) - hasHardware(a))
    || ((busy[a.id] || 0) - (busy[b.id] || 0))
    || ((b.id === sourceId) - (a.id === sourceId))
    || ((b.lastSeen || 0) - (a.lastSeen || 0)));
  if (!sorted.length) return { worker: null, reason: 'none' };
  return { worker: sorted[0], reason: preferId && preferId !== 'auto' ? 'fallback' : 'auto' };
}

/** Hub base URL for install scripts, from the browser's Host header. Only plain host[:port] is accepted. */
export function hubUrlFromHost(host, fallback) {
  const h = String(host || '').trim();
  if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h) || /^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(h)) return `http://${h}`;
  return fallback;
}

/** Fill __NAME__ placeholders. Values must be shell/PowerShell-safe (checked by the caller). */
export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/__([A-Z]+)__/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** Default track: keep the user's last label, else 简体 > 中文 > 繁體 > first; external beats embedded at equal label. */
export function pickDefaultSub(tracks, preferLabel) {
  if (!tracks.length) return null;
  const byLabel = (label) => tracks.find((t) => t.label === label && t.kind === 'external') || tracks.find((t) => t.label === label);
  for (const label of [preferLabel, '简体中文', '中文', '繁體中文']) {
    if (!label) continue;
    const t = byLabel(label);
    if (t) return t;
  }
  return tracks.find((t) => !t.image) || tracks[0];
}
export const mimeOf = (f) => MIME[extOf(f)] || 'video/mp4';
export const HIDDEN = /^(\.|@eaDir$|\$RECYCLE\.BIN$|System Volume Information$|lost\+found$|#recycle$)/i;
export const natural = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
export const DLNA_FILE_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

/** Normalise a client-supplied relative path to "a/b/c" (no leading slash, no "." segments). */
export function normRel(p = '') {
  return String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.').join('/');
}

/** Join root + relative path, refusing anything that escapes root. */
export function safeJoin(root, rel = '') {
  const base = path.resolve(root);
  const parts = normRel(rel).split('/').filter(Boolean);
  const p = path.resolve(base, ...parts);
  if (p !== base && !p.startsWith(base + path.sep)) throw httpErr(400, '非法路径');
  return p;
}

/** "01:02:03" | "62" | "1:02" -> seconds. UPnP NOT_IMPLEMENTED -> 0. */
export function toSec(t) {
  if (t === undefined || t === null || t === '' || /NOT_IMPLEMENTED/i.test(String(t))) return 0;
  const s = String(t).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.split(':').reduce((acc, p) => acc * 60 + Number(p || 0), 0) || 0;
}

export function hms(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Parse an HTTP Range header against a file size. Returns null when unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: size - 1, partial: false };
  let start; let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2])); }
  if (start > end || start >= size) return null;
  return { start, end, partial: true };
}

/** Given the current item's relative path and the sorted sibling names, return the neighbour path or null. */
export function siblingPath(rel, names, dir) {
  const r = normRel(rel);
  const parent = path.posix.dirname(r);
  const i = names.indexOf(path.posix.basename(r));
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= names.length) return null;
  return parent === '.' ? names[j] : `${parent}/${names[j]}`;
}

/**
 * Where is playback right now, in seconds of the source file?
 * direct: the renderer's RelTime is authoritative.
 * stream (ffmpeg, started at `offset`): offset + RelTime; renderers often report 0 for live TS,
 * so fall back to wall-clock time spent playing.
 */
export function estimatePosition({ mode, offset = 0, relTime = 0, playedMs = 0, duration = 0 }) {
  let pos;
  if (mode === 'direct') pos = relTime;
  else pos = offset + (relTime > 0 ? relTime : playedMs / 1000);
  if (duration > 0) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

/** Renderer went idle: did the item finish, fail to start, or get stopped by someone? */
export function classifyStop({ everPlayed, position = 0, duration = 0 }) {
  if (!everPlayed) return 'failed';
  if (duration > 0 && position >= duration - 20) return 'ended';
  return 'stopped';
}

/** Clamp a seek target into [0, duration-5]; relative targets are applied to `current`. */
export function seekTarget({ value, relative = false, current = 0, duration = 0 }) {
  let t = relative ? current + Number(value) : Number(value);
  if (!Number.isFinite(t)) throw httpErr(400, '无效的进度');
  if (duration > 0) t = Math.min(t, Math.max(0, duration - 5));
  return Math.max(0, Math.floor(t));
}

export async function listLocalDir(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = []; const files = []; const subs = [];
  await Promise.all(ents.map(async (e) => {
    if (HIDDEN.test(e.name)) return;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(); let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = await fsp.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { return; }
    }
    if (isDir) dirs.push({ name: e.name });
    else if (isFile && isSubFile(e.name)) subs.push(e.name);
    else if (isFile && isMedia(e.name)) {
      try { const st = await fsp.stat(full); files.push({ name: e.name, size: st.size, mtime: st.mtimeMs }); } catch { /* vanished */ }
    }
  }));
  dirs.sort((a, b) => natural(a.name, b.name));
  files.sort((a, b) => natural(a.name, b.name));
  subs.sort(natural);
  return { dirs, files, subs };
}

/** Breadth-first name search under root. Paths returned are relative and prefixed with `prefix`. */
export async function searchLocal(root, q, { limit = 200, maxEntries = 40000, prefix = '' } = {}) {
  const ql = String(q).toLowerCase().trim();
  if (!ql) return [];
  const out = []; const queue = ['']; let seen = 0;
  while (queue.length && out.length < limit && seen < maxEntries) {
    const rel = queue.shift();
    let ents;
    try { ents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen++;
      if (HIDDEN.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = prefix ? `${prefix}/${r}` : r;
      if (e.isDirectory()) {
        queue.push(r);
        if (e.name.toLowerCase().includes(ql)) out.push({ type: 'dir', path: full, name: e.name });
      } else if (isMedia(e.name) && e.name.toLowerCase().includes(ql)) out.push({ type: 'file', path: full, name: e.name });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Stream a file with Range support and DLNA headers. */
export async function serveFile(req, res, file, mime = mimeOf(file)) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end(); }
  const r = parseRange(req.headers.range, st.size);
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes', 'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': DLNA_FILE_FEATURES, 'Access-Control-Allow-Origin': '*',
  };
  if (!r) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
  if (r.partial) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${st.size}`;
  res.writeHead(r.partial ? 206 : 200, { ...headers, 'Content-Length': r.end - r.start + 1 });
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file, { start: r.start, end: r.end, highWaterMark: 1 << 20 });
  rs.on('error', () => res.destroy());
  rs.pipe(res);
  res.on('close', () => rs.destroy());
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(httpErr(413, '请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpErr(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}
