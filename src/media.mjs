// Media decisions (pure) + ffprobe/ffmpeg process helpers.
import { spawn, execFile } from 'node:child_process';
import { extOf } from './lib.mjs';

// What the "auto" mode assumes a generic DLNA TV/STB can decode natively.
// Verified on the Hivendor 移动高清机顶盒: H.264/AAC mp4 and HEVC 10-bit/AAC mkv both play direct.
export const DIRECT = {
  video: new Set(['h264', 'hevc', 'mpeg4', 'mpeg2video']),
  audio: new Set(['aac', 'mp3', 'mp2', 'ac3']),
  ext: new Set(['.mp4', '.m4v', '.mkv', '.mov', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.webm']),
};

/**
 * Modes:
 *  direct – renderer pulls the original file (Range, renderer-side seek)
 *  remux  – ffmpeg -c copy into MPEG-TS (cheap; used when the renderer can't seek or dislikes the container)
 *  audio  – copy video, transcode audio to AAC (cheap; EAC3/DTS/FLAC/TrueHD/Opus)
 *  video  – full transcode to H.264/AAC (expensive on a Pi)
 */
export function chooseMode(probe, { ext = '', isUrl = false } = {}) {
  if (!probe) return { mode: 'direct', reason: '无法探测格式，先直连尝试' };
  const v = probe.video?.codec; const a = probe.audio?.codec;
  if (!v && !a) return { mode: 'direct', reason: '无法识别流，先直连尝试' };
  if (v && !DIRECT.video.has(v)) return { mode: 'video', reason: `视频编码 ${v} 设备通常不支持` };
  const audioOk = !a || DIRECT.audio.has(a);
  const containerOk = isUrl || DIRECT.ext.has(String(ext).toLowerCase());
  if (!audioOk) return { mode: 'audio', reason: `音频编码 ${a} 需转成 AAC` };
  if (!containerOk) return { mode: 'remux', reason: `容器 ${ext} 需重新封装` };
  return { mode: 'direct', reason: '格式兼容，直连播放' };
}

/** Next mode to try when the renderer refuses the current one. null = give up. */
export function fallbackMode(mode, probe) {
  if (mode === 'direct') return probe?.audio && !DIRECT.audio.has(probe.audio.codec) ? 'audio' : 'video';
  if (mode === 'remux' || mode === 'audio') return 'video';
  return null;
}

/** Map ffprobe JSON to {duration, video:{codec,width,height,pixFmt}, audio:{codec,channels}, format}. */
export function summarizeProbe(json) {
  if (!json || !Array.isArray(json.streams)) return null;
  const v = json.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = json.streams.find((s) => s.codec_type === 'audio');
  const subs = json.streams.filter((s) => s.codec_type === 'subtitle').map((s, n) => ({ index: s.index, n, codec: s.codec_name, lang: s.tags?.language || '', title: s.tags?.title || '' }));
  const attachments = json.streams.filter((s) => s.codec_type === 'attachment' && /font|ttf|otf/i.test(`${s.codec_name} ${s.tags?.mimetype || ''} ${s.tags?.filename || ''}`))
    .map((s) => ({ index: s.index, filename: s.tags?.filename || '', ext: (/(\.(ttf|otf|ttc|otc))$/i.exec(s.tags?.filename || '')?.[1] || `.${s.codec_name === 'otf' ? 'otf' : 'ttf'}`).toLowerCase() }));
  const duration = Number(json.format?.duration) || Number(v?.duration) || 0;
  return {
    duration,
    format: json.format?.format_name || '',
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, pixFmt: v.pix_fmt, profile: v.profile } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels } : null,
    subtitles: subs,
    attachments,
  };
}

