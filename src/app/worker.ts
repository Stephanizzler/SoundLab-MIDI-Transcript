// Runs transcription off the main thread so the page stays responsive.
import { transcribe, type Settings } from "../engine/transcribe.ts";

export type Job = { channels: Float32Array[]; rate: number; settings: Partial<Settings> };
export type Reply =
  | { type: "progress"; value: number }
  | { type: "done"; notes: ReturnType<typeof transcribe>["notes"]; frames: { time: number; hz: number; clarity: number }[] }
  | { type: "error"; message: string };

self.onmessage = (e: MessageEvent<Job>) => {
  const post = (r: Reply) => (self as unknown as Worker).postMessage(r);
  try {
    const r = transcribe(e.data.channels, e.data.rate, e.data.settings, (value) => post({ type: "progress", value }));
    post({ type: "done", notes: r.notes, frames: r.frames.map(({ time, hz, clarity }) => ({ time, hz, clarity })) });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
