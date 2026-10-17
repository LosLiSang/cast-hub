import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normRel, safeJoin, toSec, hms, parseRange, siblingPath, estimatePosition, classifyStop, seekTarget, isMedia } from '../src/lib.mjs';
import { chooseMode, fallbackMode, summarizeProbe, buildFfmpegArgs } from '../src/media.mjs';
import { parseDescription, tag, didl, localIpFor } from '../src/upnp.mjs';

test('normRel', () => {
  for (const [i, o] of [['', ''], ['/a/b/', 'a/b'], ['a\\b\\c', 'a/b/c'], ['./a//./b', 'a/b'], ['番剧/BanG Dream! YUME∞MITA', '番剧/BanG Dream! YUME∞MITA']]) assert.equal(normRel(i), o);
});

test('safeJoin blocks traversal', () => {
  const root = path.resolve('/srv/media');
  assert.equal(safeJoin(root, 'a/b.mkv'), path.join(root, 'a', 'b.mkv'));
  assert.equal(safeJoin(root, ''), root);
  for (const bad of ['../etc/passwd', 'a/../../x', '..']) assert.throws(() => safeJoin(root, bad), /非法路径/);
});

test('toSec / hms', () => {
  for (const [i, o] of [['00:23:40', 1420], ['1:02', 62], ['90', 90], ['NOT_IMPLEMENTED', 0], ['', 0], [undefined, 0], ['0:00:01.500', 1.5]]) assert.equal(toSec(i), o);
  for (const [i, o] of [[0, '00:00:00'], [61.9, '00:01:01'], [3725, '01:02:05'], [-5, '00:00:00']]) assert.equal(hms(i), o);
});

test('parseRange', () => {
  const cases = [
    [undefined, 1000, { start: 0, end: 999, partial: false }],
    ['bytes=0-', 1000, { start: 0, end: 999, partial: true }],
    ['bytes=100-199', 1000, { start: 100, end: 199, partial: true }],
    ['bytes=900-5000', 1000, { start: 900, end: 999, partial: true }],
    ['bytes=-100', 1000, { start: 900, end: 999, partial: true }],
    ['bytes=1000-', 1000, null],
    ['bytes=500-100', 1000, null],
  ];
  for (const [h, size, want] of cases) assert.deepEqual(parseRange(h, size), want, h);
});

test('siblingPath', () => {
  const names = ['E01.mkv', 'E02.mkv', 'E03.mkv'];
  assert.equal(siblingPath('show/S1/E02.mkv', names, 1), 'show/S1/E03.mkv');
  assert.equal(siblingPath('show/S1/E02.mkv', names, -1), 'show/S1/E01.mkv');
  assert.equal(siblingPath('E01.mkv', names, -1), null);
  assert.equal(siblingPath('show/S1/E03.mkv', names, 1), null);
  assert.equal(siblingPath('E01.mkv', names, 1), 'E02.mkv');
  assert.equal(siblingPath('show/X.mkv', names, 1), null);
});

test('estimatePosition', () => {
  const cases = [
    [{ mode: 'direct', relTime: 120, offset: 999, playedMs: 5000 }, 120],
    [{ mode: 'video', offset: 600, relTime: 15, playedMs: 99000 }, 615],
    [{ mode: 'video', offset: 600, relTime: 0, playedMs: 12000 }, 612], // renderer reports 0 for live TS
    [{ mode: 'remux', offset: 1400, relTime: 50, duration: 1420 }, 1420], // clamped
    [{ mode: 'direct', relTime: 0 }, 0],
  ];
  for (const [i, o] of cases) assert.equal(estimatePosition(i), o, JSON.stringify(i));
});

test('classifyStop', () => {
  assert.equal(classifyStop({ everPlayed: false, position: 0, duration: 1420 }), 'failed');
  assert.equal(classifyStop({ everPlayed: true, position: 1410, duration: 1420 }), 'ended');
  assert.equal(classifyStop({ everPlayed: true, position: 300, duration: 1420 }), 'stopped');
  assert.equal(classifyStop({ everPlayed: true, position: 300, duration: 0 }), 'stopped');
});

test('seekTarget', () => {
  assert.equal(seekTarget({ value: 100, duration: 1420 }), 100);
  assert.equal(seekTarget({ value: -50 }), 0);
  assert.equal(seekTarget({ value: 99999, duration: 1420 }), 1415);
  assert.equal(seekTarget({ value: 30, relative: true, current: 100, duration: 1420 }), 130);
  assert.equal(seekTarget({ value: -30, relative: true, current: 10 }), 0);
  assert.equal(seekTarget({ value: 12.9 }), 12);
  assert.throws(() => seekTarget({ value: 'abc' }), /无效/);
});

