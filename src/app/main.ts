import { color } from "../core/design.ts";
import { measureLoudness, readBundle, writeBundle, findAsset, owner, BUNDLE_MIME, type Project, type Loudness } from "../core/index.ts";
import { transcribe, RANGES, DEFAULT_SETTINGS, quantize, guessKey, noteName, type Note, type Settings } from "../engine/transcribe.ts";
import { hzToMidi } from "../engine/pitch.ts";
import { writeMidi, readMidi, PROGRAMS, MIDI_MIME } from "../engine/midi.ts";
import { renderNotes, writeWav } from "../engine/audio.ts";
import { projectFromAudio, saveTranscription, APP_ID, type TranscribeRecord } from "../engine/projectio.ts";
import { openAudio, type Opened } from "./decode.ts";
import type { Reply } from "./worker.ts";
import TranscribeWorker from "./worker.ts?worker&inline";
import { zipOne } from "./zipone.ts";

// Design tokens -> CSS variables, so the page matches the other Pro apps.
for (const [k, v] of Object.entries(color)) document.documentElement.style.setProperty(`--${k}`, v);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = { now: () => new Date().toISOString(), id: () => crypto.randomUUID() };

type Frame = { time: number; hz: number; clarity: number };
type Loaded = { name: string; bytes: Uint8Array; pcm: Opened | null; loudness: Loudness | null };
type ProjectState = { project: Project; files: Map<string, Uint8Array>; songId: string; versionId: string; fileName: string };

const state = {
  source: null as Loaded | null,
  project: null as ProjectState | null,
  frames: [] as Frame[],
  notes: [] as Note[],
  history: [] as Note[][],
  edited: false,
  selected: -1,
  playhead: 0,
  mode: "original" as "original" | "midi" | "both",
  playing: null as null | { ctx: AudioContext; nodes: AudioBufferSourceNode[]; startedAt: number; from: number },
  previewDirty: true,
  preview: null as { buffer: AudioBuffer; lufs: number | null } | null,
};

// ---------- settings ----------
const rangeSel = $<HTMLSelectElement>("range");
for (const r of RANGES) rangeSel.add(new Option(`${r.name} (${Math.round(r.minHz)}–${Math.round(r.maxHz)} Hz)`, r.id));
const programSel = $<HTMLSelectElement>("program");
for (const p of PROGRAMS) programSel.add(new Option(p.name, String(p.program)));
const bind = (id: string, out: string, fmt: (v: number) => string) => {
  const input = $<HTMLInputElement>(id), o = $<HTMLOutputElement>(out);
  const show = () => (o.value = fmt(Number(input.value)));
  input.addEventListener("input", show);
  show();
  return input;
};
const clarity = bind("clarity", "clarityOut", (v) => `${Math.round(((0.95 - v) / 0.35) * 100)}%`);
const gate = bind("gate", "gateOut", (v) => `${v} dB`);
const minLen = bind("minLen", "minLenOut", (v) => `${v} ms`);
const strength = bind("strength", "strengthOut", (v) => `${Math.round(v * 100)}%`);
const splitBox = $<HTMLInputElement>("split");
const bpmInput = $<HTMLInputElement>("bpm"), gridSel = $<HTMLSelectElement>("grid"), zoom = $<HTMLInputElement>("zoom");

