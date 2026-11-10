// How SoundLab Transcribe saves into a .soundlab project (SPEC.md rules 1–3):
// it never edits the version it listened to. It adds the .mid file and a
// rendered preview of it, then a new version based on the source version.
import {
  addAsset, addSong, addVersion, createProject, findVersion, measureLoudness, setAppSettings,
  type AppId, type Clock, type Project,
} from "../core/index.ts";
import { MIDI_MIME } from "./midi.ts";
import { writeWav, type Pcm } from "./audio.ts";

export const APP_ID: AppId = "soundlab.transcribe";
export const SETTINGS_SCHEMA = 1;

export type TranscribeRecord = {
  range: string;
  settings: Record<string, number>;
  bpm: number;
  quantize: { division: number; strength: number };
  program: number;
  notes: number;
  edited: boolean; // notes were changed by hand after transcribing
  // Added in 0.2; optional so records from 0.1 still read.
  extras?: {
    key?: { tonic: number | null; scale: string }; // tonic null = detected
    snap?: boolean; bend?: boolean; chords?: boolean; bass?: boolean; chordStyle?: string; voicing?: string;
    ccLoud?: boolean; ccBright?: boolean; drumNotes?: number[];
  };
};

const audioMime = (name: string) =>
  /\.wav$/i.test(name) ? "audio/wav" : /\.mp3$/i.test(name) ? "audio/mpeg" : /\.(m4a|aac|mp4)$/i.test(name) ? "audio/mp4" : /\.flac$/i.test(name) ? "audio/flac" : /\.ogg$/i.test(name) ? "audio/ogg" : "application/octet-stream";

// Starts a project from a loose audio file so the transcription has somewhere to live.
export function projectFromAudio(c: Clock, x: { title: string; ownerName: string; fileName: string; bytes: Uint8Array; pcm: Pcm }) {
  let project = createProject(c, x.title || "Untitled", { name: x.ownerName || "Owner" });
  const me = project.members[0].id;
  const s = addSong(project, c, x.title || "Untitled"); project = s.project;
  const a = addAsset(project, c, {
    kind: "audio", name: x.fileName, mime: audioMime(x.fileName), bytes: x.bytes.length, createdBy: me,
    audio: { sampleRate: x.pcm.rate, channels: x.pcm.channels.length, durationSeconds: x.pcm.channels[0].length / x.pcm.rate, loudness: loudnessOf(x.pcm) },
  });
  project = a.project;
  const v = addVersion(project, c, s.song.id, { stage: "demo", assetId: a.asset.id, createdBy: me, description: "Original recording", source: { app: APP_ID } });
  const files = new Map([[a.asset.id, x.bytes]]);
  return { project: v.project, files, songId: s.song.id, versionId: v.version.id };
}

function loudnessOf(pcm: Pcm) {
  const ch = pcm.channels.length > 2 ? pcm.channels.slice(0, 2) : pcm.channels;
  return measureLoudness(ch, pcm.rate);
}

export const midiCount = (p: Project) => p.songs.flatMap((s) => s.versions).filter((v) => v.source.app === APP_ID && v.label.startsWith("MIDI")).length;

export function saveTranscription(
  project: Project,
  files: Map<string, Uint8Array>,
  c: Clock,
  x: { basedOn: string; memberId: string; midi: Uint8Array; preview: Float32Array; rate: number; record: TranscribeRecord; description?: string },
) {
  const found = findVersion(project, x.basedOn);
  if (!found) throw new Error("The version this was transcribed from is not in the project.");
  const label = `MIDI ${midiCount(project) + 1}`;
  const base = `${found.song.title} ${label}`.replace(/[^\w .()-]+/g, "").trim();
  const midi = addAsset(project, c, { kind: "midi", name: `${base}.mid`, mime: MIDI_MIME, bytes: x.midi.length, createdBy: x.memberId });
  let p = midi.project;
  const wav = writeWav([x.preview], x.rate, 24);
  const preview = addAsset(p, c, {
    kind: "audio", name: `${base} preview.wav`, mime: "audio/wav", bytes: wav.length, createdBy: x.memberId,
    audio: { sampleRate: x.rate, channels: 1, durationSeconds: x.preview.length / x.rate, loudness: measureLoudness([x.preview], x.rate) },
  });
  p = preview.project;
  const v = addVersion(p, c, found.song.id, {
    stage: "stems",
    label,
    assetId: preview.asset.id,
    stemIds: [midi.asset.id],
    createdBy: x.memberId,
    description: x.description ?? `${x.record.notes} notes transcribed from ${found.version.label}. The audio is a plain synth preview; the MIDI file is the result.`,
    source: { app: APP_ID, basedOn: x.basedOn, settings: { app: APP_ID, schema: SETTINGS_SCHEMA, data: x.record } },
  });
  p = setAppSettings(v.project, c, { app: APP_ID, schema: SETTINGS_SCHEMA, data: { last: x.record } });
  const out = new Map(files);
  out.set(midi.asset.id, x.midi);
  out.set(preview.asset.id, wav);
  return { project: p, files: out, version: v.version, midiAssetId: midi.asset.id };
}
