// "Worker" tab: list/configure transcode workers, pair new ones, choose which one transcodes.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const FAMILY = { auto: '自动（优先显卡）', nvenc: 'NVIDIA 显卡 (NVENC)', qsv: 'Intel 核显 (QSV)', amf: 'AMD 显卡 (AMF)', cpu: 'CPU (x264/x265)' };
const CODEC = { auto: '自动（片源是 HEVC 就用 HEVC 10bit）', h264: 'H.264（兼容性最好）', hevc10: 'HEVC 10bit（更清晰）' };
const QUALITY = { fast: '省电 / 快', high: '高画质（推荐）', max: '最高画质' };
const HEIGHT = { 720: '720p', 1080: '1080p', 1440: '1440p', 2160: '4K（保留原分辨率）' };
const REASON = { manual: '你指定的', fallback: '指定的不可用，临时改用', auto: '自动选择', none: '' };

let api; let toast; let data = null; let editing = null; let pairTimer = null;

export function initWorkers(deps) {
  ({ api, toast } = deps);
  $('#wk-select').onchange = async () => {
    try { const r = await api('POST', '/api/workers/select', { id: $('#wk-select').value }); data.select = r.select; data.pick = r.pick; renderHead(); toast('已切换，下次转码生效'); offerRestream(); }
    catch (e) { toast(e.message, true); }
  };
  $('#wk-add').onclick = startPair;
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const text = $(`#${b.dataset.copy}`).textContent;
      try { await navigator.clipboard.writeText(text); toast('已复制'); }
      catch { const r = document.createRange(); r.selectNodeContents($(`#${b.dataset.copy}`)); getSelection().removeAllRanges(); getSelection().addRange(r); toast('已选中，按 Ctrl+C 复制'); }
    };
  });
}

/** Restart the current stream on the newly selected worker if one is transcoding now. */
async function offerRestream() {
  const st = deps().state();
  if (!st?.item || !st.worker) return;
  if (confirm(`当前这集正在由「${st.worker.name}」转码，要立刻换到新选择的 worker 吗？（会从当前进度重新加载）`)) deps().control('restream');
}
let depsRef = null;
const deps = () => depsRef;
export function setPlayerDeps(d) { depsRef = d; }

export async function loadWorkers() {
  try { data = await api('GET', '/api/workers'); } catch (e) { toast(e.message, true); return; }
  if (editing) return renderHead(); // don't clobber a form being edited
  render();
}

function renderHead() {
  const sel = $('#wk-select');
  sel.innerHTML = '';
  sel.append(new Option('自动', 'auto'));
  for (const w of data.workers.filter((x) => x.approved)) sel.append(new Option(`${w.name}${w.usable ? '' : '（不可用）'}`, w.id));
  sel.value = data.select;
  const p = data.pick;
  $('#wk-pick').textContent = p?.id ? `→ ${REASON[p.reason] || ''} ${p.name}` : '没有可用的 worker：需要转码/字幕时会改为直连';
}