function settings(): Partial<Settings> & { range: string } {
  const r = RANGES.find((x) => x.id === rangeSel.value) ?? RANGES[0];
  return {
    range: r.id, minHz: r.minHz, maxHz: r.maxHz, minClarity: Number(clarity.value), gateDb: Number(gate.value),
    minNoteSeconds: Number(minLen.value) / 1000, attackDb: splitBox.checked ? DEFAULT_SETTINGS.attackDb : 0,
  };
}
function restoreSettings(rec: Partial<TranscribeRecord> | undefined) {
  if (!rec) return;
  if (rec.range && RANGES.some((r) => r.id === rec.range)) rangeSel.value = rec.range;
  const s = rec.settings ?? {};
  const set = (input: HTMLInputElement, v: unknown) => { if (typeof v === "number" && Number.isFinite(v)) { input.value = String(v); input.dispatchEvent(new Event("input")); } };
  set(clarity, s.minClarity); set(gate, s.gateDb);
  if (typeof s.minNoteSeconds === "number") set(minLen, Math.round(s.minNoteSeconds * 1000));
  if (typeof s.attackDb === "number") splitBox.checked = s.attackDb > 0;
  if (rec.quantize) { gridSel.value = String(rec.quantize.division); set(strength, rec.quantize.strength); }
  if (typeof rec.program === "number") programSel.value = String(rec.program);
}

// ---------- messages ----------
function showError(e: unknown) {
  const el = $("error");
  el.textContent = e ? (e instanceof Error ? e.message : String(e)) : "";
  el.hidden = !e;
}
function showNote(text?: string) { const el = $("note"); el.textContent = text ?? ""; el.hidden = !text; }
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
function readouts(el: HTMLElement, items: [string, string][]) {
  el.replaceChildren(...items.map(([k, v]) => { const d = document.createElement("div"); d.innerHTML = "<dt></dt><dd></dd>"; d.children[0].textContent = k; d.children[1].textContent = v; return d; }));
  el.hidden = false;
}

// ---------- opening files ----------
const fileInput = $<HTMLInputElement>("file"), drop = $("drop");
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; if (f) openFile(f.name, f); fileInput.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files[0]; if (f) openFile(f.name, f); });
$("demo").addEventListener("click", () => {
  // A short tune rendered by the preview synth, with a little vibrato-free swing.
  const tune = [64, 62, 60, 62, 64, 64, 64, 62, 62, 62, 64, 67, 67];
  const lens = [1, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 2];
  let t = 0.25;
  const notes = tune.map((p, i) => { const n = { pitch: p, start: t, end: t + lens[i] * 0.3 - 0.04, velocity: 70 + ((i * 37) % 50) }; t += lens[i] * 0.3; return n; });
  const audio = renderNotes(notes, 48000);
  openFile("Sample melody.wav", new Blob([writeWav([audio], 48000, 24)]));
});

async function openFile(name: string, blob: Blob) {
  showError(null); showNote();
  stop();
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (/\.soundlab$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return openProject(name, bytes);
    state.project = null;
    $("projectPick").hidden = true;
    if (/\.midi?$/i.test(name) || String.fromCharCode(...bytes.subarray(0, 4)) === "MThd") return openMidi(name, bytes);
    await loadAudio(name, bytes);
  } catch (e) { showError(e); }
}

async function loadAudio(name: string, bytes: Uint8Array) {
  $("status").textContent = "Opening…";
  const pcm = await openAudio(name, bytes);
  const seconds = pcm.channels[0].length / pcm.rate;
  if (seconds > 20 * 60) throw new Error("Files up to 20 minutes can be transcribed on this device.");
  let loudness: Loudness | null = null;
  try { loudness = measureLoudness(pcm.channels.slice(0, 2), pcm.rate); } catch { /* very short files */ }
  state.source = { name, bytes, pcm, loudness };
  state.notes = []; state.frames = []; state.history = []; state.selected = -1; state.playhead = 0; state.edited = false; state.previewDirty = true;
  readouts($("info"), [
    ["File", name],
    ["Sample rate", `${(pcm.rate / 1000).toLocaleString()} kHz`],
    ["Bit depth", pcm.float ? `${pcm.bits}-bit float` : `${pcm.bits}-bit`],
    ["Channels", pcm.channels.length === 1 ? "Mono" : pcm.channels.length === 2 ? "Stereo" : String(pcm.channels.length)],
    ["Length", fmtTime(seconds)],
    ["Loudness", loudness?.integratedLufs != null ? `${loudness.integratedLufs.toFixed(1)} LUFS` : "—"],
  ]);
  showNote(pcm.note);
  $("status").textContent = "";
  $<HTMLButtonElement>("run").disabled = false;
  $("result").hidden = true;
  $<HTMLInputElement>("trackName").value = name.replace(/\.[^.]+$/, "").slice(0, 60);
  updateProjectHint();
}

