// ITU-R BS.1770-4 / EBU R128 loudness: integrated loudness (gated), loudness
// range (EBU Tech 3342) and true peak (4x oversampled). Mono or stereo PCM.
import type { Loudness } from "./project.ts";

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };
// K-weighting coefficients for any sample rate (the 48 kHz values in the
// standard, re-derived from their analogue prototypes as libebur128 does).
function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}
function filter(x: Float32Array, f: Biquad, out = new Float64Array(x.length)) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}
const lufs = (power: number) => -0.691 + 10 * Math.log10(power);

// Mean-square power of K-weighted audio in windows of `size` seconds every `step` seconds.
function blocks(weighted: Float64Array[], rate: number, size: number, step: number) {
  const n = Math.round(size * rate), hop = Math.round(step * rate), length = weighted[0].length;
  // Running sums of squares make every window O(1).
  const sums = weighted.map((ch) => {
    const s = new Float64Array(ch.length + 1);
    for (let i = 0; i < ch.length; i++) s[i + 1] = s[i] + ch[i] * ch[i];
    return s;
  });
  const out: number[] = [];
  for (let start = 0; start + n <= length; start += hop) {
    let power = 0;
    for (const s of sums) power += (s[start + n] - s[start]) / n; // L and R weights are 1.0
    out.push(power);
  }
  return out;
}
function gated(powers: number[], relativeLu: number) {
  const absolute = powers.filter((p) => lufs(p) > -70);
  if (!absolute.length) return { power: 0, kept: [] as number[] };
  const mean = absolute.reduce((a, b) => a + b, 0) / absolute.length;
  const threshold = lufs(mean) - relativeLu;
  const kept = absolute.filter((p) => lufs(p) > threshold);
  return { power: kept.reduce((a, b) => a + b, 0) / Math.max(1, kept.length), kept };
}
// 4x oversampling with a 48-tap windowed-sinc interpolator, as BS.1770 Annex 2 suggests.
const PHASES = 4, TAPS = 12;
const kernel = (() => {
  const k: number[][] = [];
  for (let phase = 0; phase < PHASES; phase++) {
    const row: number[] = [];
    for (let t = 0; t < TAPS; t++) {
      const x = t - TAPS / 2 + 1 - phase / PHASES;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2)); // Hann
      row.push(sinc * w);
    }
    k.push(row);
  }
  return k;
})();
function truePeak(channel: Float32Array) {
  let peak = 0;
  for (let i = 0; i < channel.length; i++) {
    const a = Math.abs(channel[i]);
    if (a > peak) peak = a;
    for (let phase = 1; phase < PHASES; phase++) {
      let y = 0;
      const row = kernel[phase];
      for (let t = 0; t < TAPS; t++) {
        const j = i + t - TAPS / 2 + 1;
        if (j >= 0 && j < channel.length) y += channel[j] * row[t];
      }
      if (Math.abs(y) > peak) peak = Math.abs(y);
    }
  }
  return peak;
}
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;

export function measureLoudness(channels: Float32Array[], rate: number): Loudness {
  if (!channels.length || channels.length > 2) throw new Error("Loudness is measured for mono or stereo audio.");
  if (!(rate >= 8000 && rate <= 384000)) throw new Error("Sample rate is not valid.");
  const [shelf, highpass] = kWeighting(rate);
  const weighted = channels.map((ch) => filter(Float32Array.from(filter(ch, shelf)), highpass));
  // A mono file plays from both speakers, so it counts twice (BS.1770 dual mono).
  const power = (ps: number[]) => (channels.length === 1 ? ps.map((p) => p * 2) : ps);
  const momentary = power(blocks(weighted, rate, 0.4, 0.1));
  const integrated = gated(momentary, 10);
  const shortTerm = power(blocks(weighted, rate, 3, 0.1));
  const range = gated(shortTerm, 20).kept.map(lufs).sort((a, b) => a - b);
  const pick = (q: number) => range[Math.min(range.length - 1, Math.round(q * (range.length - 1)))];
  let sample = 0;
  for (const ch of channels) for (const v of ch) sample = Math.max(sample, Math.abs(v));
  const tp = Math.max(...channels.map(truePeak));
  return {
    integratedLufs: integrated.power > 0 ? round(lufs(integrated.power)) : null,
    truePeakDbtp: round(Math.max(db(tp), -120)),
    samplePeakDbfs: round(Math.max(db(sample), -120)),
    loudnessRange: range.length > 1 ? round(pick(0.95) - pick(0.1)) : null,
  };
}
// Gain (as a multiplier) that brings audio to a target loudness, for level-matched A/B.
export function gainToTarget(measured: number | null, target: number) {
  return measured === null ? 1 : 10 ** ((target - measured) / 20);
}
// Min/max pairs for drawing a waveform in `buckets` columns.
export function waveformPeaks(channels: Float32Array[], buckets: number) {
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * length) / buckets), to = Math.max(from + 1, Math.floor(((b + 1) * length) / buckets));
    let lo = 0, hi = 0;
    for (const ch of channels)
      for (let i = from; i < to && i < length; i++) {
        if (ch[i] < lo) lo = ch[i];
        if (ch[i] > hi) hi = ch[i];
      }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

// Delivery targets. Streaming services turn loud masters down rather than up,
// so the loudness check flags masters that will be turned down noticeably.
export type DeliveryTarget = { id: string; name: string; lufs: number; truePeakMax: number; tolerance: number };
export const DELIVERY_TARGETS: DeliveryTarget[] = [
  { id: "streaming", name: "Streaming (Spotify, YouTube)", lufs: -14, truePeakMax: -1, tolerance: 1 },
  { id: "apple", name: "Apple Music", lufs: -16, truePeakMax: -1, tolerance: 1 },
  { id: "broadcast", name: "Broadcast (EBU R128)", lufs: -23, truePeakMax: -1, tolerance: 0.5 },
];
export type DeliveryIssue = { level: "warning" | "problem"; text: string };
export function deliveryCheck(l: Loudness, t: DeliveryTarget): DeliveryIssue[] {
  const out: DeliveryIssue[] = [];
  if (l.truePeakDbtp > t.truePeakMax)
    out.push({ level: "problem", text: `True peak ${l.truePeakDbtp.toFixed(1)} dBTP is above ${t.truePeakMax} dBTP; it may distort when encoded.` });
  if (l.integratedLufs === null) return [...out, { level: "problem", text: "The file is silent." }];
  const diff = l.integratedLufs - t.lufs;
  if (diff > t.tolerance)
    out.push({ level: "warning", text: `${l.integratedLufs.toFixed(1)} LUFS will be turned down about ${diff.toFixed(1)} dB on ${t.name}.` });
  else if (diff < -t.tolerance)
    out.push({ level: t.id === "broadcast" ? "problem" : "warning", text: `${l.integratedLufs.toFixed(1)} LUFS is ${(-diff).toFixed(1)} dB under the ${t.lufs} LUFS target.` });
  return out;
}
