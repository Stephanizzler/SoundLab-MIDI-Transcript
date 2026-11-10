// Beatbox and drum recordings to drum notes. Hits are found where the spectrum
// suddenly changes (spectral flux), described by how low, bright and short
// they are, and grouped so that every kick-like sound lands in one group.
// Each group becomes one General MIDI drum note, which the user can change.
import { fft, nextPow2 } from "./fft.ts";
import type { Note } from "./transcribe.ts";

export type Hit = { time: number; velocity: number; group: number; features: number[] };
export type DrumGroup = { id: number; note: number; count: number; brightness: number };
export type DrumResult = { hits: Hit[]; groups: DrumGroup[] };

export const DRUM_NOTES: { note: number; name: string }[] = [
  { note: 36, name: "Kick" }, { note: 38, name: "Snare" }, { note: 40, name: "Snare (rim)" }, { note: 39, name: "Clap" },
  { note: 37, name: "Side stick" }, { note: 42, name: "Closed hi-hat" }, { note: 46, name: "Open hi-hat" }, { note: 44, name: "Pedal hi-hat" },
  { note: 41, name: "Low tom" }, { note: 45, name: "Mid tom" }, { note: 48, name: "High tom" }, { note: 49, name: "Crash" },
  { note: 51, name: "Ride" }, { note: 54, name: "Tambourine" }, { note: 56, name: "Cowbell" }, { note: 75, name: "Claves" },
];
export const drumName = (note: number) => DRUM_NOTES.find((d) => d.note === note)?.name ?? `Note ${note}`;

export type DrumOptions = { sensitivity: number; groups: number /* 0 = automatic */; minGapSeconds: number; gateDb: number };
export const DEFAULT_DRUMS: DrumOptions = { sensitivity: 0.5, groups: 0, minGapSeconds: 0.05, gateDb: -40 };

export function detectDrums(x: Float32Array, rate: number, partial: Partial<DrumOptions> = {}, onProgress?: (f: number) => void): DrumResult {
  const o = { ...DEFAULT_DRUMS, ...partial };
  const N = nextPow2(rate * 0.023), hop = N >> 2, bins = N >> 1;
  const re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  let prev = new Float64Array(bins);
  const flux = new Float64Array(frames), energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    if (onProgress && f % 500 === 0) onProgress((f / frames) * 0.8);
    const at = f * hop;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[at + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    energy[f] = e / N;
    fft(re, im);
    const mag = new Float64Array(bins);
    let fl = 0;
    for (let k = 0; k < bins; k++) { mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k])); const d = mag[k] - prev[k]; if (d > 0) fl += d; }
    flux[f] = fl;
    prev = mag;
  }
  // Peaks above a moving median threshold; sensitivity lowers the threshold.
  const loud = Math.max(...energy, 1e-12), gate = loud * 10 ** (o.gateDb / 10);
  const span = Math.round((0.1 * rate) / hop), minGap = Math.round((o.minGapSeconds * rate) / hop);
  const fluxMax = Math.max(...flux, 1e-9);
  const k = 1.2 + (1 - o.sensitivity) * 2.5;
  const times: { f: number; strength: number }[] = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    const near = Array.from(flux.subarray(Math.max(0, f - span), Math.min(frames, f + span + 1))).sort((a, b) => a - b);
    const thr = near[Math.floor(near.length / 2)] * k + 0.04 * fluxMax;
    if (flux[f] < thr) continue;
    let peakE = 0, before = Infinity;
    for (let g = f; g < Math.min(frames, f + 4); g++) peakE = Math.max(peakE, energy[g]);
    for (let g = Math.max(0, f - 6); g < f; g++) before = Math.min(before, energy[g]);
    if (peakE < gate || (f > 0 && peakE < before * 2)) continue; // a hit gets at least 3 dB louder
    const last = times[times.length - 1];
    if (last && f - last.f < minGap) { if (flux[f] > flux[last.f]) times[times.length - 1] = { f, strength: peakE }; continue; }
    times.push({ f, strength: peakE });
  }
  // Describe each hit from the first ~60 ms after its onset. The flux peaks
  // when the onset is about 85% of the way into the analysis window.
  const hits: Hit[] = times.map(({ f, strength }) => {
    const at = Math.min(x.length - 1, f * hop + Math.round(0.85 * N));
    const L = Math.min(nextPow2(rate * 0.06), 1 << 15);
    const r2 = new Float64Array(L), i2 = new Float64Array(L);
    let early = 0, late = 0;
    for (let i = 0; i < L && at + i < x.length; i++) {
      const v = x[at + i];
      r2[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)));
      if (i < L / 3) early += v * v; else late += v * v;
    }
    fft(r2, i2);
    // The same length just before the hit, so a sound still ringing (a kick
    // under a hi-hat) is subtracted and only what the hit added is described.
    const r0 = new Float64Array(L), i0 = new Float64Array(L);
    for (let i = 0; i < L; i++) { const j = at - L + i; r0[i] = j >= 0 ? x[j] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1))) : 0; }
    fft(r0, i0);
    let num = 0, den = 0, low = 0, high = 0;
    for (let b = 1; b < L / 2; b++) {
      const hz = (b * rate) / L, m = Math.max(0, Math.hypot(r2[b], i2[b]) - Math.hypot(r0[b], i0[b])) ** 2;
      num += m * hz; den += m;
      if (hz < 150) low += m;
      if (hz > 4000) high += m;
    }
    const centroid = den > 0 ? num / den : 0;
    // Levels are measured above what was already sounding before the hit.
    let pre = 0;
    for (let i = 1; i <= L && at - i >= 0; i++) pre += x[at - i] * x[at - i];
    pre /= L;
    const e1 = Math.max(0, early / (L / 3) - pre), e2 = Math.max(0, late / ((2 * L) / 3) - pre);
    const features = [Math.log2(Math.max(50, centroid)), den ? low / den : 0, den ? high / den : 0, Math.log10(1 + e2 / (e1 + 1e-12))];
    const velocity = Math.max(1, Math.min(127, Math.round(127 + 10 * Math.log10(strength / loud) * 2)));
    return { time: at / rate, velocity, group: 0, features };
  });
  onProgress?.(0.9);
  const groups = groupHits(hits, o.groups);
  onProgress?.(1);
  return { hits, groups };
}

