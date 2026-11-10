import assert from "node:assert/strict";
import { transcribe } from "../src/engine/transcribe.ts";
import { detectKey, snapToKey, keyName, inKey } from "../src/engine/scale.ts";
import { pitchBends, harmonize, chordNotes, bassNotes, expressionCurve, expressionControls } from "../src/engine/parts.ts";
import { detectDrums, drumNotes } from "../src/engine/drums.ts";
import { writeMidiTracks, readMidi } from "../src/engine/midi.ts";
import { renderNotes, renderDrums } from "../src/engine/audio.ts";
import { midiToHz } from "../src/engine/pitch.ts";

const n = (pitch, start, end, extra = {}) => ({ pitch, start, end, velocity: 100, ...extra });

// Key detection: an A natural minor melody, and C major.
const aMinor = [57, 60, 64, 62, 60, 59, 57, 64, 65, 64, 62, 60, 59, 57, 52, 57].map((p, i) => n(p, i * 0.3, i * 0.3 + 0.28));
assert.equal(keyName(detectKey(aMinor)), "A minor");
const cMajor = [60, 62, 64, 65, 67, 65, 64, 62, 60, 67, 64, 60].map((p, i) => n(p, i * 0.3, i * 0.3 + 0.28));
assert.equal(keyName(detectKey(cMajor)), "C major");
assert.equal(detectKey(cMajor.slice(0, 3)), null, "too few notes for a key");

// Snapping: out-of-key notes move to the nearer in-key note, using the sung pitch to break ties.
const C = { tonic: 0, scale: "major" };
const snapped = snapToKey([n(61, 0, 1, { tune: 61.3 }), n(61, 1, 2, { tune: 60.8 }), n(66, 2, 3), n(64, 3, 4)], C);
assert.deepEqual(snapped.map((x) => x.pitch), [62, 60, 65, 64]);
assert.ok(snapToKey(cMajor.map((x) => ({ ...x, pitch: x.pitch + 1 })), { tonic: 9, scale: "minor-pent" }).every((x) => inKey(x.pitch, { tonic: 9, scale: "minor-pent" })), "every note lands in a pentatonic scale");

// Stickiness: a slow, wide wobble (±90 cents at 2 Hz) splits into many notes when not sticky, one when sticky.
{
  const rate = 44100, x = new Float32Array(rate * 2);
  let ph = 0;
  for (let i = 0; i < x.length; i++) { const t = i / rate; ph += (2 * Math.PI * midiToHz(64 + 0.9 * Math.sin(2 * Math.PI * 2 * t))) / rate; x[i] = 0.3 * Math.sin(ph) * Math.min(1, t / 0.01, (2 - t) / 0.01); }
  const loose = transcribe([x], rate, { stickiness: 0.3 }).notes.length, sticky = transcribe([x], rate, { stickiness: 1.2 }).notes.length;
  assert.ok(loose > 3 && sticky === 1, `stickiness: loose ${loose}, sticky ${sticky}`);
  // Pitch bend follows the vibrato around the note's centre, within the range.
  const r = transcribe([x], rate, { stickiness: 1.2 });
  const bends = pitchBends(r.notes, r.frames, { range: 2, minClarity: 0.8 });
  const peak = Math.max(...bends.map((b) => Math.abs(b.semitones)));
  assert.ok(peak > 0.7 && peak < 1.1, `vibrato depth ${peak}`);
  assert.equal(bends[bends.length - 1].semitones, 0, "bend returns to centre after the note");
}

// Chords: a C major melody gets diatonic chords; passing notes don't change the chord.
{
  const mel = [n(60, 0, 1), n(62, 1, 1.1), n(65, 1.1, 2), n(67, 2, 3), n(69, 3, 4)];
  const ch = harmonize(mel, C);
  assert.deepEqual(ch.map((c) => c.name), ["C", "F", "G", "Am"]);
  assert.deepEqual(ch[0].tones, [48, 52, 55]);
  assert.equal(ch[0].end, ch[1].start, "chords hold until the next one");
  assert.deepEqual(harmonize(mel, C, { style: "sevenths", voicing: "close", octave: 0, minSeconds: 0.2 }).map((c) => c.name), ["Cmaj7", "Fmaj7", "G7", "Am7"]);
  assert.deepEqual(harmonize([n(71, 0, 1)], C).map((c) => c.name), ["Bdim"]);
  assert.equal(chordNotes(ch).length, 12);
  assert.deepEqual(bassNotes(ch).map((b) => b.pitch), [36, 41, 43, 33], "bass stays in E1–G2");
  // A minor pentatonic melody borrows chords from A minor.
  assert.deepEqual(harmonize([n(57, 0, 1), n(60, 1, 2), n(64, 2, 3)], { tonic: 9, scale: "minor-pent" }).map((c) => c.name), ["Am", "C", "Em"]);
}

