const $ = (s) => document.querySelector(s);
const ui = {
  device: $('#device'), scan: $('#scan'), source: $('#source'), search: $('#search'), crumbs: $('#crumbs'), list: $('#list'),
  recent: $('#recent'), bar: $('#bar'), cur: $('#cur'), dur: $('#dur'), bubble: $('#bubble'), toggle: $('#toggle'),
  vol: $('#vol'), volv: $('#volv'), mute: $('#mute'), mode: $('#mode'), title: $('#np-title'), sub: $('#np-sub'), toast: $('#toast'),
};
const S = {
  device: localStorage.getItem('device') || '', source: localStorage.getItem('source') || '', path: localStorage.getItem('path') || '',
  state: null, dragging: false, volDragging: false, seekLockUntil: 0, searchSeq: 0,
};

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `请求失败 (${r.status})`);
  return data;
}
let toastTimer;
function toast(msg, err = false) {
  ui.toast.textContent = msg; ui.toast.classList.toggle('err', err); ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), err ? 5000 : 2200);
}
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(x).padStart(2, '0');
};
const parseTime = (t) => {
  t = String(t).trim(); if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t) * 60; // bare number = minutes
  return t.split(':').reduce((a, p) => a * 60 + Number(p), 0);
};
const sizeFmt = (b) => (b > 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${Math.round(b / (1 << 20))} MB`);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// ---------------- devices ----------------
function renderDevices(data) {
  const prev = S.device || data.lastDevice || '';
  ui.device.innerHTML = '';
  if (!data.devices.length) { ui.device.append(new Option('未发现设备，点 ⟳ 搜索', '')); return; }
  for (const d of data.devices) ui.device.append(new Option(`${d.online ? '' : '（离线）'}${d.name} · ${d.ip}`, d.id));
  const pick = data.devices.find((d) => d.id === prev) || data.devices.find((d) => d.online) || data.devices[0];
  ui.device.value = pick.id; S.device = pick.id; localStorage.setItem('device', S.device);
}
async function loadDevices() { renderDevices(await api('GET', '/api/devices')); }
ui.scan.onclick = async () => {
  ui.scan.classList.add('spin'); ui.scan.disabled = true;
  try { const d = await api('POST', '/api/devices/scan'); renderDevices(d); toast(`找到 ${d.devices.filter((x) => x.online).length} 台在线设备`); }
  catch (e) { toast(e.message, true); }
  finally { ui.scan.classList.remove('spin'); ui.scan.disabled = false; }
};
ui.device.onchange = () => { S.device = ui.device.value; localStorage.setItem('device', S.device); poll(); };

// ---------------- sources & browsing ----------------
async function loadSources() {
  const list = await api('GET', '/api/sources');
  ui.source.innerHTML = '';
  for (const s of list) ui.source.append(new Option(`${s.online ? '' : '（离线）'}${s.name}`, s.id));
  if (!list.find((s) => s.id === S.source)) { S.source = list[0]?.id || ''; S.path = ''; }
  ui.source.value = S.source;
}
ui.source.onchange = () => { S.source = ui.source.value; S.path = ''; ui.search.value = ''; save(); browse(); };
function save() { localStorage.setItem('source', S.source); localStorage.setItem('path', S.path); }

function renderCrumbs() {
  ui.crumbs.innerHTML = '';
  const parts = S.path ? S.path.split('/') : [];
  const root = el('a', '', '根目录'); root.onclick = () => { S.path = ''; save(); browse(); }; ui.crumbs.append(root);
  parts.forEach((p, i) => {
    ui.crumbs.append(el('span', '', '›'));
    const a = el('a', '', p); a.onclick = () => { S.path = parts.slice(0, i + 1).join('/'); save(); browse(); }; ui.crumbs.append(a);
  });
}
function historyFor(path) { return S.historyMap?.[`${S.source}|${path}`]; }
function fileRow(name, path, extra) {
  const li = el('li');
  li.append(el('span', 'ic', '🎬'));
  const nm = el('div', 'nm'); nm.append(el('div', '', name));
  const h = historyFor(path);
  if (h && h.duration) { const p = el('div', 'prog'); const i = el('i'); i.style.width = `${h.finished ? 100 : Math.min(100, (h.position / h.duration) * 100)}%`; p.append(i); nm.append(p); }
  li.append(nm);
  li.append(el('span', 'meta', h ? (h.finished ? '已看完' : `看到 ${fmt(h.position)}`) : (extra || '')));
  if (S.state?.item && S.state.item.source === S.source && S.state.item.path === path) li.classList.add('playing');
  li.onclick = () => play({ source: S.source, path });
  return li;
}
async function browse() {
  renderCrumbs();
  ui.list.innerHTML = '<li class="empty">加载中…</li>';
  try {
    const [data, hist] = await Promise.all([api('GET', `/api/list?source=${encodeURIComponent(S.source)}&path=${encodeURIComponent(S.path)}`), api('GET', '/api/history')]);
    S.historyMap = Object.fromEntries(hist.map((h) => [`${h.source}|${h.path}`, h]));
    ui.list.innerHTML = '';
    if (S.path) {
      const up = el('li'); up.append(el('span', 'ic', '↩'), el('div', 'nm', '上一级'));
      up.onclick = () => { S.path = S.path.split('/').slice(0, -1).join('/'); save(); browse(); }; ui.list.append(up);
    }
    for (const d of data.dirs) {
      const li = el('li'); li.append(el('span', 'ic', '📁'), el('div', 'nm', d.name));
      li.onclick = () => { S.path = S.path ? `${S.path}/${d.name}` : d.name; save(); browse(); }; ui.list.append(li);
    }
    for (const f of data.files) ui.list.append(fileRow(f.name, S.path ? `${S.path}/${f.name}` : f.name, sizeFmt(f.size)));
    if (!data.dirs.length && !data.files.length) ui.list.append(el('li', 'empty', '这个文件夹里没有视频'));
  } catch (e) { ui.list.innerHTML = ''; ui.list.append(el('li', 'empty', e.message)); }
}
let searchTimer;
ui.search.oninput = () => {
  clearTimeout(searchTimer);
  const q = ui.search.value.trim();
  if (!q) return browse();
  searchTimer = setTimeout(async () => {
    const seq = ++S.searchSeq;
    ui.list.innerHTML = '<li class="empty">搜索中…</li>';
    try {
      const { results } = await api('GET', `/api/search?source=${encodeURIComponent(S.source)}&q=${encodeURIComponent(q)}`);
      if (seq !== S.searchSeq) return;
      ui.list.innerHTML = '';
      for (const r of results) {
        if (r.type === 'dir') {
          const li = el('li'); li.append(el('span', 'ic', '📁'), el('div', 'nm', r.path));
          li.onclick = () => { S.path = r.path; ui.search.value = ''; save(); browse(); }; ui.list.append(li);
        } else ui.list.append(fileRow(r.path, r.path));
      }
      if (!results.length) ui.list.append(el('li', 'empty', '没有找到'));
    } catch (e) { ui.list.innerHTML = ''; ui.list.append(el('li', 'empty', e.message)); }
  }, 350);
};

// ---------------- tabs ----------------
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'recent') loadRecent();
  };
});
async function loadRecent() {
  ui.recent.innerHTML = '';
  const hist = await api('GET', '/api/history');
  if (!hist.length) { ui.recent.append(el('li', 'empty', '还没有播放记录')); return; }
  for (const h of hist) {
    const li = el('li'); li.append(el('span', 'ic', h.source === 'url' ? '🔗' : '🎬'));
    const nm = el('div', 'nm'); nm.append(el('div', '', h.title));
    if (h.duration) { const p = el('div', 'prog'); const i = el('i'); i.style.width = `${h.finished ? 100 : Math.min(100, (h.position / h.duration) * 100)}%`; p.append(i); nm.append(p); }
    li.append(nm, el('span', 'meta', h.finished ? '已看完' : `继续 ${fmt(h.position)}`));
    li.onclick = () => play(h.source === 'url' ? { url: h.path, title: h.title } : { source: h.source, path: h.path });
    ui.recent.append(li);
  }
}
$('#urlform').onsubmit = (e) => { e.preventDefault(); play({ url: $('#url').value.trim(), title: $('#urltitle').value.trim() || undefined }); };

// ---------------- playback ----------------
async function play(item) {
  if (!S.device) return toast('请先选择播放设备', true);
  toast('正在投放…');
  try { render(await api('POST', '/api/play', { device: S.device, mode: ui.mode.value, ...item })); toast('已开始投放'); }
  catch (e) { toast(e.message, true); }
}
async function control(action, value) {
  if (!S.device) return;
  try { render(await api('POST', '/api/control', { device: S.device, action, value })); }
  catch (e) { toast(e.message, true); }
}
document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => control(b.dataset.act); });
document.querySelectorAll('[data-rel]').forEach((b) => {
  b.onclick = () => {
    if (!S.state?.item) return;
    const t = Math.max(0, Math.min((S.state.duration || 1e9) - 5, (S.state.position || 0) + Number(b.dataset.rel)));
    optimisticSeek(t); control('seek', t);
  };
});
$('#jump').onclick = () => {
  if (!S.state?.item) return toast('当前没有在播放', true);
  const v = prompt('跳到哪里？例如 12:30、1:02:00，或只写分钟数 12', fmt(S.state.position));
  if (v === null) return;
  const t = parseTime(v);
  if (!Number.isFinite(t)) return toast('时间格式不对', true);
  optimisticSeek(t); control('seek', t);
};
ui.mode.onchange = () => { if (S.state?.item) control('mode', ui.mode.value); };

// Seek bar: drag shows a preview bubble; release commits once.
function setBar(pos, dur) {
  ui.bar.max = Math.max(1, Math.floor(dur || 0));
  ui.bar.value = Math.floor(pos || 0);
  ui.bar.style.setProperty('--p', `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`);
  ui.cur.textContent = fmt(pos); ui.dur.textContent = fmt(dur);
}
function optimisticSeek(t) { S.seekLockUntil = Date.now() + 4000; if (S.state) S.state.position = t; setBar(t, S.state?.duration); }
function showBubble() {
  const max = Number(ui.bar.max) || 1; const v = Number(ui.bar.value);
  const r = ui.bar.getBoundingClientRect(); const pr = ui.bar.parentElement.getBoundingClientRect();
  ui.bubble.style.left = `${r.left - pr.left + 10 + (r.width - 20) * (v / max)}px`;
  ui.bubble.textContent = fmt(v); ui.bubble.classList.remove('hidden');
  ui.cur.textContent = fmt(v); ui.bar.style.setProperty('--p', `${(v / max) * 100}%`);
}
ui.bar.addEventListener('input', () => { S.dragging = true; showBubble(); });
ui.bar.addEventListener('change', () => {
  S.dragging = false; ui.bubble.classList.add('hidden');
  const t = Number(ui.bar.value); optimisticSeek(t); control('seek', t);
});
ui.bar.addEventListener('pointerup', () => { ui.bubble.classList.add('hidden'); });

ui.vol.addEventListener('input', () => { S.volDragging = true; ui.volv.textContent = ui.vol.value; });
ui.vol.addEventListener('change', () => { S.volDragging = false; control('volume', Number(ui.vol.value)); });
ui.mute.onclick = () => control('mute', !S.state?.mute);

// Keyboard: space toggle, ←/→ 10s, ↑/↓ volume.
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text],input[type=url],input[type=search],select')) return;
  if (e.code === 'Space') { e.preventDefault(); control('toggle'); }
  else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (!S.state?.item) return; e.preventDefault();
    const t = Math.max(0, (S.state.position || 0) + (e.code === 'ArrowLeft' ? -10 : 10)); optimisticSeek(t); control('seek', t);
  } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    if (S.state?.volume == null) return; e.preventDefault();
    control('volume', Math.max(0, Math.min(100, S.state.volume + (e.code === 'ArrowUp' ? 5 : -5))));
  }
});

const STATUS = { idle: '空闲', loading: '加载中…', playing: '播放中', paused: '已暂停', stopped: '已停止', error: '出错' };
const MODE = { direct: '直连', remux: '重新封装', audio: '音频转码', video: '视频转码' };
function render(st) {
  const prevKey = S.state?.item ? `${S.state.item.source}|${S.state.item.path}` : '';
  S.state = st;
  const it = st.item;
  ui.title.textContent = it ? it.title : '未在播放';
  ui.sub.innerHTML = '';
  if (st.device) {
    const bits = [`${st.device.name}`, STATUS[st.status] || st.status];
    if (it) bits.push(MODE[st.mode] || st.mode);
    if (it?.video) bits.push(`${it.video.codec}${it.video.height ? ` ${it.video.height}p` : ''}`);
    ui.sub.append(document.createTextNode(bits.join(' · ')));
    if (st.error) ui.sub.append(el('span', 'err', ` · ${st.error}`));
    else if (st.note) ui.sub.append(document.createTextNode(` · ${st.note}`));
  }
  ui.toggle.textContent = st.status === 'playing' ? '❚❚' : '▶';
  ui.bar.disabled = !it || !st.duration;
  if (!S.dragging && Date.now() > S.seekLockUntil) setBar(st.position, st.duration);
  if (!S.volDragging && st.volume != null) { ui.vol.value = st.volume; ui.volv.textContent = st.volume; }
  ui.mute.textContent = st.mute ? '🔇' : '🔈';
  if (it && st.requestedMode) ui.mode.value = st.requestedMode;
  const key = it ? `${it.source}|${it.path}` : '';
  if (key !== prevKey) document.querySelectorAll('.list li').forEach((li) => li.classList.remove('playing'));
  document.title = it && st.status === 'playing' ? `▶ ${it.title}` : '投屏中心';
}
async function poll() {
  if (!S.device) return;
  try { render(await api('GET', `/api/state?device=${encodeURIComponent(S.device)}`)); } catch { /* transient */ }
}

// Smooth the clock locally between polls.
setInterval(() => {
  const st = S.state;
  if (!st || st.status !== 'playing' || S.dragging || Date.now() < S.seekLockUntil) return;
  st.position = Math.min(st.duration || Infinity, (st.position || 0) + 1);
  setBar(st.position, st.duration);
}, 1000);
setInterval(() => { if (!document.hidden) poll(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

(async () => {
  try { await Promise.all([loadDevices(), loadSources()]); } catch (e) { toast(e.message, true); }
  ui.source.value = S.source;
  browse(); poll();
})();
