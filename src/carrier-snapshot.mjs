/**
 * A carrier snapshot: one addressed reading of WHERE bytes were observed.
 *
 * A carrier (a checkout, an installed release, an upload batch, a peer) is
 * not the content space; it is one way bytes arrive in it. Admitting a
 * carrier retains each of its files by NI and then retains this snapshot,
 * whose own NI names the canonical list of exact carrier-relative paths that
 * pointed at those NIs at observation time. Paths are case-preserving
 * observation coordinates, never content identity; two paths that hold the
 * same bytes share one retained body. A missing or moved carrier only means
 * no new snapshot can be observed from it: every snapshot and body already
 * retained stays addressable.
 *
 * Unlike a content tree (lowercase single-segment slot names, 256 entries)
 * this projection holds arbitrary POSIX paths at any depth and size. Entries
 * are cut into parts where a path's hash falls on a boundary, so changing one
 * file rewrites one part and the small root, not the whole snapshot.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { extensionType } from "@red-cup-engineering/computer-serialized-content-engineering-services-section/services/http-data-services-section/src/media-type";
import { immutableContentKey } from "./immutable-content-custody.mjs";

export const CARRIER_SNAPSHOT_MEDIA_TYPE = "application/vnd.561.carrier-snapshot+json";
export const CARRIER_SNAPSHOT_KIND = "semiotic-content.carrier-snapshot";
export const CARRIER_SNAPSHOT_PART_KIND = "semiotic-content.carrier-snapshot-part";
export const CARRIER_SNAPSHOT_VERSION = 1;
/** Directories that hold tool state, dependency installs or VCS objects rather than carried content. */
export const DEFAULT_CARRIER_EXCLUDES = Object.freeze(["node_modules", ".git", ".pnpm-store"]);

const MAX_PATH_LENGTH = 4096;
const MAX_PART_ENTRIES = 4096;
const MIN_PART_ENTRIES = 64;
const BOUNDARY_MODULUS = 512;
const MAX_PARTS = 16384;

/** Admit one carrier-relative POSIX path exactly as observed. */
export function admitCarrierPath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > MAX_PATH_LENGTH ||
      !path.isWellFormed() || path.includes("\0") || path.startsWith("/"))
    throw new TypeError("carrier snapshot: a bounded relative POSIX path is required");
  for (const segment of path.split("/"))
    if (segment === "" || segment === "." || segment === "..")
      throw new TypeError("carrier snapshot: path segments must be nonempty and cannot traverse");
  return path;
}

function admitEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 4)
    throw new TypeError("carrier snapshot: entries are [path, ni, mediaType, byteLength]");
  const [path, ni, mediaType, byteLength] = entry;
  admitCarrierPath(path);
  immutableContentKey(ni);
  if (typeof mediaType !== "string" || !mediaType || mediaType.length > 255)
    throw new TypeError("carrier snapshot: each entry needs its observed media type");
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new TypeError("carrier snapshot: each entry needs its exact byte length");
  return Object.freeze([path, ni, mediaType, byteLength]);
}

const byPath = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const encode = value => Buffer.from(JSON.stringify(value) + "\n", "utf8");
const boundary = path =>
  createHash("sha256").update(path).digest().readUInt32BE(0) % BOUNDARY_MODULUS === 0;

/** Cut sorted entries into content-defined parts: stable under nearby edits, bounded in size. */
function cut(entries) {
  const parts = [];
  let part = [];
  for (const entry of entries) {
    part.push(entry);
    if (part.length >= MAX_PART_ENTRIES || (part.length >= MIN_PART_ENTRIES && boundary(entry[0]))) {
      parts.push(part);
      part = [];
    }
  }
  if (part.length > 0 || parts.length === 0) parts.push(part);
  if (parts.length > MAX_PARTS) throw new RangeError("carrier snapshot: carrier exceeds the snapshot part budget");
  return parts;
}