function openMidi(name: string, bytes: Uint8Array) {
  const song = readMidi(bytes);
  if (!song.notes.length) throw new Error("This MIDI file has no notes.");
  state.source = { name, bytes, pcm: null, loudness: null };
  state.notes = song.notes; state.frames = []; state.history = []; state.selected = -1; state.playhead = 0; state.edited = false; state.previewDirty = true;
  bpmInput.value = String(song.bpm);
  gridSel.value = "0";
  if (PROGRAMS.some((p) => p.program === song.program)) programSel.value = String(song.program);
  $<HTMLInputElement>("trackName").value = song.name || name.replace(/\.[^.]+$/, "");
  readouts($("info"), [["File", name], ["Notes", String(song.notes.length)], ["Tempo", `${song.bpm} BPM`]]);
  showNote("MIDI file opened: you can edit the notes, change the instrument and export again. There is no recording to compare against.");
  $<HTMLButtonElement>("run").disabled = true;
  showResult();
}

async function openProject(name: string, bytes: Uint8Array) {
  const { project, files } = await readBundle(bytes); // validates with problems() before anything is used
  const songs = project.songs.filter((s) => s.versions.some((v) => findAsset(project, v.assetId)?.audio));
  if (!songs.length) throw new Error("This project has no audio versions to transcribe.");
  const songSel = $<HTMLSelectElement>("song"), verSel = $<HTMLSelectElement>("version");
  songSel.replaceChildren(...songs.map((s) => new Option(s.title, s.id)));
  const fillVersions = () => {
    const s = songs.find((x) => x.id === songSel.value)!;
    const isPreview = (v: (typeof s.versions)[number]) => v.source.app === APP_ID && v.label.startsWith("MIDI");
    const list = [...s.versions].reverse();
    verSel.replaceChildren(...list.map((v) => new Option(`${v.label}${isPreview(v) ? " (preview)" : ""} · ${findAsset(project, v.assetId)?.name ?? ""}`, v.id)));
    // Start from the newest real recording, not one of this app's previews.
    const first = list.find((v) => !isPreview(v));
    if (first) verSel.value = first.id;
  };
  const pick = async () => {
    showError(null);
    try {
      const s = songs.find((x) => x.id === songSel.value)!, v = s.versions.find((x) => x.id === verSel.value)!;
      const asset = findAsset(project, v.assetId)!;
      state.project = { project: state.project?.project.id === project.id ? state.project.project : project, files: state.project?.project.id === project.id ? state.project.files : files, songId: s.id, versionId: v.id, fileName: name };
      await loadAudio(asset.name, files.get(asset.id)!);
      readouts($("info"), [["Project", project.title], ["Version", `${s.title} · ${v.label}`], ...[...$("info").querySelectorAll("div")].map((d) => [d.children[0].textContent!, d.children[1].textContent!] as [string, string])]);
    } catch (e) { showError(e); }
  };
  songSel.onchange = () => { fillVersions(); pick(); };
  verSel.onchange = pick;
  state.project = null;
  fillVersions();
  $("projectPick").hidden = false;
  if (project.bpm) bpmInput.value = String(project.bpm);
  restoreSettings((project.apps[APP_ID]?.data as { last?: TranscribeRecord } | undefined)?.last);
  await pick();
}

