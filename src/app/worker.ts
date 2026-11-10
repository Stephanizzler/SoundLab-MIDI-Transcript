// Runs analysis off the main thread so the page stays responsive.
import { analyse, type Job, type Reply } from "./analyse.ts";

self.onmessage = (e: MessageEvent<Job>) => {
  const post = (r: Reply) => (self as unknown as Worker).postMessage(r);
  try {
    post(analyse(e.data, (value) => post({ type: "progress", value })));
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
