// Audio to notes for one line at a time (a melody, vocal, bass line or solo).
// Pitch frames from YIN are grouped into notes: a note starts when a steady
// pitch appears, ends at silence or a pitch change, and is split again when the
// level jumps (a re-played note at the same pitch).
import { trackPitch, hzToMidi, mixToMono, type PitchFrame } from "./pitch.ts";

export type Note = { pitch: number; start: number; end: number; velocity: number };

export type Settings = {
  minHz: number;
  maxHz: number;
  minClarity: number; // 0..1, frames less periodic than this are treated as unpitched
  gateDb: number; // frames this far below the loudest frame are silence (negative)
  minNoteSeconds: number;
  attackDb: number; // a level jump this big starts a new note at the same pitch; 0 turns it off
  hopSeconds: number;
};
export const DEFAULT_SETTINGS: Settings = { minHz: 50, maxHz: 2000, minClarity: 0.8, gateDb: -45, minNoteSeconds: 0.06, attackDb: 6, hopSeconds: 0.01 };

// Pitch ranges for common sources. Narrower ranges avoid octave mistakes.
export const RANGES: { id: string; name: string; minHz: number; maxHz: number }[] = [
  { id: "any", name: "Any melody", minHz: 50, maxHz: 2000 },
  { id: "voice", name: "Voice", minHz: 75, maxHz: 1100 },
  { id: "bass", name: "Bass", minHz: 30, maxHz: 400 },
  { id: "guitar", name: "Guitar", minHz: 75, maxHz: 1400 },
  { id: "keys", name: "Keys / synth lead", minHz: 27, maxHz: 4200 },
  { id: "whistle", name: "Whistle / flute", minHz: 250, maxHz: 3000 },
];

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export type Transcription = { notes: Note[]; frames: PitchFrame[]; hop: number };

export function transcribe(channels: Float32Array[], rate: number, partial: Partial<Settings> = {}, onProgress?: (f: number) => void): Transcription {
  const s = { ...DEFAULT_SETTINGS, ...partial };
  const mono = mixToMono(channels);
  const frames = trackPitch(mono, rate, { minHz: s.minHz, maxHz: s.maxHz, hopSeconds: s.hopSeconds }, (f) => onProgress?.(f * 0.95));
  const notes = framesToNotes(frames, s, levelEnvelope(mono, rate, frames, s.minHz));
  onProgress?.(1);
  return { notes, frames, hop: s.hopSeconds };
}

// Level in dB over a short (10 ms) window at each frame. The pitch window is
// longer, which blurs the small dips between quickly repeated notes.
// The window is at least one cycle of the pitch, so low notes don't wobble.
export function levelEnvelope(x: Float32Array, rate: number, frames: PitchFrame[], minHz = 50): number[] {
  return frames.map((f) => {
    const half = Math.max(1, Math.round(rate * Math.max(0.005, 0.55 / (f.hz > 0 ? f.hz : minHz))));
    const c = Math.round(f.time * rate);
    let sum = 0, n = 0;
    for (let i = Math.max(0, c - half); i < Math.min(x.length, c + half); i++, n++) sum += x[i] * x[i];
    return n && sum > 0 ? 10 * Math.log10(sum / n) : -120;
  });
}