/** Escape a value for use inside an ffmpeg filtergraph option. We pass bare relative names, so this is defensive. */
const fq = (s) => String(s).replace(/\\/g, '/').replace(/([:'\[\],;])/g, '\\$1');

/**
 * Video filter chain. Subtitles are burned in before scaling so libass renders at source resolution.
 * After an input seek (-ss before -i) frame timestamps restart at 0; shift them back so subtitle
 * timing lines up, then reset for the output.
 */
export function videoFilter({ offset = 0, maxHeight = 1080, fmt = 'yuv420p', subtitle } = {}) {
  const scale = `scale=-2:'min(${maxHeight},ih)',format=${fmt}`;
  if (subtitle?.file) {
    const sub = `subtitles=filename=${fq(subtitle.file)}${subtitle.fontsDir ? `:fontsdir=${fq(subtitle.fontsDir)}` : ''}`;
    const chain = offset > 0 ? `setpts=PTS+${Math.floor(offset)}/TB,${sub},setpts=PTS-STARTPTS` : sub;
    return { vf: `${chain},${scale}` };
  }
  if (subtitle?.overlay !== undefined) {
    return { complex: `[0:v:0][0:s:${Number(subtitle.overlay)}]overlay=(W-w)/2:H-h,${scale}[v]` };
  }
  return { vf: scale };
}

// ---------------- encoders ----------------
export const FAMILIES = ['nvenc', 'qsv', 'amf', 'cpu'];
export const QUALITIES = ['fast', 'high', 'max'];
const qi = (q) => Math.max(0, QUALITIES.indexOf(q) === -1 ? 1 : QUALITIES.indexOf(q));

/**
 * Encoder arguments for a family/codec/quality. Quality-targeted (constant quality + generous VBV ceiling):
 * fixed low bitrates visibly smear anime line art.
 * Returns { name, fmt (pixel format fed to the encoder), args }.
 */
export function encoderArgs(family, codec = 'h264', quality = 'high') {
  const q = qi(quality); const hevc = codec === 'hevc10';
  const vbv = ['-maxrate', '30M', '-bufsize', '60M'];
  switch (family) {
    case 'nvenc': return {
      name: hevc ? 'hevc_nvenc' : 'h264_nvenc', fmt: hevc ? 'p010le' : 'yuv420p',
      args: ['-preset', ['p4', 'p6', 'p7'][q], '-tune', 'hq', '-rc', 'vbr', '-cq', String([24, 19, 16][q]), '-b:v', '0', ...vbv,
        '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3', '-g', '120', '-profile:v', hevc ? 'main10' : 'high'],
    };
    case 'qsv': return {
      name: hevc ? 'hevc_qsv' : 'h264_qsv', fmt: hevc ? 'p010le' : 'nv12',
      args: ['-preset', ['veryfast', 'medium', 'slow'][q], '-global_quality', String([25, 21, 18][q]), ...vbv, '-g', '120', '-profile:v', hevc ? 'main10' : 'high'],
    };
    case 'amf': {
      const qp = String([24, 20, 17][q]);
      return {
        name: hevc ? 'hevc_amf' : 'h264_amf', fmt: hevc ? 'p010le' : 'yuv420p',
        args: ['-quality', ['speed', 'balanced', 'quality'][q], '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(hevc ? [] : ['-qp_b', qp]),
          '-g', '120', '-profile:v', hevc ? 'main10' : 'high'],
      };
    }
    default: return hevc
      ? { name: 'libx265', fmt: 'yuv420p10le', args: ['-preset', ['ultrafast', 'superfast', 'veryfast'][q], '-crf', String([26, 22, 20][q]), ...vbv, '-profile:v', 'main10', '-x265-params', 'log-level=error', '-g', '120'] }
      : { name: 'libx264', fmt: 'yuv420p', args: ['-preset', ['veryfast', 'faster', 'fast'][q], '-crf', String([23, 19, 17][q]), ...vbv, '-profile:v', 'high', '-g', '120'] };
  }
}

/**
 * Resolve which encoder a worker uses for a job.
 * pref: 'auto' | family. codec: 'auto' | 'h264' | 'hevc10'. safe: force H.264 (renderer refused the source).
 * 'auto' codec = HEVC 10-bit when the source is HEVC (the renderer evidently decodes it), except on CPU where
 * libx265 is too slow for real time.
 */
export function pickEncoder({ families = {}, pref = 'auto', codec = 'auto', sourceCodec, safe = false } = {}) {
  const ok = FAMILIES.filter((f) => families[f]?.h264);
  if (!ok.length) return null;
  const family = pref !== 'auto' && ok.includes(pref) ? pref : ok[0];
  let want = safe ? 'h264' : codec === 'auto' ? (sourceCodec === 'hevc' && family !== 'cpu' ? 'hevc10' : 'h264') : codec;
  if (want === 'hevc10' && !families[family].hevc10) want = 'h264';
  return { family, codec: want, prefMissed: pref !== 'auto' && family !== pref };
}

export const ENCODER_LABEL = { nvenc: 'NVIDIA NVENC', qsv: 'Intel QSV', amf: 'AMD AMF', cpu: 'CPU' };
export const encoderLabel = (e) => (e ? `${ENCODER_LABEL[e.family] || e.family} ${e.codec === 'hevc10' ? 'HEVC 10bit' : 'H.264'}` : '');

/** ffmpeg argv for a streaming MPEG-TS output starting at `offset` seconds. Runs on a worker, never on the Pi. */
export function buildFfmpegArgs({ input, offset = 0, mode = 'video', enc = { family: 'cpu', codec: 'h264', quality: 'high' }, maxHeight = 1080, headers, subtitle }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (/^https?:/i.test(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (headers) args.push('-headers', headers);
  }
  if (offset > 0) args.push('-ss', String(Math.floor(offset)));
  args.push('-i', input);
  const burn = mode === 'video' && subtitle && (subtitle.file || subtitle.overlay !== undefined);
  const scale = (fmt) => {
    const f = videoFilter({ offset, maxHeight, fmt, subtitle: burn ? subtitle : undefined });
    return f.complex ? ['-filter_complex', f.complex] : ['-vf', f.vf];
  };
  const complex = burn && subtitle.overlay !== undefined;
  args.push('-map', complex ? '[v]' : '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  if (mode === 'remux' || mode === 'audio') {
    args.push('-c:v', 'copy');
  } else {
    const e = encoderArgs(enc.family, enc.codec, enc.quality);
    args.push(...scale(e.fmt), '-c:v', e.name, ...e.args);
  }
  if (mode === 'remux') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  args.push('-f', 'mpegts', '-muxdelay', '0', 'pipe:1');
  return args;
}

// Binary paths; the agent may override (e.g. C:/Users/x/bin/ffmpeg.exe).
export const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

export async function hasBinary(cmd) {
  const { err } = await run(bins[cmd] || cmd, ['-version'], 5000);
  return !err;
}

/** Header-only probe (no frame decoding), cheap enough for the Pi. */
export async function ffprobe(input, timeoutMs = 20000) {
  const { err, stdout } = await run(bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], timeoutMs);
  if (err) return null;
  try { return summarizeProbe(JSON.parse(stdout)); } catch { return null; }
}

/** Which family/codec combinations really encode on this machine (listed != working, e.g. no GPU driver). */
export async function detectEncoders() {
  const families = {};
  for (const fam of FAMILIES) {
    for (const codec of ['h264', 'hevc10']) {
      const e = encoderArgs(fam, codec, 'fast');
      const { err } = await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
        '-t', '1', '-vf', `format=${e.fmt}`, '-c:v', e.name, ...e.args, '-f', 'null', '-'], 30000);
      if (!err) (families[fam] ||= {})[codec] = true;
      if (err && codec === 'h264') break; // no H.264 -> family unusable, skip HEVC probe
    }
  }
  const { stdout } = await run(bins.ffmpeg, ['-hide_banner', '-filters'], 10000);
  return { families, libass: /\ssubtitles\s/.test(String(stdout)) };
}

/**
 * Encode speed test on 20 s of noisy 1080p (hard to compress, like real footage; a clean test pattern makes
 * CPU encoders look unrealistically fast). The source is pre-rendered so only encoding is timed.
 * Returns realtime multiple (2.0 = twice real time).
 */
export async function benchEncoder(family, codec, quality = 'high') {
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const src = path.join(os.tmpdir(), 'cast-bench-src.nut');
  if (!fs.existsSync(src)) {
    const { err } = await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24',
      '-t', '20', '-vf', 'noise=alls=18:allf=t+u,format=yuv420p', '-c:v', 'rawvideo', src], 180000);
    if (err) throw new Error('无法生成测速素材');
  }
  const e = encoderArgs(family, codec, quality);
  const t = Date.now();
  const { err, stderr } = await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src,
    '-vf', `format=${e.fmt}`, '-c:v', e.name, ...e.args, '-f', 'null', '-'], 300000);
  if (err) throw new Error(String(stderr).trim().split('\n').pop() || err.message);
  const sec = (Date.now() - t) / 1000;
  return { speed: Math.round((20 / sec) * 10) / 10, seconds: Math.round(sec * 10) / 10, encoder: e.name };
}

