// Parts built from a transcribed melody: pitch bend for slides and vibrato,
// a chord track and bass line in the key, and expression controls taken from
// the recording's loudness and brightness.
import { hzToMidi } from "./pitch.ts";
import { fft, nextPow2 } from "./fft.ts";
import { SCALES, snapToKey, type Key } from "./scale.ts";
import { NAMES, type Note } from "./transcribe.ts";
import type { Bend, Control } from "./midi.ts";

type Frame = { time: number; hz: number; clarity: number };

// Movement around each note's own centre, so a note snapped to the key keeps
// its new pitch and only the slides and vibrato are sent as bend.
export function pitchBends(notes: Note[], frames: Frame[], opts: { range: number; minClarity: number }): Bend[] {
  const out: Bend[] = [];
  const range = Math.max(1, opts.range);
  let fi = 0;
  for (const n of notes) {
    const centre = n.tune ?? n.pitch;
    while (fi < frames.length && frames[fi].time < n.start) fi++;
    const dev: { time: number; d: number }[] = [];
    for (let k = fi; k < frames.length && frames[k].time <= n.end; k++) {
      const f = frames[k];
      if (f.hz > 0 && f.clarity >= opts.minClarity) dev.push({ time: f.time, d: Math.max(-range, Math.min(range, hzToMidi(f.hz) - centre)) });
    }
    out.push({ time: n.start, semitones: 0 });
    let last = 0;
    for (let k = 0; k < dev.length; k++) {
      const near = dev.slice(Math.max(0, k - 1), k + 2).map((x) => x.d).sort((a, b) => a - b);
      const d = near[Math.floor(near.length / 2)];
      if (Math.abs(d - last) >= 0.04) { out.push({ time: dev[k].time, semitones: Math.round(d * 1000) / 1000 }); last = d; }
    }
    if (last !== 0) out.push({ time: n.end, semitones: 0 });
  }
  return out;
}

export type ChordOptions = { style: "triads" | "sevenths"; voicing: "close" | "spread"; octave: number; minSeconds: number };
export const DEFAULT_CHORDS: ChordOptions = { style: "triads", voicing: "close", octave: 0, minSeconds: 0.2 };
export type Chord = { root: number; tones: number[]; name: string; start: number; end: number; velocity: number };

// Seven-note scale to build chords from (pentatonic and blues borrow their parent scale).
const parent = (k: Key): number[] => {
  const s = SCALES[k.scale].steps;
  if (s.length === 7) return s;
  return SCALES[k.scale === "major-pent" ? "major" : "minor"].steps;
};
export function chordName(rootPc: number, tones: number[]) {
  const iv = tones.map((t) => (((t - tones[0]) % 12) + 12) % 12);
  const third = iv.includes(4) ? "maj" : "min", fifth = iv.includes(6) ? "dim" : iv.includes(8) ? "aug" : "";
  const seventh = iv.includes(11) ? "maj7" : iv.includes(10) ? "7" : "";
  const base = NAMES[rootPc];
  if (fifth === "dim") return `${base}${seventh === "7" ? "m7♭5" : "dim"}`;
  if (fifth === "aug") return `${base}aug`;
  if (third === "maj") return `${base}${seventh}`;
  return `${base}m${seventh === "7" ? "7" : seventh === "maj7" ? "(maj7)" : ""}`;
}

