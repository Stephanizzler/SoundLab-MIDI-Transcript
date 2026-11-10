// WAV reading and writing at the file's own sample rate and bit depth, and a
// small built-in synth that renders notes so the transcription can be heard.
import type { Note } from "./transcribe.ts";
import { midiToHz } from "./pitch.ts";

export type Pcm = { channels: Float32Array[]; rate: number; bits: number; float: boolean };

export function readWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("This is not a WAV file.");
  let at = 12, fmt: { format: number; channels: number; rate: number; bits: number } | null = null, data: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at), len = v.getUint32(at + 4, true), body = at + 8;
    if (id === "fmt ") {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && len >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") data = bytes.subarray(body, Math.min(bytes.length, body + len));
    at = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error("This WAV file has no audio.");
  const { format, channels, rate, bits } = fmt;
  const float = format === 3;
  if (!(format === 1 || format === 3)) throw new Error("This WAV file uses a compressed format; export it as PCM WAV.");
  if (!(channels >= 1 && channels <= 64) || !(rate >= 8000 && rate <= 384000)) throw new Error("This WAV file's channels or sample rate are not valid.");
  const size = bits / 8;
  if (![1, 2, 3, 4, 8].includes(size) || (float && size < 4)) throw new Error(`${bits}-bit WAV files are not supported.`);
  const frames = Math.floor(data.length / (size * channels));
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, p = 0; i < frames; i++)
    for (let c = 0; c < channels; c++, p += size) {
      let x: number;
      if (float) x = size === 4 ? d.getFloat32(p, true) : d.getFloat64(p, true);
      else if (size === 1) x = (d.getUint8(p) - 128) / 128;
      else if (size === 2) x = d.getInt16(p, true) / 32768;
      else if (size === 3) x = (((d.getUint8(p + 2) << 24) | (d.getUint8(p + 1) << 16) | (d.getUint8(p) << 8)) >> 8) / 8388608;
      else x = d.getInt32(p, true) / 2147483648;
      out[c][i] = x;
    }
  return { channels: out, rate, bits, float };
}

export function writeWav(channels: Float32Array[], rate: number, bits: 16 | 24 = 24): Uint8Array {
  const n = channels[0]?.length ?? 0, size = bits / 8, block = size * channels.length;
  const out = new Uint8Array(44 + n * block), v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  put(0, "RIFF"); v.setUint32(4, 36 + n * block, true); put(8, "WAVE");
  put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels.length, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * block, true); v.setUint16(32, block, true); v.setUint16(34, bits, true);
  put(36, "data"); v.setUint32(40, n * block, true);
  for (let i = 0, p = 44; i < n; i++)
    for (const ch of channels) {
      const x = Math.max(-1, Math.min(1, ch[i]));
      if (bits === 16) { v.setInt16(p, Math.round(x * 32767), true); p += 2; }
      else { const s = Math.round(x * 8388607); out[p] = s & 255; out[p + 1] = (s >> 8) & 255; out[p + 2] = (s >> 16) & 255; p += 3; }
    }
  return out;
}

// A plain, honest-sounding preview: a few harmonics with a short attack and
// release. It is for checking the notes, not a substitute for a real instrument.
export function renderNotes(notes: Note[], rate: number, seconds?: number): Float32Array {
  const length = Math.ceil(rate * (seconds ?? Math.max(0, ...notes.map((n) => n.end)) + 0.3));
  const out = new Float32Array(length);
  const attack = 0.005 * rate, release = 0.06 * rate;
  for (const n of notes) {
    const hz = midiToHz(n.pitch), from = Math.floor(n.start * rate), held = Math.max(1, Math.floor((n.end - n.start) * rate));
    const amp = 0.25 * (n.velocity / 127) ** 1.5;
    const w = (2 * Math.PI * hz) / rate;
    for (let i = 0; i < held + release && from + i < length; i++) {
      const env = Math.min(1, i / attack) * (i < held ? 1 : 1 - (i - held) / release) * Math.exp(-i / (rate * 1.5)) ;
      const ph = w * i;
      out[from + i] += amp * env * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph));
    }
  }
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  if (peak > 0.89) for (let i = 0; i < length; i++) out[i] *= 0.89 / peak;
  return out;
}
