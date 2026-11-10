// A stored (uncompressed) ZIP holding one file. Used where a host only lets
// pages save .zip files (the claude.ai artifact viewer).
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipOne(name: string, bytes: Uint8Array): Uint8Array {
  const n = new TextEncoder().encode(name), crc = crc32(bytes), size = bytes.length;
  const out = new Uint8Array(30 + n.length + size + 46 + n.length + 22), v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
  v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true); v.setUint16(26, n.length, true);
  out.set(n, 30); out.set(bytes, 30 + n.length);
  const c = 30 + n.length + size;
  v.setUint32(c, 0x02014b50, true); v.setUint16(c + 4, 20, true); v.setUint16(c + 6, 20, true); v.setUint16(c + 8, 0x800, true);
  v.setUint32(c + 16, crc, true); v.setUint32(c + 20, size, true); v.setUint32(c + 24, size, true); v.setUint16(c + 28, n.length, true);
  out.set(n, c + 46);
  const e = c + 46 + n.length;
  v.setUint32(e, 0x06054b50, true); v.setUint16(e + 8, 1, true); v.setUint16(e + 10, 1, true);
  v.setUint32(e + 12, 46 + n.length, true); v.setUint32(e + 16, c, true);
  return out;
}
