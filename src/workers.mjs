// Worker registry on the hub: pairing codes, approval, per-worker prefs, health, selection.
import crypto from 'node:crypto';
import { httpErr, rankWorkers, workerUsable, VERSION } from './lib.mjs';

const ONLINE_MS = 90e3; // heartbeat every 30 s
const DEFAULT_PREFS = { enabled: true, encoder: 'auto', codec: 'auto', quality: 'high', maxHeight: 1080, maxJobs: 2 };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s, n = 80) => String(s ?? '').slice(0, n);
const sanitizeRoots = (roots) => roots.slice(0, 20).map((r, i) => ({
  id: clean(r.id || `f${i + 1}`, 32).replace(/[^\w-]/g, '') || `f${i + 1}`, name: clean(r.name, 40) || `目录${i + 1}`, path: clean(r.path, 400).trim(),
})).filter((r) => r.path);

/**
 * store.workers: id -> { id, name, url, token, secretHash, approved, prefs, roots(shared folders w/ paths),
 *   caps, bench, version, lastSeen, from, active, transcode }
 * store.workerSelect: 'auto' | workerId
 */
export function createWorkers({ store, persist, log }) {
  store.workers ||= {};
  store.workerSelect ||= 'auto';
  const pairCodes = new Map(); // code -> expires
  const benchRequests = new Set();
  const busy = {}; // id -> active jobs dispatched by this hub (hint for ranking)

  const all = () => Object.values(store.workers).map((w) => ({ ...w, online: !!w.lastSeen && Date.now() - w.lastSeen < ONLINE_MS }));
  const get = (id) => { const w = store.workers[id]; if (!w) throw httpErr(404, '没有这个 worker'); return w; };
  const withOnline = (w) => ({ ...w, online: !!w.lastSeen && Date.now() - w.lastSeen < ONLINE_MS });

  function newPairCode() {
    const now = Date.now();
    for (const [c, exp] of pairCodes) if (exp < now) pairCodes.delete(c);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    pairCodes.set(code, now + 15 * 60e3);
    return { code, expiresAt: now + 15 * 60e3 };
  }

  function pair(body, from) {
    const code = clean(body.code, 12).toUpperCase();
    const exp = pairCodes.get(code);
    if (!exp || exp < Date.now()) throw httpErr(403, '配对码无效或已过期，请在网页上重新生成');
    pairCodes.delete(code);
    const id = clean(body.id, 64).replace(/[^a-z0-9-]/gi, '') || crypto.randomBytes(4).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    const prev = store.workers[id];
    store.workers[id] = {
      ...(prev || {}), id, name: clean(body.name) || id, secretHash: sha(secret),
      approved: true, // a valid one-time code typed by the owner is the approval
      prefs: { ...DEFAULT_PREFS, ...(prev?.prefs || {}) }, roots: prev?.roots || [],
      pairedAt: Date.now(), from,
    };
    persist();
    log(`worker paired: ${id} (${store.workers[id].name}) from ${from}`);
    return { secret, id };
  }

  function auth(req, id) {
    const w = store.workers[id];
    const secret = req.headers['x-worker-secret'];
    if (!w || !secret || sha(secret) !== w.secretHash) throw httpErr(401, '未配对或密钥错误');
    return w;
  }

  function heartbeat(req, body) {
    const w = auth(req, clean(body.id, 64));
    const url = clean(body.url, 200);
    if (!/^http:\/\/[\w.-]+:\d{1,5}$/.test(url)) throw httpErr(400, 'bad url');
    Object.assign(w, {
      name: w.renamed ? w.name : clean(body.name) || w.name, url, token: clean(body.token, 64), version: clean(body.version, 16),
      transcode: !!body.transcode, caps: body.caps || {}, active: Number(body.active) || 0,
      bench: body.bench && (!w.bench || (body.bench.at || 0) >= (w.bench.at || 0)) ? body.bench : w.bench || null,
      lastSeen: Date.now(), from: req.socket.remoteAddress, reachable: w.reachable,
    });
    // Shared folders: the worker's local config seeds the list until someone edits it on the hub.
    if (!w.rootsSet && Array.isArray(body.roots) && body.roots.every((r) => r.path)) w.roots = sanitizeRoots(body.roots);
    persist();
    const bench = benchRequests.delete(w.id);
    return { approved: w.approved, prefs: w.prefs, roots: w.roots || [], bench, hubVersion: VERSION };
  }

  /** Health: can the hub actually reach the worker's advertised URL? (catches firewall/wrong NIC) */
  async function probeReachable() {
    await Promise.all(all().filter((w) => w.online && w.url).map(async (w) => {
      try {
        const r = await fetch(`${w.url}/api/ping`, { headers: { 'X-Cast-Token': w.token }, signal: AbortSignal.timeout(4000) });
        store.workers[w.id].reachable = r.ok;
        if (r.ok) store.workers[w.id].active = (await r.json()).active ?? store.workers[w.id].active;
      } catch { store.workers[w.id].reachable = false; }
    }));
  }
  setInterval(() => probeReachable().catch(() => {}), 30e3).unref();
  setTimeout(() => probeReachable().catch(() => {}), 5000).unref();

  function view(w) {
    const x = withOnline(w);
    return {
      id: x.id, name: x.name, online: x.online, reachable: x.reachable !== false, approved: !!x.approved, url: x.url,
      version: x.version, outdated: !!x.version && x.version !== VERSION, lastSeen: x.lastSeen, active: x.active || 0,
      transcode: !!x.transcode, usable: workerUsable(x), caps: x.caps || {}, bench: x.bench || null,
      prefs: x.prefs, roots: x.roots || [], selected: store.workerSelect === x.id,
    };
  }

  function update(id, patch) {
    const w = get(id);
    if (patch.name !== undefined) { w.name = clean(patch.name) || w.name; w.renamed = true; }
    if (patch.approved !== undefined) w.approved = !!patch.approved;
    if (patch.prefs) {
      const p = patch.prefs; const cur = w.prefs || { ...DEFAULT_PREFS };
      if (p.enabled !== undefined) cur.enabled = !!p.enabled;
      if (['auto', 'nvenc', 'qsv', 'amf', 'cpu'].includes(p.encoder)) cur.encoder = p.encoder;
      if (['auto', 'h264', 'hevc10'].includes(p.codec)) cur.codec = p.codec;
      if (['fast', 'high', 'max'].includes(p.quality)) cur.quality = p.quality;
      if ([720, 1080, 1440, 2160].includes(Number(p.maxHeight))) cur.maxHeight = Number(p.maxHeight);
      if (Number(p.maxJobs) >= 1 && Number(p.maxJobs) <= 8) cur.maxJobs = Math.floor(Number(p.maxJobs));
      w.prefs = cur;
    }
    if (patch.roots) { w.roots = sanitizeRoots(patch.roots); w.rootsSet = true; }
    persist();
    return view(w);
  }

  function remove(id) {
    get(id);
    delete store.workers[id];
    if (store.workerSelect === id) store.workerSelect = 'auto';
    persist();
  }

  function select(id) {
    if (id !== 'auto') get(id);
    store.workerSelect = id; persist();
  }

  /** Worker for a job; notes why (manual / fallback / auto). */
  function pick(sourceWorkerId = null) {
    const r = rankWorkers(all(), { preferId: store.workerSelect, sourceId: sourceWorkerId, busy });
    return r;
  }

  return {
    all, get, view, list: () => all().map(view).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)),
    newPairCode, pair, heartbeat, update, remove, select, pick, busy,
    requestBench: (id) => { get(id); benchRequests.add(id); },
    selected: () => store.workerSelect,
  };
}