/** Decode exact snapshot or part bytes; any non-canonical spelling is refused. */
export function decodeCarrierSnapshot(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("carrier snapshot: exact bytes are required");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("carrier snapshot: bytes must be UTF-8 JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.version !== CARRIER_SNAPSHOT_VERSION)
    throw new TypeError("carrier snapshot: kind or version is not admitted");
  let canonical;
  if (value.kind === CARRIER_SNAPSHOT_KIND) {
    if (!Array.isArray(value.parts) || value.parts.length > MAX_PARTS || !Number.isSafeInteger(value.entries) || value.entries < 0)
      throw new TypeError("carrier snapshot: a root lists its parts and entry count");
    for (const ni of value.parts) immutableContentKey(ni);
    canonical = encode({ kind: CARRIER_SNAPSHOT_KIND, version: CARRIER_SNAPSHOT_VERSION, entries: value.entries, parts: value.parts });
  } else if (value.kind === CARRIER_SNAPSHOT_PART_KIND) {
    if (!Array.isArray(value.entries) || value.entries.length > MAX_PART_ENTRIES)
      throw new TypeError("carrier snapshot: a part holds a bounded entry list");
    const entries = value.entries.map(admitEntry);
    for (let i = 1; i < entries.length; i++)
      if (byPath(entries[i - 1], entries[i]) >= 0) throw new TypeError("carrier snapshot: part paths must be unique and sorted");
    canonical = encode({ kind: CARRIER_SNAPSHOT_PART_KIND, version: CARRIER_SNAPSHOT_VERSION, entries });
  } else throw new TypeError("carrier snapshot: kind or version is not admitted");
  if (!Buffer.from(bytes).equals(canonical))
    throw new TypeError("carrier snapshot: bytes must be canonical");
  return Object.freeze(value.kind === CARRIER_SNAPSHOT_KIND
    ? { kind: value.kind, version: value.version, entries: value.entries, parts: Object.freeze([...value.parts]) }
    : { kind: value.kind, version: value.version, entries: Object.freeze(value.entries.map(entry => Object.freeze(entry))) });
}

async function retainJson(space, value) {
  const bytes = encode(value);
  return (await space.retain(bytes, { mediaType: CARRIER_SNAPSHOT_MEDIA_TYPE })).ni;
}

/**
 * Retain the snapshot of entries already held by this space. The space owner
 * still refuses nothing here about authority: the host chose the carrier.
 */
export async function retainCarrierSnapshot(space, entries) {
  if (typeof space?.retain !== "function") throw new TypeError("carrier snapshot: an installed content space is required");
  const admitted = [...entries].map(entry => admitEntry(Array.isArray(entry)
    ? entry : [entry?.path, entry?.ni, entry?.mediaType, entry?.byteLength])).sort(byPath);
  for (let i = 1; i < admitted.length; i++)
    if (admitted[i - 1][0] === admitted[i][0]) throw new TypeError("carrier snapshot: a path is observed once");
  const parts = [];
  for (const part of cut(admitted))
    parts.push(await retainJson(space, { kind: CARRIER_SNAPSHOT_PART_KIND, version: CARRIER_SNAPSHOT_VERSION, entries: part }));
  const ni = await retainJson(space, { kind: CARRIER_SNAPSHOT_KIND, version: CARRIER_SNAPSHOT_VERSION, entries: admitted.length, parts });
  return Object.freeze({ ni, entries: admitted.length, parts: parts.length });
}

/** Read a retained snapshot root and yield its entries in path order, verifying every part. */
export async function* readCarrierSnapshot(space, ni) {
  const read = async address => {
    const held = await space.get(address);
    if (held === null) throw new Error("carrier snapshot: a snapshot part is not retained");
    if (held.mediaType !== CARRIER_SNAPSHOT_MEDIA_TYPE) throw new TypeError("carrier snapshot: NI does not name a carrier snapshot");
    return decodeCarrierSnapshot(held.bytes);
  };
  const root = await read(ni);
  if (root.kind !== CARRIER_SNAPSHOT_KIND) throw new TypeError("carrier snapshot: NI names a part, not a snapshot root");
  for (const partNi of root.parts) {
    const part = await read(partNi);
    if (part.kind !== CARRIER_SNAPSHOT_PART_KIND) throw new TypeError("carrier snapshot: root lists a non-part");
    for (const [path, address, mediaType, byteLength] of part.entries)
      yield Object.freeze({ path, ni: address, mediaType, byteLength });
  }
}

function readWhole(file, size) {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== size) throw new Error("carrier file changed while it was read");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count === 0) throw new Error("carrier file shrank while it was read");
      offset += count;
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

/**
 * The regular files under one host-selected directory, in path order. Symlinks
 * are not followed; excluded names are skipped at any depth. Each file offers a
 * cheap stamp (size, mtime, inode) so an admitting host can skip unchanged bytes.
 */
export function* directoryCarrierFiles(root, { excludes = DEFAULT_CARRIER_EXCLUDES, paths, maximumPaths = 256, maximumBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof root !== "string" || !root.startsWith("/")) throw new TypeError("carrier: an absolute host-selected directory is required");
  if (!lstatSync(root).isDirectory()) throw new TypeError("carrier: the host-selected carrier is not a directory");
  const skip = new Set(excludes);
  // Explicit source projections inspect these literal files only. They never
  // enumerate a directory or cross a symlink into another source authority.
  if (paths !== undefined) {
    if (!Array.isArray(paths) || !paths.length || !Number.isSafeInteger(maximumPaths) || maximumPaths < 1 || maximumPaths > 4096 || paths.length > maximumPaths
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024)
      throw new TypeError("carrier: finite explicit source paths and byte budget required");
    const selected = paths.map(admitCarrierPath);
    if (new Set(selected).size !== selected.length) throw new TypeError("carrier: duplicate selected source path");
    const base = realpathSync(root), files = [];
    let bytes = 0;
    for (const path of selected) {
      if (path.split("/").some(part => skip.has(part))) continue;
      const file = join(base, path), stat = lstatSync(file);
      if (!stat.isFile() || realpathSync(file) !== file) throw new TypeError("carrier: selected source is not an unredirected regular file");
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) throw new RangeError("carrier: selected source byte budget exceeded");
      files.push(Object.freeze({ path, size: stat.size, stamp: `${stat.size}:${stat.mtimeMs}:${stat.ino}`, read: () => readWhole(file, stat.size) }));
    }
    yield* files;
    return;
  }
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop();
    let names;
    try { names = readdirSync(relative ? join(root, relative) : root, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT" || error?.code === "EACCES") continue; throw error; }
    const children = [];
    for (const dirent of names) {
      if (skip.has(dirent.name) || !dirent.name.isWellFormed()) continue;
      const path = relative ? relative + "/" + dirent.name : dirent.name;
      if (dirent.isDirectory()) children.push(path);
      else if (dirent.isFile()) {
        let stat;
        try { stat = lstatSync(join(root, path)); } catch { continue; }
        if (!stat.isFile()) continue;
        const file = join(root, path);
        yield Object.freeze({ path, size: stat.size, stamp: `${stat.size}:${stat.mtimeMs}:${stat.ino}`,
          read: () => readWhole(file, stat.size) });
      }
    }
    children.sort().reverse();
    pending.push(...children);
  }
}