// ---------- transcribing ----------
let worker: Worker | null = null;
$("run").addEventListener("click", () => {
  const src = state.source;
  if (!src?.pcm) return;
  stop();
  worker?.terminate();
  const pcm = src.pcm, opts = settings();
  const progress = $<HTMLProgressElement>("progress"), status = $("status"), run = $<HTMLButtonElement>("run");
  progress.hidden = false; progress.value = 0; run.disabled = true; status.textContent = "Listening…";
  const started = performance.now();
  const finish = (r: Reply) => {
    if (r.type === "progress") { progress.value = r.value; return; }
    progress.hidden = true; run.disabled = false; worker?.terminate(); worker = null;
    if (r.type === "error") { status.textContent = ""; showError(r.message); return; }
    state.notes = r.notes; state.frames = r.frames; state.history = []; state.selected = -1; state.edited = false; state.previewDirty = true;
    status.textContent = `${r.notes.length} notes in ${((performance.now() - started) / 1000).toFixed(1)} s`;
    showResult();
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Some hosts (a page opened straight from a file, some in-app browsers) refuse
  // background workers. Then transcribe on the page itself; it just can't show progress.
  const inPage = () => {
    worker?.terminate(); worker = null;
    status.textContent = "Listening… (the page may pause until it's done)";
    setTimeout(() => {
      try {
        const r = transcribe(pcm.channels, pcm.rate, opts);
        finish({ type: "done", notes: r.notes, frames: r.frames.map(({ time, hz, clarity }) => ({ time, hz, clarity })) });
      } catch (e) { finish({ type: "error", message: e instanceof Error ? e.message : String(e) }); }
    }, 50);
  };
  try { worker = new TranscribeWorker(); } catch { return inPage(); }
  worker.onmessage = (e: MessageEvent<Reply>) => finish(e.data);
  worker.onerror = (e) => { e.preventDefault(); inPage(); };
  worker.postMessage({ channels: pcm.channels.map((c) => c.slice()), rate: pcm.rate, settings: opts });
});

// ---------- notes, editing ----------
const division = () => Number(gridSel.value);
const bpm = () => { const b = Number(bpmInput.value); return b >= 20 && b <= 400 ? b : 120; };
const shown = (): Note[] => (division() > 0 ? quantize(state.notes, bpm(), division(), Number(strength.value)) : state.notes);
const duration = () => Math.max(state.source?.pcm ? state.source.pcm.channels[0].length / state.source.pcm.rate : 0, ...state.notes.map((n) => n.end + 0.5), 1);

function showResult() {
  $("result").hidden = false;
  summarize();
  updateEditButtons();
  updateProjectHint();
  draw();
}
function summarize() {
  const n = state.notes;
  const lo = Math.min(...n.map((x) => x.pitch)), hi = Math.max(...n.map((x) => x.pitch));
  readouts($("summary"), [
    ["Notes", String(n.length)],
    ["Range", n.length ? `${noteName(lo)}–${noteName(hi)}` : "—"],
    ["Key hint", guessKey(n) ?? "—"],
    ["Edited", state.edited ? "Yes" : "No"],
  ]);
  if (!n.length) $("status").textContent = "No notes found. Try a lower sensitivity setting, a lower quietest-note level or a different range.";
}
function edit(fn: (notes: Note[]) => Note[]) {
  state.history.push(state.notes);
  if (state.history.length > 100) state.history.shift();
  state.notes = fn(state.notes.map((n) => ({ ...n })));
  state.edited = true; state.previewDirty = true;
  showResult();
}
function moveSelected(semitones: number) {
  const i = state.selected;
  if (i < 0) return;
  edit((ns) => { ns[i].pitch = Math.max(0, Math.min(127, ns[i].pitch + semitones)); return ns; });
}
function deleteSelected() {
  const i = state.selected;
  if (i < 0) return;
  state.selected = -1;
  edit((ns) => ns.filter((_, k) => k !== i));
}
function updateEditButtons() {
  const sel = state.notes[state.selected];
  for (const id of ["up", "down", "del"]) $<HTMLButtonElement>(id).disabled = !sel;
  $<HTMLButtonElement>("undo").disabled = !state.history.length;
  $("selection").textContent = sel ? `${noteName(sel.pitch)} · ${fmtTime(sel.start)} · ${Math.round((sel.end - sel.start) * 1000)} ms · velocity ${sel.velocity}` : "Click a note to select it. Click empty space to move the playhead.";
}
$("up").addEventListener("click", () => moveSelected(1));
$("down").addEventListener("click", () => moveSelected(-1));
$("del").addEventListener("click", deleteSelected);
$("undo").addEventListener("click", () => { const prev = state.history.pop(); if (prev) { state.notes = prev; state.selected = -1; state.previewDirty = true; showResult(); } });
for (const el of [bpmInput, gridSel, strength, zoom, $("showPitch")]) el.addEventListener("input", () => { state.previewDirty = true; draw(); });

// ---------- piano roll ----------
const roll = $("roll"), canvas = $<HTMLCanvasElement>("canvas"), spacer = $("rollSpacer");
const KEYS = 44, RULER = 18;
let geo = { lo: 48, hi: 84, row: 10, pps: 120 };
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);
let peaks: { data: Float32Array; perSec: number } | null = null;
function waveform() {
  const pcm = state.source?.pcm;
  if (!pcm) return null;
  if (peaks && (peaks as unknown as { src: Opened }).src === pcm) return peaks;
  const perSec = 200, n = Math.ceil((pcm.channels[0].length / pcm.rate) * perSec), data = new Float32Array(n);
  const step = pcm.rate / perSec;
  for (let b = 0; b < n; b++) {
    let m = 0;
    const from = Math.floor(b * step), to = Math.min(pcm.channels[0].length, Math.floor((b + 1) * step));
    for (const ch of pcm.channels.slice(0, 2)) for (let i = from; i < to; i += 4) m = Math.max(m, Math.abs(ch[i]));
    data[b] = m;
  }
  peaks = Object.assign({ data, perSec }, { src: pcm });
  return peaks;
}

