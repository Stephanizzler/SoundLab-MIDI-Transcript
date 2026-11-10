import assert from "node:assert/strict";
import { trackPitch, hzToMidi, midiToHz } from "../src/engine/pitch.ts";
import { transcribe, quantize, guessKey, noteName } from "../src/engine/transcribe.ts";
import { writeMidi, readMidi } from "../src/engine/midi.ts";
import { readWav, writeWav, renderNotes } from "../src/engine/audio.ts";

// A melody played with harmonics, small gaps and a repeated note.
function play(notes, rate, { vibratoCents = 0, noise = 0 } = {}) {
  const end = Math.max(...notes.map((n) => n.end)) + 0.2, out = new Float32Array(Math.ceil(end * rate));
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const n of notes) {
    const from = Math.floor(n.start * rate), to = Math.floor(n.end * rate), amp = n.amp ?? 0.4;
    let ph = 0;
    for (let i = from; i < to; i++) {
      const t = (i - from) / rate, env = Math.min(1, t / 0.01) * Math.min(1, (to - i) / rate / 0.01);
      const hz = midiToHz(n.pitch) * 2 ** ((vibratoCents / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
      ph += (2 * Math.PI * hz) / rate;
      out[i] += amp * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
    }
  }
  if (noise) for (let i = 0; i < out.length; i++) out[i] += noise * rnd();
  return out;
}
const melody = [
  { pitch: 60, start: 0.1, end: 0.5 }, { pitch: 62, start: 0.55, end: 0.95 }, { pitch: 64, start: 1.0, end: 1.4 },
  { pitch: 64, start: 1.45, end: 1.85 }, { pitch: 67, start: 1.9, end: 2.6, amp: 0.15 }, { pitch: 55, start: 2.7, end: 3.2 },
];
function check(found, expected, label, tol = 0.04) {
  assert.equal(found.length, expected.length, `${label}: ${found.length} notes, wanted ${expected.length}: ${found.map((n) => noteName(n.pitch) + "@" + n.start.toFixed(2)).join(" ")}`);
  expected.forEach((e, i) => {
    const f = found[i];
    assert.equal(f.pitch, e.pitch, `${label}: note ${i} pitch`);
    assert.ok(Math.abs(f.start - e.start) <= tol, `${label}: note ${i} starts ${f.start.toFixed(3)}, wanted ${e.start}`);
    assert.ok(Math.abs(f.end - e.end) <= tol + 0.02, `${label}: note ${i} ends ${f.end.toFixed(3)}, wanted ${e.end}`);
  });
}

// Pitch tracking is accurate at different sample rates.
for (const rate of [44100, 48000, 96000]) {
  const x = play([{ pitch: 69, start: 0, end: 0.5 }], rate);
  const voiced = trackPitch(x, rate).filter((f) => f.clarity > 0.9);
  const cents = voiced.map((f) => Math.abs(hzToMidi(f.hz) - 69) * 100);
  assert.ok(voiced.length > 30 && Math.max(...cents) < 8, `A4 at ${rate} Hz within 8 cents (worst ${Math.max(...cents).toFixed(1)})`);
}
// Low bass notes (E1 = 41 Hz) with the bass range.
{
  const x = play([{ pitch: 28, start: 0.1, end: 0.8 }, { pitch: 33, start: 0.9, end: 1.5 }], 44100);
  check(transcribe([x], 44100, { minHz: 30, maxHz: 400 }).notes, [{ pitch: 28, start: 0.1, end: 0.8 }, { pitch: 33, start: 0.9, end: 1.5 }], "bass", 0.05);
}
// A melody, including a repeated note and a quieter note.
{
  const r = transcribe([play(melody, 48000)], 48000);
  check(r.notes, melody, "melody");
  assert.ok(r.notes[4].velocity < r.notes[3].velocity - 10, "quieter note gets a lower velocity");
}
// Stereo input, vibrato and light noise still give the same notes.
{
  const x = play(melody, 44100, { vibratoCents: 30, noise: 0.01 });
  check(transcribe([x, x], 44100).notes, melody, "vibrato + noise");
}
// Legato: same pitch re-played without a gap is split by its attack.
{
  const legato = [{ pitch: 65, start: 0.1, end: 0.6, amp: 0.4 }, { pitch: 65, start: 0.6, end: 1.1, amp: 0.4 }];
  const x = play([{ pitch: 65, start: 0.1, end: 0.6, amp: 0.4 }], 44100);
  const y = play([{ pitch: 65, start: 0.6, end: 1.1, amp: 0.4 }], 44100);
  const z = new Float32Array(Math.max(x.length, y.length)); x.forEach((v, i) => (z[i] += v * 0.15)); y.forEach((v, i) => (z[i] += v));
  // first note quiet (decayed), second re-attacked loudly
  const notes = transcribe([z], 44100).notes;
  assert.equal(notes.length, 2, "re-attacked note is split: " + JSON.stringify(notes));
}
// Quick repeats with short gaps (the preview synth's release overlaps the gap) are split.
{
  const tune = [64, 62, 60, 62, 64, 64, 64, 62, 62, 62, 64, 67, 67], lens = [1, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 2];
  let t = 0.25;
  const notes = tune.map((p, i) => { const n = { pitch: p, start: t, end: t + lens[i] * 0.3 - 0.04, velocity: 70 + ((i * 37) % 50) }; t += lens[i] * 0.3; return n; });
  assert.deepEqual(transcribe([renderNotes(notes, 48000)], 48000).notes.map((n) => n.pitch), tune);
}
// Tremolo (±2.5 dB at 6 Hz) on a held note does not split it.
{
  const rate = 44100, x = new Float32Array(rate * 2);
  for (let i = 0; i < x.length; i++) { const t = i / rate; x[i] = 0.3 * 10 ** ((2.5 * Math.sin(2 * Math.PI * 6 * t)) / 20) * Math.sin(2 * Math.PI * 330 * t) * Math.min(1, t / 0.01, (2 - t) / 0.01); }
  assert.equal(transcribe([x], rate).notes.length, 1, "tremolo stays one note");
}
// Silence gives no notes; noise alone gives no notes.
assert.equal(transcribe([new Float32Array(44100)], 44100).notes.length, 0);
{
  let seed = 7; const n = new Float32Array(44100).map(() => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3);
  assert.equal(transcribe([n], 44100).notes.length, 0, "white noise has no pitch");
}

// Quantize snaps to the grid and keeps notes at least one step long.
{
  const q = quantize([{ pitch: 60, start: 0.13, end: 0.14, velocity: 90 }, { pitch: 62, start: 0.49, end: 0.98, velocity: 90 }], 120, 4);
  assert.deepEqual(q.map((n) => [n.start, n.end]), [[0.125, 0.25], [0.5, 1]]);
  const half = quantize([{ pitch: 60, start: 0.1, end: 0.6, velocity: 90 }], 120, 2, 0.5);
  assert.ok(Math.abs(half[0].start - 0.05) < 1e-9);
  assert.throws(() => quantize([], 5, 4), /Tempo/);
}
// Key hint.
assert.equal(guessKey([60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60, 67].map((p, i) => ({ pitch: p, start: i, end: i + 1, velocity: 90 }))), "C major");
assert.equal(noteName(60), "C4");

// MIDI round trip: timing, pitch, velocity, tempo and program survive.
{
  const notes = melody.map((n, i) => ({ pitch: n.pitch, start: n.start, end: n.end, velocity: 40 + i * 10 }));
  const bytes = writeMidi({ notes, bpm: 96, program: 33, name: "Bass line" });
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "MThd");
  const back = readMidi(bytes);
  assert.equal(back.bpm, 96); assert.equal(back.program, 33); assert.equal(back.name, "Bass line");
  assert.equal(back.notes.length, notes.length);
  back.notes.forEach((n, i) => {
    assert.equal(n.pitch, notes[i].pitch); assert.equal(n.velocity, notes[i].velocity);
    assert.ok(Math.abs(n.start - notes[i].start) < 0.002 && Math.abs(n.end - notes[i].end) < 0.002, "timing within a tick");
  });
  // Overlapping notes of the same pitch and back-to-back notes stay separate.
  const tight = readMidi(writeMidi({ notes: [{ pitch: 60, start: 0, end: 0.5, velocity: 80 }, { pitch: 60, start: 0.5, end: 1, velocity: 80 }], bpm: 120, program: 0, name: "x" }));
  assert.equal(tight.notes.length, 2);
  assert.throws(() => readMidi(new Uint8Array(20)), /not a MIDI/);
  assert.throws(() => writeMidi({ notes, bpm: 0, program: 0, name: "" }), /Tempo/);
}

