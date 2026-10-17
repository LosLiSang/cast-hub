import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normRel, safeJoin, toSec, hms, parseRange, siblingPath, estimatePosition, classifyStop, seekTarget, isMedia, subLabel, findSidecars, embeddedTracks, pickDefaultSub, rankWorkers, workerUsable, hubUrlFromHost, renderTemplate } from '../src/lib.mjs';
import { chooseMode, fallbackMode, summarizeProbe, buildFfmpegArgs, videoFilter, subOutput, encoderArgs, pickEncoder, encoderLabel } from '../src/media.mjs';
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
  const u = buildFfmpegArgs({ input: 'http://pi:8790/m/x/a.mkv', mode: 'video', enc: { family: 'nvenc', codec: 'h264', quality: 'high' } });
  assert.ok(u.includes('-reconnect')); assert.ok(u.includes('h264_nvenc'));
  assert.equal(u[u.indexOf('-rc') + 1], 'vbr'); assert.equal(u[u.indexOf('-cq') + 1], '19'); assert.equal(u[u.indexOf('-b:v') + 1], '0');
  assert.ok(u[u.indexOf('-vf') + 1].includes('min(1080,ih)'));
  const h = buildFfmpegArgs({ input: '/a.mkv', mode: 'video', maxHeight: 2160, enc: { family: 'nvenc', codec: 'hevc10', quality: 'max' } });
  assert.equal(h[h.indexOf('-c:v') + 1], 'hevc_nvenc'); assert.equal(h[h.indexOf('-profile:v') + 1], 'main10');
  assert.ok(h[h.indexOf('-vf') + 1].endsWith('format=p010le')); assert.equal(h[h.indexOf('-cq') + 1], '16');
  assert.ok(h[h.indexOf('-vf') + 1].includes('min(2160,ih)'));
});

test('encoderArgs: every family/codec/quality yields a named encoder and pixel format', () => {
  const want = { nvenc: ['h264_nvenc', 'hevc_nvenc'], qsv: ['h264_qsv', 'hevc_qsv'], amf: ['h264_amf', 'hevc_amf'], cpu: ['libx264', 'libx265'] };
  for (const [fam, [h264, hevc]] of Object.entries(want)) {
    for (const q of ['fast', 'high', 'max']) {
      const a = encoderArgs(fam, 'h264', q); const b = encoderArgs(fam, 'hevc10', q);
      assert.equal(a.name, h264); assert.equal(b.name, hevc);
      assert.ok(!/10/.test(a.fmt), `${fam} h264 is 8-bit`); assert.ok(/10|p010/.test(b.fmt), `${fam} hevc is 10-bit`);
      assert.ok(a.args.every((x) => typeof x === 'string'));
    }
  }
  assert.equal(encoderArgs('qsv', 'h264').fmt, 'nv12');
  assert.ok(!encoderArgs('amf', 'hevc10').args.includes('-qp_b'), 'hevc_amf has no B-frame qp');
  // quality ladder tightens
  const cq = (q) => Number(encoderArgs('nvenc', 'h264', q).args[encoderArgs('nvenc', 'h264', q).args.indexOf('-cq') + 1]);
  assert.ok(cq('fast') > cq('high') && cq('high') > cq('max'));
  assert.equal(encoderArgs('bogus', 'h264').name, 'libx264');
});

