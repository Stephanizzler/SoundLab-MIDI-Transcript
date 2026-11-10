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

export type Bend = { time: number; semitones: number };
export type Control = { time: number; cc: number; value: number };
export type MidiTrack = { name: string; channel: number; program?: number; notes: Note[]; bends?: Bend[]; bendRange?: number; controls?: Control[] };

export function writeMidi(song: MidiSong): Uint8Array {
  return writeMidiTracks({ bpm: song.bpm, name: song.name, beatsPerBar: song.beatsPerBar, tracks: [{ name: song.name, channel: song.channel ?? 0, program: song.program, notes: song.notes }] });
}

// Type 1 file: a tempo track, then one track per part (melody, chords, bass, drums).
export function writeMidiTracks(x: { bpm: number; name: string; beatsPerBar?: number; tracks: MidiTrack[] }): Uint8Array {
  if (!(x.bpm >= 20 && x.bpm <= 400)) throw new Error("Tempo must be between 20 and 400 BPM.");
  if (!x.tracks.length || x.tracks.length > 15) throw new Error("A MIDI file needs 1 to 15 parts.");
  const ticks = (s: number) => Math.max(0, Math.round((s * x.bpm * PPQ) / 60));
  const usPerBeat = Math.round(60_000_000 / x.bpm);
  const name = text(x.name);
  const tempo = [
    0, 0xff, 0x03, ...vlq(name.length), ...name,
    0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255,
    0, 0xff, 0x58, 4, x.beatsPerBar ?? 4, 2, 24, 8,
    0, 0xff, 0x2f, 0,
  ];
  const chunks = [...chunk("MTrk", tempo)];
  for (const t of x.tracks) {
    const ch = Math.max(0, Math.min(15, Math.round(t.channel)));
    const tn = text(t.name);
    // order at the same tick: note-offs, controls/bends, then note-ons
    type Ev = { t: number; order: number; bytes: number[] };
    const evs: Ev[] = [];
    const head: number[] = [0, 0xff, 0x03, ...vlq(tn.length), ...tn];
    if (t.program !== undefined && ch !== 9) head.push(0, 0xc0 | ch, Math.max(0, Math.min(127, Math.round(t.program))));
    const range = Math.max(1, Math.min(24, Math.round(t.bendRange ?? 2)));
    if (t.bends?.length) head.push(0, 0xb0 | ch, 101, 0, 0, 0xb0 | ch, 100, 0, 0, 0xb0 | ch, 6, range, 0, 0xb0 | ch, 38, 0);
    for (const n of t.notes) {
      const p = Math.max(0, Math.min(127, Math.round(n.pitch)));
      const v = Math.max(1, Math.min(127, Math.round(n.velocity)));
      const on = ticks(n.start), off = Math.max(on + 1, ticks(n.end));
      evs.push({ t: on, order: 2, bytes: [0x90 | ch, p, v] }, { t: off, order: 0, bytes: [0x80 | ch, p, 64] });
    }
    for (const b of t.bends ?? []) {
      const v = Math.max(0, Math.min(16383, Math.round(8192 + (b.semitones / range) * 8192)));
      evs.push({ t: ticks(b.time), order: 1, bytes: [0xe0 | ch, v & 127, v >> 7] });
    }
    for (const c of t.controls ?? []) evs.push({ t: ticks(c.time), order: 1, bytes: [0xb0 | ch, c.cc & 127, Math.max(0, Math.min(127, Math.round(c.value)))] });
    evs.sort((a, b) => a.t - b.t || a.order - b.order);
    let last = 0;
    const body = [...head];
    for (const e of evs) { body.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(...chunk("MTrk", body));
  }
  return new Uint8Array([...chunk("MThd", [0, 1, 0, x.tracks.length + 1, PPQ >> 8, PPQ & 255]), ...chunks]);
}

// Reads notes back from a MIDI file (all tracks and channels, first tempo only).
export type ReadTrack = { name: string; channel: number; notes: Note[]; bends: { time: number; value: number }[]; controls: Control[] };
export function readMidi(bytes: Uint8Array): MidiSong & { tracks: ReadTrack[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || tag(0) !== "MThd") throw new Error("This is not a MIDI file.");
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error("MIDI files timed in SMPTE frames are not supported yet.");
  let at = 8 + v.getUint32(4), bpm = 120, program = 0, name = "";
  const raw: { pitch: number; on: number; off: number; velocity: number; track: number }[] = [];
  const info: { name: string; channel: number; bends: { t: number; value: number }[]; controls: { t: number; cc: number; value: number }[] }[] = [];
  while (at + 8 <= bytes.length) {
    const len = v.getUint32(at + 4), end = Math.min(bytes.length, at + 8 + len);
    if (tag(at) !== "MTrk") { at = end; continue; }
    let i = at + 8, t = 0, status = 0;
    const open = new Map<number, { on: number; velocity: number }[]>();
    const tr = { name: "", channel: -1, bends: [] as { t: number; value: number }[], controls: [] as { t: number; cc: number; value: number }[] };
    info.push(tr);
    const read = () => { let n = 0, b; do { b = bytes[i++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80 && i < end); return n; };
    while (i < end) {
      t += read();
      let s = bytes[i];
      if (s & 0x80) i++; else s = status;
      if (s === 0xff) {
        const type = bytes[i++], l = read();
        if (type === 0x51 && l === 3 && bpm === 120) bpm = 60_000_000 / ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
        if (type === 0x03) { const n = new TextDecoder().decode(bytes.subarray(i, i + l)); if (!name) name = n; if (!tr.name) tr.name = n; }
        i += l;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) { i += read(); continue; }
      status = s;
      const kind = s & 0xf0, key = ((s & 15) << 8) | bytes[i];
      if (kind === 0xc0 || kind === 0xd0) { if (kind === 0xc0) program = bytes[i]; i += 1; continue; }
      const a = bytes[i], b = bytes[i + 1];
      i += 2;
      if (tr.channel < 0) tr.channel = s & 15;
      if (kind === 0xe0) tr.bends.push({ t, value: a | (b << 7) });
      if (kind === 0xb0) tr.controls.push({ t, cc: a, value: b });
      if (kind === 0x90 && b > 0) open.set(key, [...(open.get(key) ?? []), { on: t, velocity: b }]);
      else if (kind === 0x80 || kind === 0x90) {
        const o = open.get(key)?.shift();
        if (o) raw.push({ pitch: a, on: o.on, off: t, velocity: o.velocity, track: info.length - 1 });
      }
    }
    at = end;
  }
  const sec = (tk: number) => (tk / division) * (60 / bpm);
  const toNote = (n: (typeof raw)[number]) => ({ pitch: n.pitch, start: sec(n.on), end: sec(n.off), velocity: n.velocity });
  const notes = raw.map(toNote).sort((a, b) => a.start - b.start);
  const tracks = info
    .map((tr, k) => ({ name: tr.name, channel: Math.max(0, tr.channel), notes: raw.filter((n) => n.track === k).map(toNote).sort((a, b) => a.start - b.start), bends: tr.bends.map((b) => ({ time: sec(b.t), value: b.value })), controls: tr.controls.map((c) => ({ time: sec(c.t), cc: c.cc, value: c.value })) }))
    .filter((tr) => tr.notes.length || tr.bends.length);
  return { notes, bpm: Math.round(bpm * 1000) / 1000, program, name, tracks };
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