function draw() {
  if ($("result").hidden) return;
  const notes = shown();
  const dpr = window.devicePixelRatio || 1;
  const w = roll.clientWidth, h = roll.clientHeight;
  const pps = Number(zoom.value);
  spacer.style.width = `${KEYS + duration() * pps}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ps = notes.map((n) => n.pitch);
  let lo = ps.length ? Math.min(...ps) - 3 : 48, hi = ps.length ? Math.max(...ps) + 3 : 84;
  while (hi - lo < 24) { lo--; hi++; }
  lo = Math.max(0, lo); hi = Math.min(127, hi);
  const row = (h - RULER) / (hi - lo + 1);
  geo = { lo, hi, row, pps };
  const sx = roll.scrollLeft;
  const X = (t: number) => KEYS + t * pps - sx;
  const Y = (p: number) => RULER + (hi - p) * row;
  const t0 = sx / pps, t1 = (sx + w) / pps;

  g.fillStyle = color.bg; g.fillRect(0, 0, w, h);
  for (let p = lo; p <= hi; p++) {
    g.fillStyle = isBlack(p) ? "#101317" : color.bg;
    g.fillRect(KEYS, Y(p), w, row);
    if (p % 12 === 0) { g.fillStyle = color.line; g.fillRect(KEYS, Y(p) + row - 1, w, 1); }
  }
  // Waveform behind the notes.
  const wf = waveform();
  if (wf) {
    g.fillStyle = color.waveform; g.globalAlpha = 0.35;
    const mid = RULER + (h - RULER) / 2, amp = (h - RULER) / 2;
    for (let x = KEYS; x < w; x++) {
      const b = Math.floor(((x - KEYS + sx) / pps) * wf.perSec);
      const v = wf.data[b] ?? 0;
      if (v) g.fillRect(x, mid - v * amp, 1, Math.max(1, 2 * v * amp));
    }
    g.globalAlpha = 1;
  }
  // Beat and bar lines.
  const beat = 60 / bpm(), div = division();
  const step = div > 0 ? beat / div : beat;
  if (step * pps >= 6)
    for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
      const t = k * step, isBeat = Math.abs(t / beat - Math.round(t / beat)) < 1e-6, isBar = isBeat && Math.round(t / beat) % 4 === 0;
      g.fillStyle = isBar ? "#3a404b" : isBeat ? color.line : "#1a1e24";
      g.fillRect(Math.round(X(t)), RULER, 1, h - RULER);
    }
  // Detected pitch, so the user can see what the notes were made from.
  if (($("showPitch") as HTMLInputElement).checked && state.frames.length) {
    g.fillStyle = color.info; g.globalAlpha = 0.55;
    const min = Number(clarity.value);
    for (const f of state.frames) {
      if (f.time < t0 - 0.05 || f.time > t1 + 0.05 || !f.hz || f.clarity < min) continue;
      const m = hzToMidi(f.hz);
      if (m < lo - 0.5 || m > hi + 0.5) continue;
      g.fillRect(X(f.time) - 1, RULER + (hi + 0.5 - m) * row - 1, 2, 2);
    }
    g.globalAlpha = 1;
  }
  // Notes.
  notes.forEach((n, i) => {
    if (n.end < t0 || n.start > t1) return;
    const x = X(n.start), y = Y(n.pitch), wd = Math.max(2, (n.end - n.start) * pps);
    g.globalAlpha = 0.45 + 0.55 * (n.velocity / 127);
    g.fillStyle = color.accent;
    g.fillRect(x, y + 1, wd, Math.max(2, row - 2));
    g.globalAlpha = 1;
    if (i === state.selected) { g.strokeStyle = color.text; g.lineWidth = 2; g.strokeRect(x - 1, y, wd + 2, Math.max(3, row)); }
  });
  // Ruler.
  g.fillStyle = color.panel; g.fillRect(0, 0, w, RULER);
  g.fillStyle = color.muted; g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle";
  const every = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 70) ?? 120;
  for (let s = Math.floor(t0 / every) * every; s <= t1; s += every) if (X(s) >= KEYS) g.fillText(fmtTime(s).replace(/\.0$/, ""), X(s) + 3, RULER / 2);
  // Keyboard gutter.
  for (let p = lo; p <= hi; p++) {
    g.fillStyle = isBlack(p) ? "#2a2f38" : "#c9ced6";
    g.fillRect(0, Y(p), KEYS - 2, row - (row > 4 ? 1 : 0));
    if (p % 12 === 0 && row >= 7) { g.fillStyle = "#15181d"; g.font = `${Math.min(11, row + 1)}px system-ui, sans-serif`; g.fillText(noteName(p), 3, Y(p) + row / 2); }
  }
  g.fillStyle = color.panel; g.fillRect(0, 0, KEYS, RULER);
  // Playhead.
  const px = X(currentTime());
  if (px >= KEYS) { g.fillStyle = color.text; g.fillRect(Math.round(px), 0, 2, h); }
  $("clock").textContent = fmtTime(currentTime());
}
roll.addEventListener("scroll", draw);
window.addEventListener("resize", draw);
roll.addEventListener("pointerdown", (e) => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < KEYS) return;
  const t = (x - KEYS + roll.scrollLeft) / geo.pps, p = geo.hi - Math.floor((y - RULER) / geo.row);
  const notes = shown();
  const hit = y >= RULER ? notes.findIndex((n) => n.pitch === p && t >= n.start - 3 / geo.pps && t <= n.end + 3 / geo.pps) : -1;
  state.selected = hit;
  if (hit < 0) seek(Math.max(0, t));
  updateEditButtons();
  draw();
  roll.focus({ preventScroll: true });
});
roll.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") { deleteSelected(); e.preventDefault(); }
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") { moveSelected((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1)); e.preventDefault(); }
  else if (e.key === " ") { togglePlay(); e.preventDefault(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === "z") { $("undo").click(); e.preventDefault(); }
});

// ---------- playback (A/B, level-matched) ----------
let ctx: AudioContext | null = null, original: { buffer: AudioBuffer; of: Opened } | null = null;
const audioCtx = () => (ctx ??= new AudioContext());
function currentTime() {
  const p = state.playing;
  return p ? p.from + (p.ctx.currentTime - p.startedAt) : state.playhead;
}
function originalBuffer() {
  const pcm = state.source?.pcm;
  if (!pcm) return null;
  if (original?.of !== pcm) {
    const b = audioCtx().createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.rate);
    pcm.channels.forEach((c, i) => b.copyToChannel(c, i));
    original = { buffer: b, of: pcm };
  }
  return original.buffer;
}
function previewBuffer() {
  if (state.previewDirty || !state.preview) {
    const rate = state.source?.pcm?.rate ?? 48000;
    const audio = renderNotes(shown(), rate, duration());
    const b = audioCtx().createBuffer(1, audio.length, rate);
    b.copyToChannel(audio, 0);
    let lufs: number | null = null;
    try { lufs = measureLoudness([audio], rate).integratedLufs; } catch { /* empty */ }
    state.preview = { buffer: b, lufs };
    state.previewDirty = false;
  }
  return state.preview;
}
function seek(t: number) {
  const was = !!state.playing;
  stop();
  state.playhead = Math.min(t, duration());
  if (was) start();
  draw();
}
function stop() {
  if (!state.playing) return;
  state.playhead = currentTime();
  state.playing.nodes.forEach((n) => { n.onended = null; try { n.stop(); } catch { /* already stopped */ } });
  state.playing = null;
  $("play").textContent = "Play";
}
function start() {
  const c = audioCtx();
  c.resume();
  if (state.playhead >= duration() - 0.05) state.playhead = 0;
  const nodes: AudioBufferSourceNode[] = [];
  const matched = ($("match") as HTMLInputElement).checked;
  const prev = state.mode !== "original" || !state.source?.pcm ? previewBuffer() : null;
  // Level matching: bring the preview to the original's loudness.
  const origLufs = state.source?.loudness?.integratedLufs ?? null;
  const gainB = matched && prev?.lufs != null && origLufs != null ? Math.min(4, 10 ** ((origLufs - prev.lufs) / 20)) : 1;
  const play = (buffer: AudioBuffer, gain: number) => {
    const s = c.createBufferSource(), g = c.createGain();
    s.buffer = buffer; g.gain.value = gain;
    s.connect(g).connect(c.destination);
    s.start(0, state.playhead);
    nodes.push(s);
  };
  const orig = originalBuffer();
  if (orig && state.mode !== "midi") play(orig, state.mode === "both" ? 0.7 : 1);
  if (prev && (state.mode !== "original" || !orig)) play(prev.buffer, gainB * (state.mode === "both" ? 0.7 : 1));
  if (!nodes.length) return;
  state.playing = { ctx: c, nodes, startedAt: c.currentTime, from: state.playhead };
  nodes[0].onended = () => { if (state.playing?.nodes === nodes) { stop(); state.playhead = 0; draw(); } };
  $("play").textContent = "Stop";
  const tick = () => {
    if (state.playing?.nodes !== nodes) return;
    const x = KEYS + currentTime() * geo.pps - roll.scrollLeft;
    if (x > roll.clientWidth - 40 || x < KEYS) roll.scrollLeft = Math.max(0, currentTime() * geo.pps - 40);
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function togglePlay() { if (state.playing) stop(); else start(); draw(); }
$("play").addEventListener("click", togglePlay);
for (const b of document.querySelectorAll<HTMLButtonElement>(".seg")) {
  b.addEventListener("click", () => {
    state.mode = b.dataset.play as typeof state.mode;
    document.querySelectorAll(".seg").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    if (state.playing) { stop(); start(); }
  });
}
$("match").addEventListener("change", () => { if (state.playing) { stop(); start(); } });

// ---------- export ----------
type Downloads = { save: (r: { filename: string; data: Uint8Array }) => Promise<unknown> };
const claudeHost = (window as unknown as { claude?: { use: (n: string) => Promise<unknown> } }).claude;
const downloadsReady: Promise<Downloads | null> = claudeHost ? claudeHost.use("downloads").then((d) => d as Downloads | null, () => null) : Promise.resolve(null);
async function download(name: string, bytes: Uint8Array, type: string) {
  const host = await downloadsReady;
  if (host) {
    // The claude.ai viewer only saves certain file types, so the file comes inside a .zip.
    try {
      await host.save({ filename: `${name}.zip`, data: zipOne(name, bytes) });
      $("projectHint").textContent = `Saved ${name}.zip. Unzip it to get ${name}.`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "declined") showError(code === "rate_limited" ? "A save is already waiting for your answer." : "Saving files isn't available in this view.");
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const trackName = () => ($<HTMLInputElement>("trackName").value.trim() || "Transcription").slice(0, 60);
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim() || "Transcription";
function midiBytes() {
  return writeMidi({ notes: shown(), bpm: bpm(), program: Number(programSel.value), name: trackName() });
}
function record(): TranscribeRecord {
  const { range, ...s } = settings();
  return { range, settings: s as Record<string, number>, bpm: bpm(), quantize: { division: division(), strength: Number(strength.value) }, program: Number(programSel.value), notes: state.notes.length, edited: state.edited };
}
$("saveMidi").addEventListener("click", () => {
  showError(null);
  try {
    if (!state.notes.length) throw new Error("There are no notes to export.");
    download(`${safeName(trackName())}.mid`, midiBytes(), MIDI_MIME);
  } catch (e) { showError(e); }
});
$("saveProject").addEventListener("click", () => {
  showError(null);
  try {
    const src = state.source;
    if (!src?.pcm) throw new Error("Projects need the recording the notes came from. Open an audio file or a .soundlab project.");
    if (!state.notes.length) throw new Error("There are no notes to save.");
    let ps = state.project;
    if (!ps) {
      const title = src.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Untitled";
      const r = projectFromAudio(clock, { title, ownerName: "Owner", fileName: src.name, bytes: src.bytes, pcm: src.pcm });
      ps = { project: r.project, files: r.files, songId: r.songId, versionId: r.versionId, fileName: `${safeName(title)}.soundlab` };
    }
    const preview = renderNotes(shown(), src.pcm.rate, duration());
    const saved = saveTranscription(ps.project, ps.files, clock, {
      basedOn: ps.versionId, memberId: owner(ps.project).id, midi: midiBytes(), preview, rate: src.pcm.rate, record: record(),
    });
    state.project = { ...ps, project: saved.project, files: saved.files };
    $("projectHint").textContent = `Saved as ${saved.version.label}, based on the version you transcribed. Your original is unchanged.`;
    download(ps.fileName.endsWith(".soundlab") ? ps.fileName : `${ps.fileName}.soundlab`, writeBundle(saved.project, saved.files), BUNDLE_MIME);
  } catch (e) { showError(e); }
});
function updateProjectHint() {
  const btn = $<HTMLButtonElement>("saveProject");
  btn.disabled = !state.source?.pcm;
  $("projectHint").textContent = !state.source?.pcm
    ? "Saving to a project needs the recording the notes came from."
    : state.project
      ? `Adds a new MIDI version to “${state.project.project.title}”, based on the version you picked. Nothing existing is changed.`
      : "Creates a project with your recording and this transcription, ready for SoundLab CoLab.";
}
