// Minimal ZIP writer (store only, no compression — photos are already compressed).
let table = null;
function crc32(buf, crc = 0) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  crc = ~crc;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** entries: [{name, data: string | Blob | Uint8Array, date?: Date}] → Promise<Blob> */
export async function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data)
      : e.data instanceof Uint8Array ? e.data : new Uint8Array(await e.data.arrayBuffer());
    const name = enc.encode(e.name);
    const d = e.date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(data);
    const common = (view, o) => {
      view.setUint16(o, 20, true); // version needed
      view.setUint16(o + 2, 0x0800, true); // UTF-8 names
      view.setUint16(o + 4, 0, true); // stored
      view.setUint16(o + 6, time, true);
      view.setUint16(o + 8, date, true);
      view.setUint32(o + 10, crc, true);
      view.setUint32(o + 14, data.length, true);
      view.setUint32(o + 18, data.length, true);
      view.setUint16(o + 22, name.length, true);
      view.setUint16(o + 24, 0, true);
    };
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    common(lh, 4);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    common(ch, 6);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