function badge(text, cls = '') { return el('span', `badge ${cls}`, text); }
const ago = (t) => { if (!t) return '从未'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`; };

function render() {
  renderHead();
  const list = $('#wk-list');
  list.innerHTML = '';
  if (!data.workers.length) { list.append(el('p', 'dim', '还没有 worker。点「＋ 添加 worker」，在另一台电脑上运行生成的命令。')); return; }
  for (const w of data.workers) list.append(card(w));
}

function familiesText(caps) {
  const f = caps?.families || {};
  const parts = Object.entries(f).map(([k, v]) => `${FAMILY[k]?.replace(/ \(.*\)/, '') || k}${v.hevc10 ? ' · HEVC10' : ''}`);
  return parts.length ? parts.join('、') : '无（没有 ffmpeg）';
}

function card(w) {
  const box = el('div', `wk${w.prefs?.enabled === false ? ' off' : ''}`);
  const top = el('div', 'wk-top');
  top.append(el('span', 'wk-name', w.name));
  top.append(w.online ? (w.reachable ? badge('在线', 'ok') : badge('在线但连不上', 'bad')) : badge(`离线 · ${ago(w.lastSeen)}`, 'bad'));
  if (!w.approved) top.append(badge('待批准', 'warn'));
  if (w.prefs?.enabled === false) top.append(badge('已停用', 'warn'));
  if (w.outdated) top.append(badge(`版本旧 v${w.version}`, 'warn'));
  if (w.active) top.append(badge(`${w.active} 个任务进行中`, 'sel'));
  if (data.pick?.id === w.id) top.append(badge('当前转码用这台', 'sel'));
  box.append(top);

  const c = w.caps || {};
  const meta = [
    c.gpus?.length ? `显卡：${c.gpus.join(' / ')}` : null,
    `可用编码器：${familiesText(c)}`,
    c.cpus ? `${c.platform} · ${c.cpus} 线程 · ${c.memGB} GB` : null,
    c.libass === false && w.transcode ? '⚠ ffmpeg 不支持字幕烧录 (libass)' : null,
    w.bench?.speed ? `测速：${w.bench.speed}× 实时（${w.bench.encoder}，${QUALITY[w.bench.quality] || ''}）` : w.bench?.error ? `测速失败：${w.bench.error}` : null,
    w.online && !w.reachable ? `投屏中心访问不到 ${w.url}：检查这台电脑的防火墙是否放行 TCP 端口` : null,
  ].filter(Boolean);
  for (const m of meta) box.append(el('div', 'wk-meta', m));

  const p = { ...w.prefs };
  const grid = el('div', 'wk-grid');
  const fams = ['auto', ...Object.keys(c.families || {})];
  grid.append(field('编码器', select(fams, FAMILY, p.encoder, (v) => { p.encoder = v; })));
  grid.append(field('输出格式', select(['auto', 'h264', 'hevc10'], CODEC, p.codec, (v) => { p.codec = v; })));
  grid.append(field('画质', select(['fast', 'high', 'max'], QUALITY, p.quality, (v) => { p.quality = v; })));
  grid.append(field('最高分辨率', select(['720', '1080', '1440', '2160'], HEIGHT, String(p.maxHeight), (v) => { p.maxHeight = Number(v); })));
  grid.append(field('同时任务数', select(['1', '2', '3', '4'], { 1: '1', 2: '2', 3: '3', 4: '4' }, String(p.maxJobs), (v) => { p.maxJobs = Number(v); })));
  const en = el('label', 'switch'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = p.enabled !== false;
  cb.onchange = () => { p.enabled = cb.checked; }; en.append(cb, document.createTextNode('参与转码'));
  grid.append(field('状态', en));
  box.append(grid);

  // Shared folders on that machine
  const roots = (w.roots || []).map((r) => ({ ...r }));
  const rootsBox = el('div', 'wk-roots');
  rootsBox.append(el('div', 'dim', '共享给投屏中心浏览的文件夹（这台机器上的路径）'));
  const rows = el('div');
  const drawRoots = () => {
    rows.innerHTML = '';
    roots.forEach((r, i) => {
      const row = el('div', 'root');
      const n = el('input'); n.placeholder = '显示名'; n.value = r.name || ''; n.oninput = () => { r.name = n.value; edit(); };
      const pth = el('input'); pth.placeholder = '例如 D:/Videos 或 /home/me/Videos'; pth.value = r.path || ''; pth.oninput = () => { r.path = pth.value; edit(); };
      const del = el('button', '', '删除'); del.onclick = () => { roots.splice(i, 1); edit(); drawRoots(); };
      row.append(n, pth, del); rows.append(row);
    });
  };
  drawRoots();
  const addRoot = el('button', '', '＋ 文件夹'); addRoot.onclick = () => { roots.push({ name: '', path: '' }); edit(); drawRoots(); };
  rootsBox.append(rows, addRoot);
  box.append(rootsBox);

  const actions = el('div', 'wk-actions');
  const save = el('button', 'primary', '保存设置');
  save.onclick = async () => {
    try {
      await api('POST', '/api/workers/update', { id: w.id, prefs: p, roots, approved: true });
      editing = null; toast('已保存，worker 会在 30 秒内应用'); loadWorkers();
    } catch (e) { toast(e.message, true); }
  };
  const rename = el('button', '', '改名');
  rename.onclick = async () => { const n = prompt('新名字', w.name); if (!n) return; try { await api('POST', '/api/workers/update', { id: w.id, name: n }); loadWorkers(); } catch (e) { toast(e.message, true); } };
  const bench = el('button', '', '测速');
  bench.disabled = !w.online || !w.transcode;
  bench.onclick = async () => {
    bench.disabled = true; bench.textContent = '测速中…';
    try { const r = await api('POST', '/api/workers/bench', { id: w.id }); toast(`${w.name}：${r.speed}× 实时（${r.encoder}）`); loadWorkers(); }
    catch (e) { toast(e.message, true); bench.disabled = false; bench.textContent = '测速'; }
  };
  const use = el('button', '', data.select === w.id ? '✓ 已指定' : '指定用这台');
  use.disabled = data.select === w.id || !w.approved;
  use.onclick = async () => { $('#wk-select').value = w.id; $('#wk-select').onchange(); };
  const rm = el('button', 'danger', '移除');
  rm.onclick = async () => {
    if (!confirm(`移除「${w.name}」？那台机器上的 worker 会被拒绝，想再加入需要新的配对码。`)) return;
    try { await api('POST', '/api/workers/remove', { id: w.id }); loadWorkers(); } catch (e) { toast(e.message, true); }
  };
  actions.append(save, use, bench, rename, rm);
  box.append(actions);
  box.addEventListener('change', edit, true);
  return box;

  function edit() { editing = w.id; }
}

function field(label, control) { const l = el('label'); l.append(document.createTextNode(label), control); return l; }
function select(values, labels, value, onChange) {
  const s = el('select');
  for (const v of values) s.append(new Option(labels[v] || v, v));
  s.value = values.includes(value) ? value : values[0];
  s.onchange = () => onChange(s.value);
  return s;
}

async function startPair() {
  try {
    const { code, expiresAt } = await api('POST', '/api/workers/paircode');
    const hub = location.origin;
    $('#wk-code').textContent = code;
    $('#wk-cmd-win').textContent = `irm "${hub}/install/worker.ps1?code=${code}" | iex`;
    $('#wk-cmd-sh').textContent = `curl -fsSL "${hub}/install/worker.sh?code=${code}" | sh`;
    $('#wk-pair').classList.remove('hidden');
    clearInterval(pairTimer);
    const before = new Set(data.workers.map((w) => `${w.id}:${w.lastSeen}`));
    const tickExp = () => {
      const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      $('#wk-exp').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (!s) { clearInterval(pairTimer); $('#wk-pair').classList.add('hidden'); }
    };
    tickExp();
    pairTimer = setInterval(async () => {
      tickExp();
      await loadWorkers();
      const fresh = data.workers.find((w) => !before.has(`${w.id}:${w.lastSeen}`) && w.online && Date.now() - (w.lastSeen || 0) < 40e3 && !before.has(`${w.id}:undefined`));
      if (fresh && !before.has(`${fresh.id}:${fresh.lastSeen}`) && [...before].every((k) => !k.startsWith(`${fresh.id}:`))) {
        clearInterval(pairTimer); $('#wk-pair').classList.add('hidden'); toast(`「${fresh.name}」已加入`);
      }
    }, 3000);
  } catch (e) { toast(e.message, true); }
}
