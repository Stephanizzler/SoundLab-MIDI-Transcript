// The SoundLab project format: one record of a piece of work as it moves
// between SoundLab Pro apps (Vocalizer, Mastering, CoLab, ...). Pure data and
// pure functions only, so every app (web, React Native, Node) can share it.
// See SPEC.md for the rules other apps must follow.

export const FORMAT = "soundlab.project";
export const FORMAT_VERSION = 1;

export type AppId = `soundlab.${string}`;
export type Role = "owner" | "engineer" | "producer" | "artist" | "client";
export type Stage = "demo" | "vocal" | "mix" | "master" | "stems";
export type VersionStatus = "in-review" | "changes-requested" | "approved";
export type AssetKind = "audio" | "stem" | "session" | "midi" | "document";
export type Daw = "Logic Pro" | "Ableton Live" | "Pro Tools" | "Other";

export type Loudness = {
  integratedLufs: number | null; // null when the audio is silent
  truePeakDbtp: number;
  samplePeakDbfs: number;
  loudnessRange: number | null;
};
export type AudioInfo = { sampleRate: number; channels: number; durationSeconds: number; loudness?: Loudness };
export type Asset = {
  id: string;
  kind: AssetKind;
  name: string;
  mime: string;
  bytes: number;
  sha256?: string;
  audio?: AudioInfo;
  session?: { daw: Daw; dawVersion?: string; notes?: string };
  createdAt: string;
  createdBy: string;
};
export type Member = { id: string; name: string; role: Role };
export type AppSettings = { app: AppId; schema: number; data: unknown };
export type Version = {
  id: string;
  label: string; // "Mix 2", "Master 1"
  stage: Stage;
  assetId: string; // the listening file for this version
  stemIds: string[];
  description: string;
  status: VersionStatus;
  approvals: { memberId: string; at: string }[];
  source: { app: AppId; basedOn?: string; settings?: AppSettings };
  createdAt: string;
  createdBy: string;
};
export type Reply = { id: string; authorId: string; text: string; assetId?: string; createdAt: string };
export type Comment = {
  id: string;
  versionId: string;
  at: number; // seconds into the version's audio
  end?: number;
  text: string;
  authorId: string;
  createdAt: string;
  resolved?: { by: string; at: string; inVersionId?: string };
  replies: Reply[];
};
export type Song = { id: string; title: string; versions: Version[]; comments: Comment[]; sessionIds: string[] };
export type Project = {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  id: string;
  title: string;
  artist: string;
  bpm?: number;
  key?: string;
  members: Member[];
  songs: Song[];
  assets: Asset[];
  // Anything an app wants to keep about the whole project, keyed by app id.
  apps: Partial<Record<AppId, AppSettings>>;
  createdAt: string;
  updatedAt: string;
};

export const STAGE_NAMES: Record<Stage, string> = { demo: "Demo", vocal: "Vocal", mix: "Mix", master: "Master", stems: "Stems" };
export const STATUS_NAMES: Record<VersionStatus, string> = {
  "in-review": "In review",
  "changes-requested": "Changes requested",
  approved: "Approved",
};
export const ROLE_NAMES: Record<Role, string> = { owner: "Owner", engineer: "Engineer", producer: "Producer", artist: "Artist", client: "Client" };

export type Clock = { now: () => string; id: () => string };
const stamp = (c: Clock) => c.now();
const touch = (p: Project, c: Clock): Project => ({ ...p, updatedAt: stamp(c) });

export function createProject(c: Clock, title: string, owner: { name: string }, artist = ""): Project {
  const name = title.trim();
  if (!name || name.length > 120) throw new Error("Give the project a name of 1–120 characters.");
  const at = stamp(c);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: c.id(),
    title: name,
    artist: artist.trim().slice(0, 120),
    members: [{ id: c.id(), name: owner.name.trim() || "Owner", role: "owner" }],
    songs: [],
    assets: [],
    apps: {},
    createdAt: at,
    updatedAt: at,
  };
}
export const owner = (p: Project) => p.members.find((m) => m.role === "owner")!;
export const findSong = (p: Project, id: string) => p.songs.find((s) => s.id === id);
export const findAsset = (p: Project, id: string) => p.assets.find((a) => a.id === id);
export function findVersion(p: Project, id: string) {
  for (const s of p.songs) {
    const v = s.versions.find((x) => x.id === id);
    if (v) return { song: s, version: v };
  }
  return undefined;
}
function mapSong(p: Project, id: string, fn: (s: Song) => Song): Project {
  if (!findSong(p, id)) throw new Error("That song is not in this project.");
  return { ...p, songs: p.songs.map((s) => (s.id === id ? fn(s) : s)) };
}