/**
 * Admit one carrier into the space: retain each file's exact bytes by NI, then
 * retain the snapshot of where they were observed. `known` maps a file's
 * path+stamp to its NI from an earlier admission, so unchanged files are not
 * reread. Files too large for custody are reported, never silently dropped.
 *
 * `retain(bytes, mediaType)` may be supplied to carry retention elsewhere
 * (another thread or process holding the same space) and `concurrency`
 * bounds how many retentions are in flight. `onCheckpoint` receives a snapshot
 * of every entry retained so far after each `checkpointEvery` entries, so a
 * long first admission becomes readable progressively.
 */
export async function admitCarrier(space, files, {
  maximumFileBytes = 8 * 1024 * 1024, known = new Map(), mediaTypeOf = extensionType,
  maximumSkipped = 64, signal, onProgress, concurrency = 1,
  retain = (bytes, mediaType) => space.retain(bytes, { mediaType }),
  checkpointEvery, onCheckpoint,
} = {}) {
  if (typeof space?.retain !== "function" || typeof space?.head !== "function")
    throw new TypeError("carrier: an installed content space is required");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256)
    throw new RangeError("carrier: concurrency is 1 through 256 retentions in flight");
  const entries = [], skipped = [], retaining = new Map(), inFlight = new Set();
  let retained = 0, reused = 0, skippedCount = 0, bytes = 0, failure;
  const skip = (path, reason) => { skippedCount++; if (skipped.length < maximumSkipped) skipped.push(Object.freeze({ path, reason })); };
  const settle = async () => {
    await Promise.all(inFlight);
    if (failure !== undefined) throw failure;
  };
  const retainOne = async (body, ni, mediaType) => {
    try { await retain(body, mediaType); }
    catch (error) {
      // One NI is one body: the same bytes first retained under another
      // media type are still held. The observed type stays on its entry.
      if (await space.head(ni) === null) throw error;
    }
    retained++;
  };
  for (const file of files) {
    signal?.throwIfAborted();
    if (failure !== undefined) throw failure;
    let path;
    try { path = admitCarrierPath(file.path); } catch { skip(String(file.path).slice(0, 256), "path"); continue; }
    if (!Number.isSafeInteger(file.size) || file.size < 0) { skip(path, "size"); continue; }
    if (file.size > maximumFileBytes) { skip(path, "too-large"); continue; }
    const mediaType = mediaTypeOf(path) || "application/octet-stream";
    const key = file.stamp === undefined ? undefined : path + "\0" + file.stamp;
    let ni = key === undefined ? undefined : known.get(key);
    let byteLength = file.size;
    if (ni !== undefined) reused++;
    else {
      let body;
      try { body = file.read(); } catch { skip(path, "unreadable"); continue; }
      // The bytes actually read are what is retained and observed.
      byteLength = body.length;
      if (byteLength > maximumFileBytes) { skip(path, "too-large"); continue; }
      const address = ni = makeNiUri(body);
      if (!retaining.has(address)) {
        const held = retainOne(body, address, mediaType).then(
          () => { if (key !== undefined) known.set(key, address); },
          error => { failure ??= error; }).finally(() => inFlight.delete(held));
        retaining.set(address, held);
        inFlight.add(held);
        if (inFlight.size >= concurrency) await Promise.race(inFlight);
      } else if (key !== undefined) retaining.get(address).then(() => { if (failure === undefined) known.set(key, address); });
    }
    bytes += byteLength;
    entries.push([path, ni, mediaType, byteLength]);
    if (onProgress !== undefined && entries.length % 1024 === 0) await onProgress({ entries: entries.length, retained, reused });
    if (onCheckpoint !== undefined && checkpointEvery > 0 && entries.length % checkpointEvery === 0) {
      await settle();
      await onCheckpoint(await retainCarrierSnapshot(space, entries));
    }
  }
  await settle();
  const snapshot = await retainCarrierSnapshot(space, entries);
  return Object.freeze({ ...snapshot, retained, reused, bytes,
    skipped: Object.freeze(skipped), skippedCount });
}
