// Frame-by-frame pitch tracking with YIN (de Cheveigné & Kawahara, 2002).
// The difference function is computed with FFT cross-correlation, so long files
// stay fast. Works at the file's own sample rate.
import { fft, nextPow2 } from "./fft.ts";

export type PitchFrame = {
  time: number; // seconds, centre of the analysis window
  hz: number; // 0 when no pitch was found
  clarity: number; // 0..1, how periodic the frame is (1 = a pure tone)
  db: number; // frame level in dBFS (RMS)
};
export type PitchOptions = { minHz: number; maxHz: number; hopSeconds: number; threshold: number };
export const DEFAULT_PITCH: PitchOptions = { minHz: 50, maxHz: 2000, hopSeconds: 0.01, threshold: 0.15 };

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

// Pitch only needs the lower part of the spectrum, so analysis runs on a
// low-passed, downsampled copy (the user's audio is never changed).
export function analysisCopy(x: Float32Array, rate: number, maxHz: number): { x: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(rate / Math.max(11000, 5 * maxHz)));
  if (factor === 1) return { x, rate };
  const cutoff = 0.45 / factor, taps = 16 * factor + 1, half = (taps - 1) / 2;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - half, sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
    h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))); // Blackman
    sum += h[i];
  }
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let j = 0; j < out.length; j++) {
    const c = j * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const at = c + i - half;
      if (at >= 0 && at < x.length) acc += x[at] * h[i];
    }
    out[j] = acc / sum;
  }
  return { x: out, rate: rate / factor };
}

export function trackPitch(input: Float32Array, inputRate: number, opts: Partial<PitchOptions> = {}, onProgress?: (f: number) => void): PitchFrame[] {
  const o = { ...DEFAULT_PITCH, ...opts };
  if (!(o.minHz > 0 && o.maxHz > o.minHz)) throw new Error("Choose a pitch range where the lowest note is below the highest.");
  const { x, rate } = analysisCopy(input, inputRate, o.maxHz);
  const tauMax = Math.min(Math.ceil(rate / o.minHz), 1 << 14);
  const tauMin = Math.max(2, Math.floor(rate / o.maxHz));
  const W = Math.max(tauMax, Math.round(rate * 0.02)); // integration window
  const N = nextPow2(2 * W + tauMax);
  const hop = Math.max(1, Math.round(rate * o.hopSeconds));
  const frames: PitchFrame[] = [];
  const re1 = new Float64Array(N), im1 = new Float64Array(N), re2 = new Float64Array(N), im2 = new Float64Array(N);
  const d = new Float64Array(tauMax + 1);
  const sq = new Float64Array(W + tauMax + 1); // prefix sums of squares of the frame
  const total = Math.max(1, Math.floor((x.length - 1) / hop));

  for (let start = 0, f = 0; start < x.length; start += hop, f++) {
    if (onProgress && f % 200 === 0) onProgress(Math.min(1, f / total));
    const get = (i: number) => (start + i < x.length ? x[start + i] : 0);
    re1.fill(0); im1.fill(0); re2.fill(0); im2.fill(0);
    sq[0] = 0;
    for (let i = 0; i < W + tauMax; i++) {
      const v = get(i);
      re2[i] = v;
      if (i < W) re1[i] = v;
      sq[i + 1] = sq[i] + v * v;
    }
    const energy = sq[W];
    const db = energy > 0 ? 10 * Math.log10(energy / W) : -120;
    const time = (start + W / 2) / rate;
    if (energy < 1e-10) { frames.push({ time, hz: 0, clarity: 0, db }); continue; }

    // c(tau) = sum a[j] b[j + tau]  ->  IFFT(conj(A) * B)
    fft(re1, im1); fft(re2, im2);
    for (let k = 0; k < N; k++) {
      const r = re1[k] * re2[k] + im1[k] * im2[k];
      const i = re1[k] * im2[k] - im1[k] * re2[k];
      re2[k] = r; im2[k] = i;
    }
    fft(re2, im2, true);
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) d[tau] = Math.max(0, energy + (sq[tau + W] - sq[tau]) - 2 * re2[tau]);

    // Cumulative mean normalised difference, then the first dip below the threshold.
    let running = 0, best = -1, bestVal = Infinity, globalTau = -1, globalVal = Infinity;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < globalVal) { globalVal = d[tau]; globalTau = tau; }
      if (best < 0 && d[tau] < o.threshold) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau; bestVal = d[tau];
      }
    }
    if (best < 0) { best = globalTau; bestVal = globalVal; }
    if (best < 0 || best >= tauMax) { frames.push({ time, hz: 0, clarity: 0, db }); continue; }
    // Parabolic interpolation around the dip for sub-sample accuracy.
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom > 0 ? (0.5 * (a - c)) / denom : 0;
    const period = best + Math.max(-1, Math.min(1, shift));
    frames.push({ time, hz: rate / period, clarity: Math.max(0, Math.min(1, 1 - bestVal)), db });
  }
  onProgress?.(1);
  return frames;
}

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