export function addSong(p: Project, c: Clock, title: string): { project: Project; song: Song } {
  const name = title.trim();
  if (!name || name.length > 120) throw new Error("Give the song a name of 1–120 characters.");
  const song: Song = { id: c.id(), title: name, versions: [], comments: [], sessionIds: [] };
  return { project: touch({ ...p, songs: [...p.songs, song] }, c), song };
}
export function renameSong(p: Project, c: Clock, songId: string, title: string): Project {
  const name = title.trim();
  if (!name || name.length > 120) throw new Error("Give the song a name of 1–120 characters.");
  return touch(mapSong(p, songId, (s) => ({ ...s, title: name })), c);
}
export function addAsset(p: Project, c: Clock, asset: Omit<Asset, "id" | "createdAt"> & { id?: string }): { project: Project; asset: Asset } {
  if (!asset.name.trim()) throw new Error("Every file needs a name.");
  if (!Number.isFinite(asset.bytes) || asset.bytes < 0) throw new Error("File size is not valid.");
  if (!p.members.some((m) => m.id === asset.createdBy)) throw new Error("Only project members can add files.");
  const full: Asset = { ...asset, id: asset.id ?? c.id(), createdAt: stamp(c) };
  if (findAsset(p, full.id)) throw new Error("A file with this ID is already in the project.");
  return { project: touch({ ...p, assets: [...p.assets, full] }, c), asset: full };
}
// "Mix 3" when there are already two mixes of this song.
export function nextLabel(song: Song, stage: Stage) {
  return `${STAGE_NAMES[stage]} ${song.versions.filter((v) => v.stage === stage).length + 1}`;
}
export function addVersion(
  p: Project,
  c: Clock,
  songId: string,
  v: { stage: Stage; assetId: string; createdBy: string; description?: string; stemIds?: string[]; label?: string; source?: Version["source"] },
): { project: Project; version: Version } {
  const song = findSong(p, songId);
  if (!song) throw new Error("That song is not in this project.");
  const asset = findAsset(p, v.assetId);
  if (!asset || !asset.audio) throw new Error("A version needs an audio file from this project.");
  for (const id of v.stemIds ?? []) if (!findAsset(p, id)) throw new Error("A stem is missing from this project.");
  if (!p.members.some((m) => m.id === v.createdBy)) throw new Error("Only project members can add versions.");
  if (v.source?.basedOn && !findVersion(p, v.source.basedOn)) throw new Error("The version this is based on is not in the project.");
  const version: Version = {
    id: c.id(),
    label: (v.label ?? nextLabel(song, v.stage)).trim().slice(0, 60),
    stage: v.stage,
    assetId: v.assetId,
    stemIds: v.stemIds ?? [],
    description: (v.description ?? "").trim().slice(0, 2000),
    status: "in-review",
    approvals: [],
    source: v.source ?? { app: "soundlab.colab" },
    createdAt: stamp(c),
    createdBy: v.createdBy,
  };
  return { project: touch(mapSong(p, songId, (s) => ({ ...s, versions: [...s.versions, version] })), c), version };
}
function mapVersion(p: Project, versionId: string, fn: (v: Version) => Version): Project {
  const found = findVersion(p, versionId);
  if (!found) throw new Error("That version is not in this project.");
  return mapSong(p, found.song.id, (s) => ({ ...s, versions: s.versions.map((v) => (v.id === versionId ? fn(v) : v)) }));
}
export function setStatus(p: Project, c: Clock, versionId: string, status: VersionStatus): Project {
  return touch(mapVersion(p, versionId, (v) => ({ ...v, status, approvals: status === "approved" ? v.approvals : [] })), c);
}
// Each member approves once. The version is approved when the owner approves,
// or when every artist and client on the project has.
export function approve(p: Project, c: Clock, versionId: string, memberId: string): Project {
  const member = p.members.find((m) => m.id === memberId);
  if (!member) throw new Error("Only project members can approve.");
  const next = mapVersion(p, versionId, (v) =>
    v.approvals.some((a) => a.memberId === memberId) ? v : { ...v, approvals: [...v.approvals, { memberId, at: stamp(c) }] },
  );
  const v = findVersion(next, versionId)!.version;
  const signers = next.members.filter((m) => m.role === "artist" || m.role === "client");
  const done = member.role === "owner" || (signers.length > 0 && signers.every((m) => v.approvals.some((a) => a.memberId === m.id)));
  return touch(done ? mapVersion(next, versionId, (x) => ({ ...x, status: "approved" })) : next, c);
}
export function addComment(
  p: Project,
  c: Clock,
  x: { versionId: string; at: number; end?: number; text: string; authorId: string },
): { project: Project; comment: Comment } {
  const found = findVersion(p, x.versionId);
  if (!found) throw new Error("Choose the version this comment is about.");
  const duration = findAsset(p, found.version.assetId)?.audio?.durationSeconds ?? Infinity;
  if (!Number.isFinite(x.at) || x.at < 0 || x.at > duration) throw new Error("Choose a time within this version.");
  if (x.end !== undefined && (!(x.end > x.at) || x.end > duration)) throw new Error("A comment's end must come after its start.");
  const text = x.text.trim();
  if (!text || text.length > 4000) throw new Error("Write a comment of up to 4000 characters.");
  if (!p.members.some((m) => m.id === x.authorId)) throw new Error("Only project members can comment.");
  const comment: Comment = { id: c.id(), versionId: x.versionId, at: x.at, end: x.end, text, authorId: x.authorId, createdAt: stamp(c), replies: [] };
  return { project: touch(mapSong(p, found.song.id, (s) => ({ ...s, comments: [...s.comments, comment] })), c), comment };
}
function mapComment(p: Project, commentId: string, fn: (x: Comment) => Comment): Project {
  const song = p.songs.find((s) => s.comments.some((x) => x.id === commentId));
  if (!song) throw new Error("That comment is not in this project.");
  return mapSong(p, song.id, (s) => ({ ...s, comments: s.comments.map((x) => (x.id === commentId ? fn(x) : x)) }));
}
export function reply(p: Project, c: Clock, commentId: string, r: { authorId: string; text: string; assetId?: string }): Project {
  const text = r.text.trim();
  if (!text && !r.assetId) throw new Error("Write a reply or attach audio.");
  if (text.length > 4000) throw new Error("Replies can be up to 4000 characters.");
  if (r.assetId && !findAsset(p, r.assetId)) throw new Error("The attached file is not in this project.");
  if (!p.members.some((m) => m.id === r.authorId)) throw new Error("Only project members can reply.");
  return touch(mapComment(p, commentId, (x) => ({ ...x, replies: [...x.replies, { id: c.id(), authorId: r.authorId, text, assetId: r.assetId, createdAt: stamp(c) }] })), c);
}
export function resolve(p: Project, c: Clock, commentId: string, by: string, inVersionId?: string): Project {
  if (inVersionId && !findVersion(p, inVersionId)) throw new Error("The fixed version is not in this project.");
  return touch(mapComment(p, commentId, (x) => ({ ...x, resolved: { by, at: stamp(c), inVersionId } })), c);
}
export function reopen(p: Project, c: Clock, commentId: string): Project {
  return touch(mapComment(p, commentId, ({ resolved: _, ...x }) => x), c);
}
export function addMember(p: Project, c: Clock, name: string, role: Role): { project: Project; member: Member } {
  if (role === "owner") throw new Error("A project has one owner.");
  const n = name.trim();
  if (!n || n.length > 80) throw new Error("Enter a name of 1–80 characters.");
  const member = { id: c.id(), name: n, role };
  return { project: touch({ ...p, members: [...p.members, member] }, c), member };
}
export function attachSession(p: Project, c: Clock, songId: string, assetId: string): Project {
  const a = findAsset(p, assetId);
  if (!a || a.kind !== "session" || !a.session) throw new Error("Attach a session package from this project.");
  return touch(mapSong(p, songId, (s) => (s.sessionIds.includes(assetId) ? s : { ...s, sessionIds: [...s.sessionIds, assetId] })), c);
}
export function setAppSettings(p: Project, c: Clock, settings: AppSettings): Project {
  if (!/^soundlab\.[a-z0-9-]+$/.test(settings.app)) throw new Error("App ids look like soundlab.mastering.");
  return touch({ ...p, apps: { ...p.apps, [settings.app]: settings } }, c);
}
// Files no version, stem list, reply or session refers to any more.
export function unusedAssets(p: Project) {
  const used = new Set<string>();
  for (const s of p.songs) {
    s.sessionIds.forEach((id) => used.add(id));
    for (const v of s.versions) [v.assetId, ...v.stemIds].forEach((id) => used.add(id));
    for (const x of s.comments) for (const r of x.replies) if (r.assetId) used.add(r.assetId);
  }
  return p.assets.filter((a) => !used.has(a.id));
}