test('chooseMode', () => {
  const p = (v, a) => ({ video: v && { codec: v }, audio: a && { codec: a } });
  const cases = [
    [p('h264', 'aac'), '.mp4', 'direct'],
    [p('hevc', 'aac'), '.mkv', 'direct'],
    [p('hevc', 'eac3'), '.mkv', 'audio'],
    [p('h264', 'dts'), '.mkv', 'audio'],
    [p('h264', 'aac'), '.flv', 'remux'],
    [p('h264', 'aac'), '.avi', 'remux'],
    [p('av1', 'opus'), '.mkv', 'video'],
    [p('vp9', 'opus'), '.webm', 'video'],
    [p('rv40', 'cook'), '.rmvb', 'video'],
    [p('wmv3', 'wmav2'), '.wmv', 'video'],
    [null, '.mkv', 'direct'],
  ];
  for (const [probe, ext, want] of cases) assert.equal(chooseMode(probe, { ext }).mode, want, `${JSON.stringify(probe)} ${ext}`);
  assert.equal(chooseMode(p('h264', 'aac'), { ext: '', isUrl: true }).mode, 'direct');
});

test('fallbackMode', () => {
  assert.equal(fallbackMode('direct', { audio: { codec: 'aac' } }), 'video');
  assert.equal(fallbackMode('direct', { audio: { codec: 'eac3' } }), 'audio');
  assert.equal(fallbackMode('audio', {}), 'video');
  assert.equal(fallbackMode('remux', {}), 'video');
  assert.equal(fallbackMode('video', {}), null);
});

test('summarizeProbe skips cover art and reads duration', () => {
  const s = summarizeProbe({
    format: { duration: '1420.016', format_name: 'matroska,webm' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, pix_fmt: 'yuv420p10le' },
      { codec_type: 'audio', codec_name: 'aac', channels: 2 },
      { codec_type: 'subtitle', codec_name: 'ass', index: 3, tags: { language: 'chi' } },
    ],
  });
  assert.equal(s.video.codec, 'hevc'); assert.equal(s.audio.codec, 'aac'); assert.equal(Math.round(s.duration), 1420); assert.equal(s.subtitles.length, 1);
  assert.equal(summarizeProbe({}), null);
});

test('buildFfmpegArgs', () => {
  const v = buildFfmpegArgs({ input: '/a.mkv', offset: 600, mode: 'video' });
  assert.deepEqual(v.slice(v.indexOf('-ss'), v.indexOf('-ss') + 4), ['-ss', '600', '-i', '/a.mkv']);
  assert.ok(v.includes('libx264')); assert.equal(v.at(-1), 'pipe:1'); assert.ok(v.includes('mpegts'));
  const r = buildFfmpegArgs({ input: '/a.flv', mode: 'remux' });
  assert.ok(!r.includes('-ss')); assert.equal(r[r.indexOf('-c:v') + 1], 'copy'); assert.equal(r[r.indexOf('-c:a') + 1], 'copy');
  const a = buildFfmpegArgs({ input: '/a.mkv', mode: 'audio' });
  assert.equal(a[a.indexOf('-c:v') + 1], 'copy'); assert.equal(a[a.indexOf('-c:a') + 1], 'aac');
  const u = buildFfmpegArgs({ input: 'http://pi:8790/m/x/a.mkv', mode: 'video', encoder: 'h264_nvenc' });
  assert.ok(u.includes('-reconnect')); assert.ok(u.includes('h264_nvenc'));
  assert.ok(u[u.indexOf('-vf') + 1].includes('min(1080,ih)'));
  const q = buildFfmpegArgs({ input: '/a.mkv', mode: 'video', encoder: 'h264_qsv' });
  assert.ok(q[q.indexOf('-vf') + 1].endsWith('format=nv12'));
  const amf = buildFfmpegArgs({ input: '/a.mkv', mode: 'video', encoder: 'h264_amf' });
  assert.ok(amf.includes('h264_amf'));
});

test('parseDescription (Hivendor STB)', () => {
  const xml = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><friendlyName>移动高清机顶盒</friendlyName>
  <manufacturer>Hivendor Technologies Co.,Ltd</manufacturer><modelName>Hivendor MediaRenderer</modelName><UDN>uuid:bb5e21ce</UDN>
  <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/service/AVTransport/Control</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>upnp/service/RenderingControl/Control</controlURL></service></serviceList></device></root>`;
  const d = parseDescription(xml, 'http://192.168.1.11:55826/description.xml');
  assert.equal(d.name, '移动高清机顶盒'); assert.equal(d.udn, 'uuid:bb5e21ce');
  assert.equal(d.avtransport, 'http://192.168.1.11:55826/upnp/service/AVTransport/Control');
  assert.equal(d.rendering, 'http://192.168.1.11:55826/upnp/service/RenderingControl/Control');
});

test('tag / didl / isMedia / localIpFor', () => {
  assert.equal(tag('<s:Body><u:X><CurrentTransportState>PLAYING</CurrentTransportState></u:X></s:Body>', 'CurrentTransportState'), 'PLAYING');
  assert.match(didl({ title: 'A & B', url: 'http://h/x?a=1&b=2', mime: 'video/mp4' }), /A &amp; B.*a=1&amp;b=2/);
  for (const [f, o] of [['a.MKV', true], ['b.mp4', true], ['c.srt', false], ['d', false]]) assert.equal(isMedia(f), o, f);
  const ifs = [{ address: '192.168.1.8', netmask: '255.255.255.0' }, { address: '10.0.0.2', netmask: '255.0.0.0' }];
  assert.equal(localIpFor('192.168.1.11', ifs), '192.168.1.8');
  assert.equal(localIpFor('10.9.9.9', ifs), '10.0.0.2');
});