// Expression: loudness rises -> CC11 rises; brightness follows the tone.
{
  const rate = 48000, x = new Float32Array(rate);
  for (let i = 0; i < x.length; i++) { const t = i / rate; x[i] = 0.5 * t * (t < 0.5 ? Math.sin(2 * Math.PI * 300 * t) : Math.sin(2 * Math.PI * 3000 * t)); }
  const cc = expressionControls(expressionCurve(x, rate), { loudness: true, brightness: true });
  const vol = cc.filter((c) => c.cc === 11), br = cc.filter((c) => c.cc === 74);
  assert.ok(vol[vol.length - 1].value > vol[2].value + 40, "CC11 rises with loudness");
  const early = br.find((c) => c.time > 0.3).value, late = br.find((c) => c.time > 0.8).value;
  assert.ok(late > early + 30, `CC74 rises with brightness (${early} -> ${late})`);
}

// Drums: a kick / snare / hat pattern is found, grouped into three and named.
{
  const rate = 44100, pattern = [];
  for (let bar = 0; bar < 4; bar++) for (let s = 0; s < 8; s++) {
    const t = 0.2 + bar * 2 + s * 0.25;
    pattern.push(n(42, t, t + 0.05, { velocity: 80 }));
    if (s === 0 || s === 5) pattern.push(n(36, t, t + 0.1));
    if (s === 2 || s === 6) pattern.push(n(38, t, t + 0.1));
  }
  // Kick and snare on their own beats only (hats between), like a beatboxer.
  const solo = pattern.filter((p) => p.pitch !== 42 || !pattern.some((q) => q !== p && Math.abs(q.start - p.start) < 0.01));
  const audio = renderDrums(solo, rate);
  const r = detectDrums(audio, rate);
  assert.equal(r.groups.length, 3, `groups: ${JSON.stringify(r.groups)}`);
  const found = drumNotes(r);
  assert.equal(found.length, solo.length, `found ${found.length} hits of ${solo.length}`);
  solo.sort((a, b) => a.start - b.start).forEach((p, i) => {
    assert.ok(Math.abs(found[i].start - p.start) < 0.02, `hit ${i} at ${found[i].start.toFixed(3)} wanted ${p.start}`);
    assert.equal(found[i].pitch, p.pitch, `hit ${i} is ${p.pitch}`);
  });
  assert.equal(detectDrums(new Float32Array(rate), rate).hits.length, 0, "silence has no hits");
  // One repeated sound stays one group.
  const claps = detectDrums(renderDrums([0.2, 0.7, 1.2, 1.7].map((t) => n(38, t, t + 0.1)), rate), rate);
  assert.equal(claps.groups.length, 1);
  assert.equal(claps.hits.length, 4);
}

// Multi-part MIDI: channels, bends with range, controls, drums on channel 10.
{
  const bytes = writeMidiTracks({ bpm: 100, name: "Song", tracks: [
    { name: "Melody", channel: 0, program: 73, notes: [n(64, 0, 1)], bends: [{ time: 0, semitones: 0 }, { time: 0.5, semitones: 1 }], bendRange: 2, controls: [{ time: 0.2, cc: 11, value: 90 }] },
    { name: "Chords", channel: 1, program: 48, notes: [n(48, 0, 1), n(52, 0, 1), n(55, 0, 1)] },
    { name: "Drums", channel: 9, notes: [n(36, 0, 0.1)] },
  ] });
  const back = readMidi(bytes);
  assert.equal(back.tracks.length, 3);
  assert.deepEqual(back.tracks.map((t) => [t.name, t.channel, t.notes.length]), [["Melody", 0, 1], ["Chords", 1, 3], ["Drums", 9, 1]]);
  assert.deepEqual(back.tracks[0].bends.map((b) => b.value), [8192, 12288], "+1 semitone of a ±2 range");
  assert.ok(back.tracks[0].controls.some((c) => c.cc === 6 && c.value === 2), "bend range is set (RPN 0)");
  assert.ok(back.tracks[0].controls.some((c) => c.cc === 11 && c.value === 90));
  assert.throws(() => writeMidiTracks({ bpm: 100, name: "x", tracks: [] }), /parts/);
}
console.log("parts tests passed");