// k-means on standardised features. With `want` = 0, tries 1–4 groups and keeps
// the clearest split (silhouette), so one sound repeated stays one group.
function groupHits(hits: Hit[], want: number): DrumGroup[] {
  if (!hits.length) return [];
  const dims = hits[0].features.length;
  const mean = Array.from({ length: dims }, (_, d) => hits.reduce((a, h) => a + h.features[d], 0) / hits.length);
  // Features are compared in fixed units that mean the same in every file:
  // half an octave of brightness, 12% of the energy low or high, and so on.
  // Two takes of one sound differ by less than one unit; different sounds by several.
  const sd = [0.5, 0.12, 0.12, 0.15].slice(0, dims);
  const pts = hits.map((h) => h.features.map((v, d) => (v - mean[d]) / sd[d]));
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
  const kmeans = (k: number) => {
    // Seeds spread out by brightness (feature 0), so results are repeatable.
    const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0]);
    let centres = Array.from({ length: k }, (_, j) => [...pts[order[Math.round(((j + 0.5) / k) * (order.length - 1))]]]);
    let label = new Array(pts.length).fill(0);
    for (let it = 0; it < 50; it++) {
      const next = pts.map((p) => { let best = 0; for (let j = 1; j < k; j++) if (dist(p, centres[j]) < dist(p, centres[best])) best = j; return best; });
      const same = next.every((v, i) => v === label[i]);
      label = next;
      centres = centres.map((c, j) => {
        const mine = pts.filter((_, i) => label[i] === j);
        return mine.length ? c.map((_, d) => mine.reduce((a, p) => a + p[d], 0) / mine.length) : c;
      });
      if (same && it) break;
    }
    return label;
  };
  const silhouette = (label: number[], k: number) => {
    if (k < 2) return 0;
    const sample = pts.length > 400 ? pts.map((_, i) => i).filter((i) => i % Math.ceil(pts.length / 400) === 0) : pts.map((_, i) => i);
    let total = 0;
    for (const i of sample) {
      const by = new Array(k).fill(0), cnt = new Array(k).fill(0);
      for (const j of sample) if (j !== i) { by[label[j]] += dist(pts[i], pts[j]); cnt[label[j]]++; }
      const a = cnt[label[i]] ? by[label[i]] / cnt[label[i]] : 0;
      const b = Math.min(...by.map((v, j) => (j === label[i] || !cnt[j] ? Infinity : v / cnt[j])));
      total += Number.isFinite(b) && Math.max(a, b) > 0 ? (b - a) / Math.max(a, b) : 0;
    }
    return total / sample.length;
  };
  // Groups count as different sounds only when their centres are well apart.
  const apart = (label: number[], k: number) => {
    const centres = Array.from({ length: k }, (_, j) => {
      const mine = pts.filter((_, i) => label[i] === j);
      return mine.length ? mine[0].map((_, d) => mine.reduce((a, p) => a + p[d], 0) / mine.length) : null;
    });
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (!centres[a] || !centres[b] || dist(centres[a]!, centres[b]!) < 2.5) return false;
    return true;
  };
  let label = new Array(pts.length).fill(0), k = 1;
  if (want > 0) { k = Math.min(want, pts.length); label = kmeans(k); }
  else {
    let best = 0.35; // a weaker split than this is treated as one sound
    for (let kk = 2; kk <= Math.min(4, pts.length - 1); kk++) {
      const l = kmeans(kk), s = silhouette(l, kk);
      if (s > best + 0.02 && apart(l, kk)) { best = s; label = l; k = kk; }
    }
  }
  // Name groups from dark to bright: kick, snare, clap, hi-hat.
  const used = [...new Set(label)];
  const bright = used.map((g) => ({ g, b: hits.filter((_, i) => label[i] === g).reduce((a, h) => a + h.features[0], 0) / hits.filter((_, i) => label[i] === g).length }));
  bright.sort((a, b) => a.b - b.b);
  const plan: Record<number, number[]> = { 1: [38], 2: [36, 42], 3: [36, 38, 42], 4: [36, 38, 39, 42] };
  const notes = plan[bright.length] ?? plan[4];
  const groups: DrumGroup[] = bright.map(({ g, b }, i) => ({ id: i, note: notes[Math.min(i, notes.length - 1)], count: 0, brightness: Math.round(2 ** b) }));
  const remap = new Map(bright.map(({ g }, i) => [g, i]));
  hits.forEach((h, i) => { h.group = remap.get(label[i])!; groups[h.group].count++; });
  return groups;
}

export function drumNotes(r: DrumResult, length = 0.08): Note[] {
  return r.hits.map((h) => ({ pitch: r.groups[h.group]?.note ?? 38, start: h.time, end: h.time + length, velocity: h.velocity }));
}