/** Best-effort list of GPU names for display. */
export async function gpuNames() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], 15000);
      return String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/virtual|idd|remote|basic display/i.test(s));
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('system_profiler', ['SPDisplaysDataType'], 15000);
      return [...String(stdout).matchAll(/Chipset Model:\s*(.+)/g)].map((m) => m[1].trim());
    }
    const { stdout } = await run('lspci', [], 10000);
    return String(stdout).split('\n').filter((l) => /VGA|3D controller/i.test(l)).map((l) => l.replace(/^.*?:\s*/, '').replace(/^.*?:\s*/, '').trim());
  } catch { return []; }
}

export function spawnFfmpeg(args, { cwd } = {}) {
  return spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd });
}

/** Subtitle codec -> [file extension, ffmpeg -c:s]. mov_text/webvtt become srt/vtt text that libass reads. */
export function subOutput(codec) {
  if (codec === 'ass' || codec === 'ssa') return ['.ass', 'copy'];
  if (codec === 'webvtt') return ['.vtt', 'copy'];
  if (codec === 'subrip' || codec === 'srt') return ['.srt', 'copy'];
  return ['.srt', 'srt'];
}

/** Demux one text subtitle stream (no video decoding). */
export async function extractSubtitle(input, n, codec, outFile, timeoutMs = 15 * 60e3) {
  const [, c] = subOutput(codec);
  const { err, stderr } = await run(bins.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-map', `0:s:${n}`, '-c:s', c, outFile], timeoutMs);
  if (err) throw new Error(`提取字幕失败：${String(stderr).trim().split('\n').pop() || err.message}`);
  return outFile;
}

/** Dump embedded font attachments to `dir` as a<index><ext> (original names can be "unsafe" for ffmpeg). */
export async function dumpFonts(input, attachments, dir) {
  if (!attachments?.length) return [];
  const args = ['-nostdin', '-loglevel', 'error', '-y'];
  const names = attachments.map((a) => `a${a.index}${a.ext}`);
  attachments.forEach((a, i) => args.push(`-dump_attachment:${a.index}`, `${dir}/${names[i]}`));
  args.push('-i', input);
  await run(bins.ffmpeg, args, 120000); // exits non-zero ("no output") after dumping; that's expected
  const fs = await import('node:fs');
  return names.filter((n) => fs.existsSync(`${dir}/${n}`));
}

export const isUrlPath = (p) => /^https?:\/\//i.test(String(p));
export const extForInput = (p) => (isUrlPath(p) ? extOf(new URL(p).pathname) : extOf(p));
