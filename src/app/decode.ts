// Opening audio at its own sample rate. WAV is read directly. For MP3 and FLAC
// the sample rate is read from the file header and the browser decodes at that
// rate; anything else is decoded by the browser and the conversion is shown.
import { readWav, type Pcm } from "../engine/audio.ts";

export type Opened = Pcm & { note?: string };

function mp3Rate(b: Uint8Array): number | null {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  for (const end = Math.min(b.length - 4, i + 65536); i < end; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3, index = (b[i + 2] >> 2) & 3;
    if (version === 1 || index === 3 || ((b[i + 1] >> 1) & 3) === 0) continue;
    const base = [44100, 48000, 32000][index];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}
function flacRate(b: Uint8Array): number | null {
  if (String.fromCharCode(...b.subarray(0, 4)) !== "fLaC") return null;
  const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  return rate >= 8000 ? rate : null;
}

export async function openAudio(name: string, bytes: Uint8Array): Promise<Opened> {
  if (/\.wav$/i.test(name) || String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF") return readWav(bytes);
  const known = mp3Rate(bytes) ?? flacRate(bytes);
  const rate = known ?? new AudioContext().sampleRate;
  const ctx = new OfflineAudioContext(1, 1, rate);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice().buffer);
  } catch {
    throw new Error("This browser can't read that file. Try WAV, MP3, FLAC or M4A.");
  }
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
  return {
    channels,
    rate: buf.sampleRate,
    bits: 32,
    float: true,
    note: known ? undefined : `Decoded by the browser at ${buf.sampleRate} Hz; the file's own sample rate may differ. Your original file is kept unchanged.`,
  };
}