export function framesToNotes(frames: PitchFrame[], s: Settings, level: number[] = frames.map((f) => f.db)): Note[] {
  if (!frames.length) return [];
  const loudest = Math.max(...frames.map((f) => f.db));
  const voiced = frames.map((f) => f.hz > 0 && f.clarity >= s.minClarity && f.db >= loudest + s.gateDb);
  // Median-smooth the pitch over voiced neighbours to remove single-frame jumps.
  const raw = frames.map((f) => (f.hz > 0 ? hzToMidi(f.hz) : 0));
  const midi = raw.map((m, i) => {
    if (!voiced[i]) return 0;
    const near: number[] = [];
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < frames.length && voiced[k]) near.push(raw[k]);
    return median(near);
  });
  // An attack: the short-window level rises by attackDb within ~60 ms. Only the
  // first frame of each rise counts.
  const rise = level.map((v, i) => {
    let low = Infinity;
    for (let k = Math.max(0, i - 6); k < i; k++) low = Math.min(low, level[k]);
    return v - low;
  });
  const attack = rise.map((r, i) => !!s.attackDb && i > 0 && r >= s.attackDb && rise[i - 1] < s.attackDb);

  // 1. Segments of steady pitch, with half a semitone of hysteresis.
  type Seg = { from: number; to: number; pitch: number };
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  for (let i = 0; i < frames.length; i++) {
    if (!voiced[i]) { cur = null; continue; }
    const p = Math.round(midi[i]);
    if (cur && cur.to === i - 1 && Math.abs(midi[i] - cur.pitch) <= 0.6 && !attack[i]) { cur.to = i; continue; }
    cur = { from: i, to: i, pitch: p };
    segs.push(cur);
  }
  // 2. Fold segments that are too short into a touching neighbour (pitch glides,
  //    vibrato overshoot), or drop them when they stand alone.
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : s.hopSeconds;
  const minFrames = Math.max(1, Math.round(s.minNoteSeconds / hop));
  const len = (x: Seg) => x.to - x.from + 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const x = segs[i];
      if (len(x) >= minFrames) continue;
      const prev = segs[i - 1]?.to === x.from - 1 && !attack[x.from] ? segs[i - 1] : undefined;
      const next = segs[i + 1]?.from === x.to + 1 && !attack[x.to + 1] ? segs[i + 1] : undefined;
      const into = prev && next ? (len(prev) >= len(next) ? prev : next) : prev ?? next;
      if (into) { into.from = Math.min(into.from, x.from); into.to = Math.max(into.to, x.to); }
      segs.splice(i, 1);
      changed = true;
      break;
    }
  }
  // 3. Merge touching segments that ended up on the same pitch without a new attack.
  for (let i = segs.length - 1; i > 0; i--) {
    const a = segs[i - 1], b = segs[i];
    if (a.to === b.from - 1 && a.pitch === b.pitch && !attack[b.from]) { a.to = b.to; segs.splice(i, 1); }
  }
  // 4. Notes: pitch is the median over the note; velocity follows the peak level.
  const peaks = segs.map((x) => Math.max(...frames.slice(x.from, x.to + 1).map((f) => f.db)));
  const top = Math.max(...peaks, -120);
  return segs
    .map((x, i) => {
      const pitch = Math.round(median(midi.slice(x.from, x.to + 1)));
      const velocity = Math.max(1, Math.min(127, Math.round(127 + (peaks[i] - top) * 2.2)));
      return { pitch, start: Math.max(0, frames[x.from].time - hop / 2), end: frames[x.to].time + hop / 2, velocity };
    })
    .filter((n) => n.pitch >= 0 && n.pitch <= 127 && n.end - n.start >= s.minNoteSeconds * 0.99);
}

// Snap notes to a grid of `division` steps per beat. Strength 1 snaps fully,
// 0.5 moves each note halfway. Notes are kept at least one step long.
export function quantize(notes: Note[], bpm: number, division: number, strength = 1): Note[] {
  if (!(bpm >= 20 && bpm <= 400)) throw new Error("Tempo must be between 20 and 400 BPM.");
  if (!(division > 0)) return notes;
  const step = 60 / bpm / division;
  const snap = (t: number) => t + (Math.round(t / step) * step - t) * strength;
  return notes.map((n) => {
    const start = Math.max(0, snap(n.start));
    const end = Math.max(start + step * strength + (n.end - n.start) * (1 - strength), snap(n.end));
    return { ...n, start, end };
  });
}

// Most common pitch classes, as a rough key hint ("A minor / C major").
const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const noteName = (p: number) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
export function guessKey(notes: Note[]): string | null {
  if (notes.length < 8) return null;
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[n.pitch % 12] += n.end - n.start;
  // Krumhansl–Kessler major profile, correlated against each tonic.
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (profile: number[], tonic: number) => {
    const xs = profile.map((_, i) => weight[(i + tonic) % 12]);
    const mx = xs.reduce((a, b) => a + b) / 12, mp = profile.reduce((a, b) => a + b) / 12;
    let num = 0, dx = 0, dp = 0;
    for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (profile[i] - mp); dx += (xs[i] - mx) ** 2; dp += (profile[i] - mp) ** 2; }
    return dx && dp ? num / Math.sqrt(dx * dp) : 0;
  };
  let best = { name: "", r: -Infinity };
  for (let t = 0; t < 12; t++) {
    const rM = corr(major, t), rm = corr(minor, t);
    if (rM > best.r) best = { name: `${NAMES[t]} major`, r: rM };
    if (rm > best.r) best = { name: `${NAMES[t]} minor`, r: rm };
  }
  return best.name;
}
