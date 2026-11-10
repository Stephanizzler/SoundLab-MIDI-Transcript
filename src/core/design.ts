// The SoundLab Pro look, shared by every Pro app: graphite surfaces, cool
// neutrals and one amber accent (the indicator lamps of the Mastering rack).
// Status colours are for meaning only, never decoration.
export const color = {
  bg: "#0D0F12",
  panel: "#15181D",
  raised: "#1D2128",
  line: "#2A2F38",
  text: "#E8EBF0",
  muted: "#8B93A1",
  accent: "#F5A524",
  good: "#3CCB7F",
  warn: "#F5A524",
  bad: "#F0616D",
  info: "#6EA8FF",
  waveform: "#5B6372",
  compare: "#6EA8FF", // the "B" side in any A/B comparison
} as const;
export const radius = { small: 4, control: 8, panel: 10 } as const;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
export const type = {
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontSize: 16, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1 }, // UPPERCASE section labels
  readout: { fontSize: 18, fontWeight: "600", fontVariant: ["tabular-nums"] }, // meters, times
} as const;
// Every app is named "SoundLab" followed by what it does: SoundLab Mastering, SoundLab Stems.
export const BRAND_PREFIX = "SoundLab";