// One chord per melody note in the key, rooted on that note's scale degree.
// Short passing notes keep the chord that is already playing.
export function harmonize(melody: Note[], k: Key, o: ChordOptions = DEFAULT_CHORDS): Chord[] {
  const steps = parent(k);
  const pcOf = (deg: number) => (k.tonic + steps[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7)) ;
  const out: Chord[] = [];
  const snapped = snapToKey(melody, { tonic: k.tonic, scale: steps === SCALES[k.scale].steps ? k.scale : k.scale === "major-pent" ? "major" : "minor" });
  for (const n of snapped) {
    const rel = (((n.pitch - k.tonic) % 12) + 12) % 12;
    const deg = steps.indexOf(rel);
    const prev = out[out.length - 1];
    if (deg < 0 || (prev && n.end - n.start < o.minSeconds && n.start - prev.end < 0.3)) { if (prev) prev.end = Math.max(prev.end, n.end); continue; }
    const degrees = o.style === "sevenths" ? [0, 2, 4, 6] : [0, 2, 4];
    const base = 48 + 12 * o.octave; // around C3
    const rootPc = (k.tonic + steps[deg]) % 12;
    let root = base + rootPc;
    if (root > base + 7) root -= 12; // keep chords in a comfortable range
    let tones = degrees.map((d) => root + (pcOf(deg + d) - pcOf(deg)));
    if (o.voicing === "spread") tones = tones.map((t, i) => (i === 1 ? t + 12 : t));
    tones.sort((a, b) => a - b);
    const name = chordName(rootPc, degrees.map((d) => pcOf(deg + d) - pcOf(deg) + rootPc));
    if (prev && prev.name === name && n.start - prev.end < 0.3) { prev.end = n.end; continue; }
    out.push({ root, tones, name, start: n.start, end: n.end, velocity: Math.round(n.velocity * 0.8) });
  }
  // Each chord holds until the next one starts (or a gap longer than half a second).
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 0.5) out[i].end = out[i + 1].start;
  return out;
}
export const chordNotes = (chords: Chord[]): Note[] => chords.flatMap((c) => c.tones.map((p) => ({ pitch: p, start: c.start, end: c.end, velocity: Math.max(1, c.velocity) })));
export const bassNotes = (chords: Chord[], octave = 0): Note[] =>
  chords.map((c) => ({ pitch: 36 + 12 * octave + (((c.root % 12) + 12) % 12) - (((c.root % 12) + 12) % 12 > 7 ? 12 : 0), start: c.start, end: c.end, velocity: Math.min(127, c.velocity + 10) }));

// Loudness (dB) and spectral centroid (Hz) every 20 ms, for expression controls.
export type ExpressionFrame = { time: number; db: number; centroid: number };
export function expressionCurve(x: Float32Array, rate: number): ExpressionFrame[] {
  const hop = Math.round(rate * 0.02), N = nextPow2(rate * 0.04);
  const re = new Float64Array(N), im = new Float64Array(N), out: ExpressionFrame[] = [];
  for (let start = 0; start + hop <= x.length; start += hop) {
    let e = 0;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N && start + i < x.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = x[start + i] * w;
      e += x[start + i] * x[start + i];
    }
    const db = e > 0 ? 10 * Math.log10(e / N) : -120;
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * (k * rate) / N; den += m; }
    out.push({ time: (start + N / 2) / rate, db, centroid: den > 0 ? num / den : 0 });
  }
  return out;
}
// CC11 (expression) from loudness and CC74 (brightness) from the centroid.
export function expressionControls(curve: ExpressionFrame[], which: { loudness: boolean; brightness: boolean }): Control[] {
  if (!curve.length) return [];
  const top = Math.max(...curve.map((f) => f.db));
  const out: Control[] = [];
  let lastL = -1, lastB = -1;
  for (const f of curve) {
    if (which.loudness) {
      const v = Math.round(Math.max(0, Math.min(127, ((f.db - top + 40) / 40) * 127)));
      if (Math.abs(v - lastL) >= 2 || (v === 0 && lastL > 0)) { out.push({ time: f.time, cc: 11, value: v }); lastL = v; }
    }
    if (which.brightness && f.db > top - 40) {
      const v = Math.round(Math.max(0, Math.min(127, ((Math.log2(Math.max(200, f.centroid)) - Math.log2(200)) / (Math.log2(8000) - Math.log2(200))) * 127)));
      if (Math.abs(v - lastB) >= 2) { out.push({ time: f.time, cc: 74, value: v }); lastB = v; }
    }
  }
  return out;
}
