// Keys and scales: detecting the key of a melody and snapping notes to it.
import { NAMES, type Note } from "./transcribe.ts";

export const SCALES: Record<string, { name: string; steps: number[] }> = {
  major: { name: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: "Minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonic: { name: "Harmonic minor", steps: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
  "major-pent": { name: "Major pentatonic", steps: [0, 2, 4, 7, 9] },
  "minor-pent": { name: "Minor pentatonic", steps: [0, 3, 5, 7, 10] },
  blues: { name: "Blues", steps: [0, 3, 5, 6, 7, 10] },
};
export type Key = { tonic: number; scale: string };
export const keyName = (k: Key) => `${NAMES[k.tonic]} ${SCALES[k.scale]?.name.toLowerCase() ?? k.scale}`;
export const inKey = (pitch: number, k: Key) => SCALES[k.scale].steps.includes((((pitch - k.tonic) % 12) + 12) % 12);

// Krumhansl–Kessler key profiles, correlated with how long each pitch class sounds.
export function detectKey(notes: Note[]): (Key & { confidence: number }) | null {
  if (notes.length < 8) return null;
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[((n.pitch % 12) + 12) % 12] += n.end - n.start;
  const profiles: [string, number[]][] = [
    ["major", [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]],
    ["minor", [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]],
  ];
  const corr = (profile: number[], tonic: number) => {
    const xs = profile.map((_, i) => weight[(i + tonic) % 12]);
    const mx = xs.reduce((a, b) => a + b) / 12, mp = profile.reduce((a, b) => a + b) / 12;
    let num = 0, dx = 0, dp = 0;
    for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (profile[i] - mp); dx += (xs[i] - mx) ** 2; dp += (profile[i] - mp) ** 2; }
    return dx && dp ? num / Math.sqrt(dx * dp) : 0;
  };
  let best = { tonic: 0, scale: "major", confidence: -Infinity };
  for (let t = 0; t < 12; t++) for (const [scale, prof] of profiles) {
    const r = corr(prof, t);
    if (r > best.confidence) best = { tonic: t, scale, confidence: r };
  }
  return { ...best, confidence: Math.round(best.confidence * 100) / 100 };
}
export function guessKey(notes: Note[]): string | null {
  const k = detectKey(notes);
  return k ? keyName(k) : null;
}

// Moves out-of-key notes to the nearest note in the key. When two are equally
// near, the note's sung pitch (`tune`) decides; otherwise it moves down.
export function snapToKey(notes: Note[], k: Key): Note[] {
  return notes.map((n) => {
    if (inKey(n.pitch, k)) return n;
    const up = n.pitch + 1, down = n.pitch - 1;
    const upIn = inKey(up, k), downIn = inKey(down, k);
    let to = n.pitch;
    if (upIn && downIn) to = (n.tune ?? n.pitch) > n.pitch ? up : down;
    else if (upIn) to = up;
    else if (downIn) to = down;
    else to = inKey(n.pitch + 2, k) ? n.pitch + 2 : n.pitch - 2; // pentatonic gaps
    return { ...n, pitch: Math.max(0, Math.min(127, to)) };
  });
}
// The notes of the key from `low` to `high`, for drawing in-key rows.
export const scaleDegree = (pitch: number, k: Key) => SCALES[k.scale].steps.indexOf((((pitch - k.tonic) % 12) + 12) % 12);
