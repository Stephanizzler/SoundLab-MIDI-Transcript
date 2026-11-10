// Standard MIDI Files (type 1): one tempo track and one note track.
import type { Note } from "./transcribe.ts";

export const MIDI_MIME = "audio/midi";
export const PPQ = 480;
export type MidiSong = { notes: Note[]; bpm: number; program: number; name: string; channel?: number; beatsPerBar?: number };

function vlq(n: number) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const text = (s: string) => [...new TextEncoder().encode(s.slice(0, 120))];
function chunk(type: string, body: number[]) {
  const n = body.length;
  return [...text(type), (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...body];
}

export function writeMidi(song: MidiSong): Uint8Array {
  if (!(song.bpm >= 20 && song.bpm <= 400)) throw new Error("Tempo must be between 20 and 400 BPM.");
  const program = Math.max(0, Math.min(127, Math.round(song.program)));
  const ch = Math.max(0, Math.min(15, song.channel ?? 0));
  const ticks = (s: number) => Math.max(0, Math.round((s * song.bpm * PPQ) / 60));
  const usPerBeat = Math.round(60_000_000 / song.bpm);
  const name = text(song.name);
  const tempo = [
    0, 0xff, 0x03, ...vlq(name.length), ...name,
    0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255,
    0, 0xff, 0x58, 4, song.beatsPerBar ?? 4, 2, 24, 8,
    0, 0xff, 0x2f, 0,
  ];
  type Ev = { t: number; order: number; bytes: number[] };
  const evs: Ev[] = [];
  for (const n of song.notes) {
    const p = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const v = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const on = ticks(n.start), off = Math.max(on + 1, ticks(n.end));
    evs.push({ t: on, order: 1, bytes: [0x90 | ch, p, v] }, { t: off, order: 0, bytes: [0x80 | ch, p, 64] });
  }
  evs.sort((a, b) => a.t - b.t || a.order - b.order);
  const track = [0, 0xff, 0x03, ...vlq(name.length), ...name, 0, 0xc0 | ch, program];
  let last = 0;
  for (const e of evs) { track.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
  track.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([...chunk("MThd", [0, 1, 0, 2, PPQ >> 8, PPQ & 255]), ...chunk("MTrk", tempo), ...chunk("MTrk", track)]);
}

// Reads notes back from a MIDI file (all tracks and channels, first tempo only).
export function readMidi(bytes: Uint8Array): MidiSong {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || tag(0) !== "MThd") throw new Error("This is not a MIDI file.");
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error("MIDI files timed in SMPTE frames are not supported yet.");
  let at = 8 + v.getUint32(4), bpm = 120, program = 0, name = "";
  const raw: { pitch: number; on: number; off: number; velocity: number }[] = [];
  while (at + 8 <= bytes.length) {
    const len = v.getUint32(at + 4), end = Math.min(bytes.length, at + 8 + len);
    if (tag(at) !== "MTrk") { at = end; continue; }
    let i = at + 8, t = 0, status = 0;
    const open = new Map<number, { on: number; velocity: number }[]>();
    const read = () => { let n = 0, b; do { b = bytes[i++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80 && i < end); return n; };
    while (i < end) {
      t += read();
      let s = bytes[i];
      if (s & 0x80) i++; else s = status;
      if (s === 0xff) {
        const type = bytes[i++], l = read();
        if (type === 0x51 && l === 3 && bpm === 120) bpm = 60_000_000 / ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
        if (type === 0x03 && !name) name = new TextDecoder().decode(bytes.subarray(i, i + l));
        i += l;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) { i += read(); continue; }
      status = s;
      const kind = s & 0xf0, key = ((s & 15) << 8) | bytes[i];
      if (kind === 0xc0 || kind === 0xd0) { if (kind === 0xc0) program = bytes[i]; i += 1; continue; }
      const a = bytes[i], b = bytes[i + 1];
      i += 2;
      if (kind === 0x90 && b > 0) open.set(key, [...(open.get(key) ?? []), { on: t, velocity: b }]);
      else if (kind === 0x80 || kind === 0x90) {
        const o = open.get(key)?.shift();
        if (o) raw.push({ pitch: a, on: o.on, off: t, velocity: o.velocity });
      }
    }
    at = end;
  }
  const sec = (tk: number) => (tk / division) * (60 / bpm);
  const notes = raw.map((n) => ({ pitch: n.pitch, start: sec(n.on), end: sec(n.off), velocity: n.velocity })).sort((a, b) => a.start - b.start);
  return { notes, bpm: Math.round(bpm * 1000) / 1000, program, name };
}

// General MIDI programs offered for the exported track (instrument swapping).
export const PROGRAMS: { program: number; name: string }[] = [
  { program: 0, name: "Acoustic piano" },
  { program: 4, name: "Electric piano" },
  { program: 24, name: "Nylon guitar" },
  { program: 33, name: "Finger bass" },
  { program: 38, name: "Synth bass" },
  { program: 40, name: "Violin" },
  { program: 48, name: "Strings" },
  { program: 56, name: "Trumpet" },
  { program: 61, name: "Brass section" },
  { program: 65, name: "Alto sax" },
  { program: 73, name: "Flute" },
  { program: 80, name: "Square lead" },
  { program: 81, name: "Saw lead" },
  { program: 89, name: "Warm pad" },
];
