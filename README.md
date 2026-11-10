# SoundLab MIDI Transcript

Turns a recording of one melody line (a vocal, bass line, lead, solo or whistled tune) into an editable Standard MIDI File. It records performance data, not sound: which notes, when they start and stop, and how loud (velocity). Use the `.mid` in a DAW to swap the instrument, or in notation software to prepare sheet music.

- **App id:** `soundlab.transcribe` (listed as "SoundLab Transcribe" in SoundLab-Core `docs/APPS.md`)
- **Family:** SoundLab Pro; opens and saves `.soundlab` projects
- **Version:** 0.1

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # engine and project tests (Node 22.6+)
npm run build    # static site in dist/
```

## Decisions (START_HERE §4)

| Decision | Choice | Why |
|---|---|---|
| Where processing runs | **In the browser, on the device**, in a Web Worker | Private (nothing is uploaded), works offline, no server cost. A 3-minute file takes about 4–8 s. |
| Model licence | **No AI model yet.** Pitch tracking is YIN (de Cheveigné & Kawahara, 2002), written from the paper | No licence risk. A polyphonic model is the next step (see Not yet). |
| Platform | Web first (Vite + TypeScript, no framework) | Same as the other Pro apps. |
| Shared code | `src/core/` is copied from SoundLab-Core @ `7bd83cb` (see `src/core/SOURCE.txt`) | The README in Core allows copying. Copy again to update, and don't edit it here. |

## How it saves into a project

Following SPEC.md, the app never edits the version it listened to. **Save to .soundlab project** adds:

1. the `.mid` file as a `midi` asset,
2. a rendered synth preview (`… preview.wav`, at the source's sample rate, 24-bit, loudness measured with `measureLoudness`) so CoLab can play and A/B it,
3. a new version labelled `MIDI n`, stage `stems`. Its audio is the preview, `stemIds: [midi asset]`, and `source = { app: "soundlab.transcribe", basedOn: <source version>, settings: { app, schema: 1, data } }`. `data` holds the range, detection settings, tempo, grid, instrument, note count and whether the notes were edited by hand.

The last-used settings are also stored in `project.apps["soundlab.transcribe"]` and restored the next time the project is opened.

If you open a loose audio file, saving creates a new project with the recording as `Demo 1` and the transcription based on it.

**Proposal for SPEC.md (format v1, additive).** The format has no stage or field for MIDI results. Putting the MIDI asset in `stemIds` keeps it referenced, so `unusedAssets` won't list it, but this is a workaround. A small optional addition, such as `version.midiIds?: string[]` or a `"midi"` stage, would make it explicit.

## How transcription works

1. Mix to mono. Analyse a low-passed, downsampled copy (≥11 kHz) for speed; the user's audio is never changed.
2. YIN pitch tracking every 10 ms using FFT cross-correlation, with parabolic interpolation (within about 8 cents on test tones).
3. A frame counts as a note when it is periodic enough (**Sensitivity**) and loud enough (**Quietest note**).
4. Pitch is median-smoothed, and notes are split on pitch changes (half a semitone of hysteresis) and on new attacks: a 6 dB rise in a short level envelope at least one pitch period long, so repeated notes separate but tremolo doesn't. Fragments shorter than **Shortest note** fold into a neighbour, which handles glides and vibrato overshoot.
5. Velocity follows each note's peak level relative to the loudest note.
6. Optional grid snap (1/4 to 1/32, and 1/8 triplets) with a strength setting is applied on export. The notes as played are kept.

## What works

- WAV read at its own sample rate and bit depth (8/16/24/32-bit integer, 32/64-bit float). MP3 and FLAC are decoded at the rate in their headers. Other formats are decoded by the browser, and the conversion is shown.
- Pitch ranges for any melody, voice, bass (down to 30 Hz), guitar, keys/lead and whistle/flute.
- A piano roll with a waveform and the detected pitch shown behind the notes, beat and bar grid, and zoom. Select a note, move it up or down a semitone (Shift for an octave), delete it, and undo.
- A/B listening: the original, the MIDI preview, or both, level-matched by LUFS. You can switch while it plays.
- Export a type-1 `.mid` with tempo, time signature, track name and a General MIDI instrument (piano, bass, strings, brass, sax, flute, leads and others).
- Open a `.mid` to edit it, change its instrument or re-export it.
- Open and save `.soundlab` projects (validated with `problems()` through `readBundle`).
- Tested with synthetic melodies at 44.1, 48 and 96 kHz, with vibrato and noise, low bass, repeated and legato notes, tremolo, silence and white noise. Also tested: MIDI and WAV round trips, and the project save rules. The app was checked in Chromium at 1280 px and 390 px wide.

## Not yet

- **Chords and full mixes (polyphony).** One note at a time only. Next step: a polyphonic model running in the browser, for example Spotify's Basic Pitch (Apache-2.0; confirm the licence of the model weights before shipping). Use SoundLab Stems first to isolate a part.
- **Drums** (onsets to GM drum notes).
- Pitch bend and vibrato as MIDI pitch-bend data. Notes are rounded to the nearest semitone.
- Tempo detection and a tempo map. You type the BPM, or it comes from the project.
- Note editing beyond pitch and delete: resizing, moving in time, drawing new notes, editing velocity.
- Owner identity: standalone saves use the project owner. CoLab sign-in will supply the real member.
- MusicXML export for notation apps. MIDI import works in Sibelius, Finale, Dorico and MuseScore today.
- Trademark check of the names "SoundLab" and "MIDI Transcript" before launch.