test('pickEncoder', () => {
  const pc = { nvenc: { h264: true, hevc10: true }, cpu: { h264: true, hevc10: true } };
  const cases = [
    [{ families: pc, sourceCodec: 'hevc' }, { family: 'nvenc', codec: 'hevc10' }],
    [{ families: pc, sourceCodec: 'h264' }, { family: 'nvenc', codec: 'h264' }],
    [{ families: pc, sourceCodec: 'hevc', safe: true }, { family: 'nvenc', codec: 'h264' }],
    [{ families: pc, pref: 'cpu', sourceCodec: 'hevc' }, { family: 'cpu', codec: 'h264' }], // x265 too slow for auto
    [{ families: pc, pref: 'cpu', codec: 'hevc10' }, { family: 'cpu', codec: 'hevc10' }],
    [{ families: pc, pref: 'qsv' }, { family: 'nvenc', codec: 'h264', prefMissed: true }],
    [{ families: { qsv: { h264: true } }, codec: 'hevc10' }, { family: 'qsv', codec: 'h264' }], // no HEVC on this GPU
    [{ families: { cpu: { h264: true } }, codec: 'auto', sourceCodec: 'hevc' }, { family: 'cpu', codec: 'h264' }],
  ];
  for (const [inp, want] of cases) {
    const got = pickEncoder(inp);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${JSON.stringify(inp)} ${k}`);
  }
  assert.equal(pickEncoder({ families: {} }), null);
  assert.equal(encoderLabel({ family: 'nvenc', codec: 'hevc10' }), 'NVIDIA NVENC HEVC 10bit');
});

test('rankWorkers / workerUsable', () => {
  const w = (id, o = {}) => ({ id, approved: true, online: true, reachable: true, transcode: true, prefs: { enabled: true }, lastSeen: 100, caps: { families: { cpu: { h264: true } } }, ...o });
  const gpu = { caps: { families: { nvenc: { h264: true } } } };
  const usable = [
    [w('a'), true], [w('a', { approved: false }), false], [w('a', { online: false }), false], [w('a', { reachable: false }), false],
    [w('a', { transcode: false }), false], [w('a', { prefs: { enabled: false } }), false], [null, false],
  ];
  for (const [x, want] of usable) assert.equal(workerUsable(x), want, JSON.stringify(x));

  const cpu = w('cpu', { lastSeen: 300 }); const nv = w('nv', gpu); const nv2 = w('nv2', { ...gpu, lastSeen: 50 });
  assert.equal(rankWorkers([cpu, nv]).worker.id, 'nv', 'hardware first');
  assert.equal(rankWorkers([nv, nv2], { busy: { nv: 1 } }).worker.id, 'nv2', 'less busy');
  assert.equal(rankWorkers([nv, nv2], { sourceId: 'nv2' }).worker.id, 'nv2', 'has the file');
  assert.equal(rankWorkers([nv, nv2]).worker.id, 'nv', 'most recent');
  assert.deepEqual([rankWorkers([cpu, nv], { preferId: 'cpu' }).worker.id, rankWorkers([cpu, nv], { preferId: 'cpu' }).reason], ['cpu', 'manual']);
  const off = w('cpu', { online: false });
  assert.deepEqual([rankWorkers([off, nv], { preferId: 'cpu' }).worker.id, rankWorkers([off, nv], { preferId: 'cpu' }).reason], ['nv', 'fallback']);
  assert.deepEqual(rankWorkers([off]), { worker: null, reason: 'none' });
});

test('hubUrlFromHost / renderTemplate', () => {
  for (const [h, want] of [['192.168.1.8:8790', 'http://192.168.1.8:8790'], ['raspb.local', 'http://raspb.local'], ['[fd7a::1]:8790', 'http://[fd7a::1]:8790'],
    ['evil.com;rm -rf /', 'F'], ['a b', 'F'], ['', 'F'], ["x'$(id)", 'F']]) assert.equal(hubUrlFromHost(h, 'F'), want, h);
  assert.equal(renderTemplate("$Hub='__HUB__'; $C='__CODE__'; __NOPE__", { HUB: 'http://h:1', CODE: 'ABC234' }), "$Hub='http://h:1'; $C='ABC234'; __NOPE__");
});

test('subLabel', () => {
  const cases = [
    [['zh-Hans'], '简体中文'], [['chs'], '简体中文'], [['sc'], '简体中文'], [['简体中文', 'chi'], '简体中文'],
    [['zh-Hant'], '繁體中文'], [['cht'], '繁體中文'], [['繁體中文', 'chi'], '繁體中文'],
    [['', 'chi'], '中文'], [['', 'jpn'], '日文'], [['English', 'eng'], 'English'], [['Signs', ''], 'Signs'], [['', ''], '字幕'],
    [['jpsc'], '简体中文'], [['jptc'], '繁體中文'],
  ];
  for (const [hints, want] of cases) assert.equal(subLabel(...hints), want, hints.join('/'));
});

test('findSidecars', () => {
  const v = '[LoliHouse] BanG Dream! YUME∞MITA S01E01.mkv';
  const names = [
    '[LoliHouse] BanG Dream! YUME∞MITA S01E01.zh-Hant.ass', '[LoliHouse] BanG Dream! YUME∞MITA S01E01.zh-Hans.ass',
    '[LoliHouse] BanG Dream! YUME∞MITA S01E02.zh-Hans.ass', '[LoliHouse] BanG Dream! YUME∞MITA S01E01.srt',
    '[LoliHouse] BanG Dream! YUME∞MITA S01E010.ass', 'readme.txt',
  ];
  const got = findSidecars(v, names);
  assert.deepEqual(got.map((s) => [s.name.replace(/.*S01E/, ''), s.label, s.codec]), [
    ['01.srt', '外挂字幕', 'srt'], ['01.zh-Hans.ass', '简体中文', 'ass'], ['01.zh-Hant.ass', '繁體中文', 'ass'],
  ]);
  assert.equal(got[1].id, `ext:${names[1]}`);
});

test('embeddedTracks + pickDefaultSub', () => {
  const probe = { subtitles: [
    { n: 0, codec: 'ass', title: '繁體中文', lang: 'chi' }, { n: 1, codec: 'ass', title: '简体中文', lang: 'chi' },
    { n: 2, codec: 'hdmv_pgs_subtitle', title: '', lang: 'jpn' }, { n: 3, codec: 'eia_608', title: '', lang: '' },
  ] };
  const emb = embeddedTracks(probe);
  assert.deepEqual(emb.map((t) => [t.id, t.label, t.image]), [['emb:0', '繁體中文', false], ['emb:1', '简体中文', false], ['emb:2', '日文', true]]);
  assert.equal(pickDefaultSub(emb).id, 'emb:1');
  assert.equal(pickDefaultSub(emb, '繁體中文').id, 'emb:0');
  const ext = [{ id: 'ext:a', kind: 'external', label: '简体中文' }];
  assert.equal(pickDefaultSub([...emb, ...ext]).id, 'ext:a');
  assert.equal(pickDefaultSub([{ id: 'emb:2', label: '日文', image: true }, { id: 'emb:5', label: 'Signs', image: false }]).id, 'emb:5');
  assert.equal(pickDefaultSub([]), null);
  assert.deepEqual(embeddedTracks(null), []);
});

test('videoFilter / subOutput', () => {
  assert.equal(videoFilter({ maxHeight: 720 }).vf, "scale=-2:'min(720,ih)',format=yuv420p");
  assert.equal(videoFilter({ subtitle: { file: 'sub.ass', fontsDir: 'fonts' } }).vf, "subtitles=filename=sub.ass:fontsdir=fonts,scale=-2:'min(1080,ih)',format=yuv420p");
  assert.equal(videoFilter({ offset: 300.7, subtitle: { file: 'sub.ass' } }).vf, "setpts=PTS+300/TB,subtitles=filename=sub.ass,setpts=PTS-STARTPTS,scale=-2:'min(1080,ih)',format=yuv420p");
  assert.equal(videoFilter({ subtitle: { overlay: 2 } }).complex, "[0:v:0][0:s:2]overlay=(W-w)/2:H-h,scale=-2:'min(1080,ih)',format=yuv420p[v]");
  assert.equal(videoFilter({ subtitle: { file: "C:/a b/it's.ass" } }).vf.split(',')[0], "subtitles=filename=C\\:/a b/it\\'s.ass");
  assert.deepEqual(subOutput('ass'), ['.ass', 'copy']); assert.deepEqual(subOutput('subrip'), ['.srt', 'copy']); assert.deepEqual(subOutput('mov_text'), ['.srt', 'srt']);
  const burn = buildFfmpegArgs({ input: '/a.mkv', offset: 60, subtitle: { overlay: 1 } });
  assert.equal(burn[burn.indexOf('-map') + 1], '[v]'); assert.ok(burn.includes('-filter_complex'));
  const remux = buildFfmpegArgs({ input: '/a.mkv', mode: 'remux', subtitle: { file: 'x.ass' } });
  assert.ok(!remux.includes('-vf'), 'no subtitle filter on stream copy');
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