const isString = (x: unknown, max = 4000) => typeof x === "string" && x.length <= max;
const isTime = (x: unknown) => isString(x, 40) && !Number.isNaN(Date.parse(x as string));
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
// Validates data from storage, another app or another person before use.
// Returns a list of problems; an empty list means the project is safe to load.
export function problems(x: unknown): string[] {
  const out: string[] = [];
  const p = x as Project;
  if (!p || typeof p !== "object") return ["Not a SoundLab project."];
  if (p.format !== FORMAT) return ["Not a SoundLab project."];
  if (p.version !== FORMAT_VERSION) return [`This project uses format version ${p.version}; this app reads version ${FORMAT_VERSION}.`];
  if (!isString(p.id, 100) || !isString(p.title, 120) || !p.title || !isString(p.artist ?? "", 120)) out.push("Project name or id is missing.");
  if (!isTime(p.createdAt) || !isTime(p.updatedAt)) out.push("Project dates are not valid.");
  if (p.bpm !== undefined && !(isNum(p.bpm) && p.bpm >= 20 && p.bpm <= 400)) out.push("Tempo is not valid.");
  if (!Array.isArray(p.members) || p.members.filter((m) => m?.role === "owner").length !== 1) out.push("A project needs exactly one owner.");
  const members = new Set((p.members ?? []).map((m) => m?.id));
  for (const m of p.members ?? []) if (!isString(m?.id, 100) || !isString(m?.name, 80) || !(m.role in ROLE_NAMES)) out.push("A member is not valid.");
  if (!Array.isArray(p.assets) || !Array.isArray(p.songs) || typeof p.apps !== "object" || !p.apps) return [...out, "Project content is missing."];
  const assets = new Map<string, Asset>();
  for (const a of p.assets) {
    if (!a || !isString(a.id, 100) || assets.has(a.id)) { out.push("A file id is missing or repeated."); continue; }
    assets.set(a.id, a);
    if (!["audio", "stem", "session", "midi", "document"].includes(a.kind) || !isString(a.name, 255) || !isString(a.mime, 100) || !isNum(a.bytes) || a.bytes < 0)
      out.push(`File ${a.name ?? a.id} is not valid.`);
    if (a.audio && !(isNum(a.audio.sampleRate) && a.audio.sampleRate >= 8000 && a.audio.sampleRate <= 384000 && Number.isInteger(a.audio.channels) && a.audio.channels >= 1 && a.audio.channels <= 64 && isNum(a.audio.durationSeconds) && a.audio.durationSeconds > 0))
      out.push(`Audio details for ${a.name} are not valid.`);
    if (a.kind === "session" && !(a.session && ["Logic Pro", "Ableton Live", "Pro Tools", "Other"].includes(a.session.daw))) out.push(`Session ${a.name} needs its DAW.`);
    if (!members.has(a.createdBy)) out.push(`File ${a.name} was added by someone outside the project.`);
  }
  const versions = new Set<string>();
  for (const s of p.songs) {
    if (!s || !isString(s.id, 100) || !isString(s.title, 120) || !Array.isArray(s.versions) || !Array.isArray(s.comments) || !Array.isArray(s.sessionIds)) { out.push("A song is not valid."); continue; }
    for (const v of s.versions) {
      if (!v || versions.has(v.id)) { out.push(`A version of ${s.title} is repeated.`); continue; }
      versions.add(v.id);
      if (!(v.stage in STAGE_NAMES) || !(v.status in STATUS_NAMES) || !isString(v.label, 60) || !isString(v.description, 2000)) out.push(`Version ${v.label} of ${s.title} is not valid.`);
      if (!assets.get(v.assetId)?.audio) out.push(`Version ${v.label} of ${s.title} has no audio.`);
      if (!Array.isArray(v.stemIds) || v.stemIds.some((id) => !assets.has(id))) out.push(`Version ${v.label} of ${s.title} is missing stems.`);
      if (!v.source || !/^soundlab\.[a-z0-9-]+$/.test(v.source.app)) out.push(`Version ${v.label} of ${s.title} has no source app.`);
      if (!Array.isArray(v.approvals) || v.approvals.some((a) => !members.has(a.memberId))) out.push(`Approvals on ${v.label} are not valid.`);
    }
    for (const id of s.sessionIds) if (assets.get(id)?.kind !== "session") out.push(`A session on ${s.title} is missing.`);
  }
  for (const s of p.songs) {
    for (const v of s.versions ?? []) if (v?.source?.basedOn && !versions.has(v.source.basedOn)) out.push(`Version ${v.label} is based on a missing version.`);
    for (const x of s.comments ?? []) {
      const v = s.versions.find((y) => y.id === x?.versionId);
      if (!x || !v || !isNum(x.at) || x.at < 0 || !isString(x.text) || !members.has(x.authorId) || !Array.isArray(x.replies)) { out.push(`A comment on ${s.title} is not valid.`); continue; }
      if (x.resolved?.inVersionId && !versions.has(x.resolved.inVersionId)) out.push(`A comment on ${s.title} points at a missing fix.`);
      for (const r of x.replies) if (!members.has(r?.authorId) || !isString(r.text) || (r.assetId && !assets.has(r.assetId))) out.push(`A reply on ${s.title} is not valid.`);
    }
  }
  return out;
}
export function isProject(x: unknown): x is Project {
  return problems(x).length === 0;
}
