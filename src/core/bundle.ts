// A .soundlab file is a ZIP holding project.json and every asset as
// assets/<asset id>. It moves a whole project between SoundLab apps and people.
import { problems, type Project } from "./project.ts";

export const BUNDLE_EXTENSION = ".soundlab";
export const BUNDLE_MIME = "application/vnd.soundlab.project+zip";
const MAX_ENTRIES = 5000;

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored (uncompressed) ZIP: audio is already compressed or doesn't shrink much.
function zip(files: { name: string; bytes: Uint8Array }[]) {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes);
    if (f.bytes.length >= 0xffffffff || offset >= 0xffffffff) throw new Error("Projects over 4 GB need the online service.");
    const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true); h.setUint32(18, f.bytes.length, true); h.setUint32(22, f.bytes.length, true);
    h.setUint16(26, name.length, true); head.set(name, 30);
    const dir = new Uint8Array(46 + name.length), d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint32(16, crc, true); d.setUint32(20, f.bytes.length, true); d.setUint32(24, f.bytes.length, true);
    d.setUint16(28, name.length, true); d.setUint32(42, offset, true); dir.set(name, 46);
    parts.push(head, f.bytes); central.push(dir);
    offset += head.length + f.bytes.length;
  }
  const size = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...parts, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}
async function inflate(data: Uint8Array) {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error("This device cannot open compressed project files. Export it again from a SoundLab app.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// Reads a standard ZIP's central directory. Supports stored and deflated entries.
async function unzip(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This is not a SoundLab project file.");
  const count = v.getUint16(end + 10, true), dirAt = v.getUint32(end + 16, true);
  if (count > MAX_ENTRIES) throw new Error("This project file has too many entries.");
  const dec = new TextDecoder(), out = new Map<string, Uint8Array>();
  for (let n = 0, p = dirAt; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("This project file is damaged.");
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), compressed = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error("This project file is damaged.");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + compressed > bytes.length) throw new Error("This project file is incomplete.");
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : undefined;
    if (!data) throw new Error("This project file uses an unsupported compression.");
    if (crc32(data) !== crc) throw new Error(`${name} in this project file is damaged.`);
    out.set(name, data);
  }
  return out;
}
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);

export function writeBundle(project: Project, files: Map<string, Uint8Array>) {
  const issues = problems(project);
  if (issues.length) throw new Error(issues[0]);
  for (const a of project.assets) {
    if (!safeId(a.id)) throw new Error(`File id ${a.id} cannot be exported.`);
    if (!files.has(a.id)) throw new Error(`${a.name} is missing, so the project cannot be exported.`);
  }
  const json = new TextEncoder().encode(JSON.stringify(project, null, 1));
  return zip([{ name: "project.json", bytes: json }, ...project.assets.map((a) => ({ name: `assets/${a.id}`, bytes: files.get(a.id)! }))]);
}
export async function readBundle(bytes: Uint8Array): Promise<{ project: Project; files: Map<string, Uint8Array> }> {
  const entries = await unzip(bytes);
  const json = entries.get("project.json");
  if (!json) throw new Error("This is not a SoundLab project file.");
  let project: unknown;
  try { project = JSON.parse(new TextDecoder().decode(json)); } catch { throw new Error("The project details in this file are damaged."); }
  const issues = problems(project);
  if (issues.length) throw new Error(issues[0]);
  const p = project as Project, files = new Map<string, Uint8Array>();
  for (const a of p.assets) {
    if (!safeId(a.id)) throw new Error(`File id ${a.id} is not allowed.`);
    const data = entries.get(`assets/${a.id}`);
    if (!data) throw new Error(`${a.name} is missing from this project file.`);
    if (data.length !== a.bytes) throw new Error(`${a.name} is a different size than the project says.`);
    files.set(a.id, data);
  }
  return { project: p, files };
}
