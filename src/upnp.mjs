// UPnP/DLNA: SSDP discovery + AVTransport/RenderingControl SOAP. No dependencies.
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { hms } from './lib.mjs';

export const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
export const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

export const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function tag(xml, name) {
  const m = String(xml).match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1].trim() : '';
}

/** Parse a UPnP device description into {name, manufacturer, model, udn, avtransport, rendering}. */
export function parseDescription(xml, location) {
  const base = tag(xml, 'URLBase') || location;
  const services = {};
  for (const m of String(xml).matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/g)) {
    const type = tag(m[1], 'serviceType').replace(/:\d+$/, '');
    const ctl = tag(m[1], 'controlURL');
    if (type && ctl && !services[type]) services[type] = new URL(ctl, base).href;
  }
  return {
    name: xmlUnesc(tag(xml, 'friendlyName')) || new URL(location).hostname,
    manufacturer: xmlUnesc(tag(xml, 'manufacturer')),
    model: xmlUnesc(tag(xml, 'modelName')),
    udn: tag(xml, 'UDN'),
    avtransport: services['urn:schemas-upnp-org:service:AVTransport'] || null,
    rendering: services['urn:schemas-upnp-org:service:RenderingControl'] || null,
  };
}

/** DIDL-Lite metadata. Some renderers refuse an empty CurrentURIMetaData. */
export function didl({ title, url, mime }) {
  const protocolInfo = `http-get:*:${mime}:*`;
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + `<item id="0" parentID="-1" restricted="1"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class>`
    + `<res protocolInfo="${xmlEsc(protocolInfo)}">${xmlEsc(url)}</res></item></DIDL-Lite>`;
}

function request(url, { method = 'GET', headers = {}, body, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    // agent:false + Connection: close. Cheap renderers (Hivendor STB) silently drop keep-alive sockets,
    // so a pooled socket fails every other call with "socket hang up". Timer is manual for the same reason.
    const timer = setTimeout(() => req.destroy(new Error(`超时: ${method} ${url}`)), timeout);
    const req = http.request(url, { method, headers: { Connection: 'close', ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

export async function soap(controlUrl, service, action, args = '', timeout = 10000) {
  if (!controlUrl) throw new Error(`设备不支持 ${service.split(':')[3]}`);
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(controlUrl, { method: 'POST', body, timeout, headers: {
        'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"`, 'Content-Length': Buffer.byteLength(body) } });
      if (res.status >= 400) {
        const code = tag(res.body, 'errorCode'); const desc = tag(res.body, 'errorDescription');
        const e = new Error(`${action} 失败: HTTP ${res.status}${code ? ` 错误码 ${code}` : ''}${desc ? ` ${desc}` : ''}`);
        e.upnpCode = code; throw e;
      }
      return res.body;
    } catch (e) {
      last = e;
      if (e.upnpCode !== undefined) throw e; // real UPnP fault: don't retry
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw last;
}

/** LAN IPv4 interfaces worth multicasting on (skip docker/bridges/VPN). */
export function lanInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|tailscale|utun|zt|wg|virbr|lo)/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(a.address)) continue; // CGNAT (Tailscale), link-local
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const ip2n = (ip) => ip.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
export function localIpFor(target, ifaces = lanInterfaces()) {
  const t = ip2n(target);
  const hit = ifaces.find((a) => ((ip2n(a.address) & ip2n(a.netmask)) >>> 0) === ((t & ip2n(a.netmask)) >>> 0));
  return hit ? hit.address : (ifaces[0]?.address || '127.0.0.1');
}

export async function discover(timeoutMs = 3500) {
  const msg = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1', '', ''].join('\r\n'));
  const locations = new Set();
  await Promise.all(lanInterfaces().map((a) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { s.close(); } catch { /* closed */ } resolve(); };
    s.on('error', done);
    s.on('message', (buf) => { const m = buf.toString().match(/^location:\s*(.+)$/im); if (m) locations.add(m[1].trim()); });
    s.bind(0, a.address, () => {
      try { s.setMulticastInterface(a.address); } catch { /* best effort */ }
      const send = () => s.send(msg, 1900, '239.255.255.250', () => {});
      send(); setTimeout(send, 400); setTimeout(send, 1200);
      setTimeout(done, timeoutMs);
    });
  })));
  const devices = await Promise.all([...locations].map(async (location) => {
    try {
      const { body } = await request(location, { timeout: 4000 });
      const d = parseDescription(body, location);
      if (!d.avtransport) return null;
      const ip = new URL(location).hostname;
      return { id: d.udn || location, ip, location, ...d };
    } catch { return null; }
  }));
  const seen = new Map();
  for (const d of devices) if (d && !seen.has(d.id)) seen.set(d.id, d);
  return [...seen.values()];
}

/** Thin per-device controller. */
export class Renderer {
  constructor(dev) { this.dev = dev; }
  avt(action, args, timeout) { return soap(this.dev.avtransport, AVT, action, args, timeout); }
  rc(action, args) { return soap(this.dev.rendering, RC, action, args); }

  async load(url, { title = 'video', mime = 'video/mp4' } = {}) {
    try { await this.avt('Stop'); } catch { /* idle renderers may fault */ }
    try {
      await this.avt('SetAVTransportURI', `<CurrentURI>${xmlEsc(url)}</CurrentURI><CurrentURIMetaData>${xmlEsc(didl({ title, url, mime }))}</CurrentURIMetaData>`);
    } catch (e) {
      // Some renderers choke on DIDL; retry bare.
      await this.avt('SetAVTransportURI', `<CurrentURI>${xmlEsc(url)}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
    }
    await this.avt('Play', '<Speed>1</Speed>');
  }
  play() { return this.avt('Play', '<Speed>1</Speed>'); }
  pause() { return this.avt('Pause'); }
  stop() { return this.avt('Stop'); }
  seek(sec) { return this.avt('Seek', `<Unit>REL_TIME</Unit><Target>${hms(sec)}</Target>`, 15000); }
  async state() {
    const [ti, pi] = await Promise.all([this.avt('GetTransportInfo', '', 6000), this.avt('GetPositionInfo', '', 6000)]);
    return {
      transport: tag(ti, 'CurrentTransportState'),
      status: tag(ti, 'CurrentTransportStatus'),
      relTime: tag(pi, 'RelTime'),
      duration: tag(pi, 'TrackDuration'),
      uri: xmlUnesc(tag(pi, 'TrackURI')),
    };
  }
  async getVolume() { return Number(tag(await this.rc('GetVolume', '<Channel>Master</Channel>'), 'CurrentVolume')); }
  setVolume(v) { return this.rc('SetVolume', `<Channel>Master</Channel><DesiredVolume>${Math.max(0, Math.min(100, Math.round(v)))}</DesiredVolume>`); }
  async getMute() { return tag(await this.rc('GetMute', '<Channel>Master</Channel>'), 'CurrentMute') === '1'; }
  setMute(on) { return this.rc('SetMute', `<Channel>Master</Channel><DesiredMute>${on ? 1 : 0}</DesiredMute>`); }
}