// WAV round trip keeps sample rate, channels and 24-bit precision.
{
  const l = new Float32Array([0, 0.5, -0.5, 0.999, -1]), r = new Float32Array([0.25, -0.25, 0.1, 0, 0]);
  const back = readWav(writeWav([l, r], 96000, 24));
  assert.equal(back.rate, 96000); assert.equal(back.bits, 24); assert.equal(back.channels.length, 2);
  back.channels[0].forEach((x, i) => assert.ok(Math.abs(x - l[i]) < 1e-6));
  const b16 = readWav(writeWav([l], 44100, 16));
  b16.channels[0].forEach((x, i) => assert.ok(Math.abs(x - l[i]) < 1e-4));
  assert.throws(() => readWav(new Uint8Array(40)), /not a WAV/);
}
// The preview synth plays the transcribed notes back at the right pitch.
{
  const notes = [{ pitch: 57, start: 0.1, end: 0.6, velocity: 100 }, { pitch: 64, start: 0.7, end: 1.2, velocity: 60 }];
  const audio = renderNotes(notes, 48000);
  const again = transcribe([audio], 48000).notes;
  assert.deepEqual(again.map((n) => n.pitch), [57, 64]);
  assert.ok(Math.max(...audio.map(Math.abs)) <= 0.9);
}
console.log("engine tests passed");
