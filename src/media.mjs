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
  const subs = json.streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({ index: s.index, codec: s.codec_name, lang: s.tags?.language || '', title: s.tags?.title || '' }));
  const duration = Number(json.format?.duration) || Number(v?.duration) || 0;
  return {
    duration,
    format: json.format?.format_name || '',
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, pixFmt: v.pix_fmt, profile: v.profile } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels } : null,
    subtitles: subs,
  };
}

/** ffmpeg argv for a streaming MPEG-TS output starting at `offset` seconds. Runs on the PC agent, never on the Pi. */
export function buildFfmpegArgs({ input, offset = 0, mode = 'video', encoder = 'libx264', maxHeight = 1080, headers }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (/^https?:/i.test(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (headers) args.push('-headers', headers);
  }
  if (offset > 0) args.push('-ss', String(Math.floor(offset)));
  args.push('-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  const scale = (fmt) => ['-vf', `scale=-2:'min(${maxHeight},ih)',format=${fmt}`];
  if (mode === 'remux' || mode === 'audio') {
    args.push('-c:v', 'copy');
  } else if (encoder === 'h264_nvenc') {
    args.push(...scale('yuv420p'), '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M', '-g', '50');
  } else if (encoder === 'h264_amf') {
    args.push(...scale('yuv420p'), '-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M', '-g', '50');
  } else if (encoder === 'h264_qsv') {
    args.push(...scale('nv12'), '-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M', '-g', '50');
  } else {
    args.push('-vf', `scale=-2:'min(${maxHeight},ih)',format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '23', '-maxrate', '5M', '-bufsize', '10M', '-profile:v', 'high', '-level', '4.1', '-g', '50');
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

/** First H.264 encoder that actually encodes a test clip (listed != working, e.g. no GPU driver). */
export async function detectEncoder(candidates = ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
  for (const enc of candidates) {
    const fmt = enc === 'h264_qsv' ? 'nv12' : 'yuv420p';
    const { err } = await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
      '-t', '1', '-vf', `format=${fmt}`, '-c:v', enc, '-b:v', '2M', '-f', 'null', '-'], 20000);
    if (!err) return enc;
  }
  return 'libx264';
}

export function spawnFfmpeg(args) {
  return spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export const isUrlPath = (p) => /^https?:\/\//i.test(String(p));
export const extForInput = (p) => (isUrlPath(p) ? extOf(new URL(p).pathname) : extOf(p));
