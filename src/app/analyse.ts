// One analysis job: a melody (notes, pitch frames) or drums (hits in groups),
// plus the loudness/brightness curve used for expression controls.
import { transcribe, type Note, type Settings } from "../engine/transcribe.ts";
import { mixToMono } from "../engine/pitch.ts";
import { detectDrums, type DrumOptions, type DrumResult } from "../engine/drums.ts";
import { expressionCurve, type ExpressionFrame } from "../engine/parts.ts";

export type Job = { mode: "melody" | "drums"; channels: Float32Array[]; rate: number; settings: Partial<Settings>; drums: Partial<DrumOptions> };
export type Frame = { time: number; hz: number; clarity: number };
export type Reply =
  | { type: "progress"; value: number }
  | { type: "done"; mode: "melody"; notes: Note[]; frames: Frame[]; expression: ExpressionFrame[] }
  | { type: "done"; mode: "drums"; drums: DrumResult; expression: ExpressionFrame[] }
  | { type: "error"; message: string };

export function analyse(job: Job, onProgress?: (f: number) => void): Reply {
  if (job.mode === "drums") {
    const drums = detectDrums(mixToMono(job.channels), job.rate, job.drums, onProgress);
    return { type: "done", mode: "drums", drums, expression: [] };
  }
  const r = transcribe(job.channels, job.rate, job.settings, (f) => onProgress?.(f * 0.9));
  const expression = expressionCurve(mixToMono(job.channels), job.rate);
  onProgress?.(1);
  return { type: "done", mode: "melody", notes: r.notes, frames: r.frames.map(({ time, hz, clarity }) => ({ time, hz, clarity })), expression };
}
