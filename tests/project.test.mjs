import assert from "node:assert/strict";
import * as P from "../src/core/index.ts";
import { projectFromAudio, saveTranscription, APP_ID } from "../src/engine/projectio.ts";
import { writeWav, readWav, renderNotes } from "../src/engine/audio.ts";
import { writeMidi, readMidi } from "../src/engine/midi.ts";

let n = 0, t = Date.parse("2026-11-10T00:00:00Z");
const clock = { id: () => `id-${++n}`, now: () => new Date((t += 1000)).toISOString() };

const notes = [{ pitch: 60, start: 0.1, end: 0.5, velocity: 100 }, { pitch: 64, start: 0.6, end: 1, velocity: 80 }];
const source = renderNotes(notes, 96000);
const wavBytes = writeWav([source, source], 96000, 24);
const pcm = readWav(wavBytes);

// A loose file becomes a project with the recording as Demo 1, at its own rate.
let r = projectFromAudio(clock, { title: "Riff", ownerName: "Steph", fileName: "riff.wav", bytes: wavBytes, pcm });
assert.deepEqual(P.problems(r.project), []);
const original = P.findAsset(r.project, P.findVersion(r.project, r.versionId).version.assetId);
assert.equal(original.audio.sampleRate, 96000);
assert.equal(original.audio.channels, 2);
assert.ok(original.audio.loudness.integratedLufs < 0);

// Saving adds a new version based on the source; the source is untouched.
const before = JSON.stringify(P.findVersion(r.project, r.versionId).version);
const midi = writeMidi({ notes, bpm: 120, program: 0, name: "Riff" });
const record = { range: "any", settings: { minHz: 50 }, bpm: 120, quantize: { division: 0, strength: 1 }, program: 0, notes: 2, edited: false };
const s = saveTranscription(r.project, r.files, clock, { basedOn: r.versionId, memberId: P.owner(r.project).id, midi, preview: renderNotes(notes, 96000), rate: 96000, record });
assert.deepEqual(P.problems(s.project), []);
assert.equal(JSON.stringify(P.findVersion(s.project, r.versionId).version), before, "source version unchanged");
assert.equal(s.version.label, "MIDI 1");
assert.equal(s.version.source.app, APP_ID);
assert.equal(s.version.source.basedOn, r.versionId);
assert.deepEqual(s.version.source.settings, { app: APP_ID, schema: 1, data: record });
assert.equal(P.findAsset(s.project, s.midiAssetId).kind, "midi");
assert.deepEqual(P.unusedAssets(s.project), [], "the MIDI file stays referenced");
assert.deepEqual(s.project.apps[APP_ID].data.last, record);

// A second save counts on; the bundle round-trips with every file intact.
const s2 = saveTranscription(s.project, s.files, clock, { basedOn: r.versionId, memberId: P.owner(r.project).id, midi, preview: renderNotes(notes, 96000), rate: 96000, record });
assert.equal(s2.version.label, "MIDI 2");
const back = await P.readBundle(P.writeBundle(s2.project, s2.files));
assert.deepEqual(back.project, s2.project);
assert.deepEqual(readMidi(back.files.get(s2.midiAssetId)).notes.map((x) => x.pitch), [60, 64]);
assert.throws(() => saveTranscription(s.project, s.files, clock, { basedOn: "nope", memberId: "x", midi, preview: source, rate: 96000, record }), /not in the project/);
console.log("project tests passed");
