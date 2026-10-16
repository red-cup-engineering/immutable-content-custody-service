/**
 * An object store in one directory, the store shape immutable content custody
 * takes: each key is a file of its raw bytes under `<root>/objects/`, with its
 * media type in a `<file>.media-type` sidecar. Beyond get and putCurrent it
 * answers head, byte-range reads and prefix listing, so custody can serve large
 * media (video, audio) without reading whole files.
 */
import { closeSync, constants, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { verifyContentFile } from "./file-content-custody.mjs";
import { relative, resolve, sep } from "node:path";
import { walkPosixPathsSync } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { assertDurableFilePathSync, openDurableFileSync, syncFileDurablySync, writeFileBytesSync } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { extensionType } from "@red-cup-engineering/computer-serialized-content-engineering-services-section/services/http-data-services-section/src/media-type";

import { parseMimeType } from "@red-cup-engineering/computer-serialized-content-engineering-services-section/mime-type";

const missing = (error) => error?.code === "ENOENT";

function readRange(path, { start, end }) {
  let descriptor;
  try { descriptor = openSync(path, "r"); } catch (error) { if (missing(error)) return null; throw error; }
  try {
    const bytes = Buffer.alloc(end - start + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally { closeSync(descriptor); }
}

/**
 * Content named by ni but kept wherever it already lies: pathOf(ni) gives the
 * file (or undefined), whose type is its extension's. It answers the content
 * store shape (head, read) that /.well-known/ni/ serves; whoever built the
 * map locates it; every exposure verifies its complete current bytes.
 */
export function createPathContent(pathOf, mediaTypeOf = extensionType) {
  return Object.freeze({
    async head(ni) {
      const path = pathOf(ni);
      if (path === undefined) return null;
      try { return Object.freeze({ ...verifyContentFile(path, ni), mediaType: mediaTypeOf(path) }); }
      catch (error) { if (missing(error)) return null; throw error; }
    },
    async read(ni, range) {
      const path = pathOf(ni);
      if (path === undefined) return null;
      try { return verifyContentFile(path, ni, { range }).bytes; }
      catch (error) { if (missing(error)) return null; throw error; }
    },
  });
}

export function createFileStoreSync(root, { durableRoot } = {}) {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("a file store needs its root directory named explicitly");
  const base = resolve(root, "objects");
  const pathOf = (key) => {
    if (typeof key !== "string" || key.length === 0 || key.includes("\0")) throw new TypeError("object key must be nonempty");
    const path = resolve(base, ...key.split("/"));
    if (path !== base && !path.startsWith(`${base}${sep}`)) throw new Error("object key escapes the store root");
    return path;
  };
  const mediaTypeOf = (path) => {
    try { return readFileSync(`${path}.media-type`, "utf8").trim() || "application/octet-stream"; } catch (error) { if (missing(error)) return "application/octet-stream"; throw error; }
  };
  return Object.freeze({
    root: resolve(root),
    putIfAbsent(key, input) {
      if (durableRoot !== undefined) return putDurably(pathOf, key, input, durableRoot);
      const { body, mediaType = "application/octet-stream" } = input;
      const path = pathOf(key), bytes = Buffer.from(body);
      let conflict = false;
      try { writeFileBytesSync(path, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        conflict = true;
        // A completed body can survive a process loss before its metadata is
        // published. Only the exact same bytes may finish that publication.
        // A different body retains the existing first-writer conflict contract.
        if (!readFileSync(path).equals(bytes)) return Object.freeze({ conflict: true });
      }
      const sidecar = path + ".media-type";
      // Publish the complete sidecar atomically and exclusively too. Concurrent
      // matching writers may heal the same absent metadata, never replace it.
      try { writeFileBytesSync(sidecar, Buffer.from(mediaType + "\n"), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      if (mediaTypeOf(path) !== (String(mediaType).trim() || "application/octet-stream")) {
        return Object.freeze({ conflict: true });
      }
      return Object.freeze({ conflict });
    },
    putCurrent(key, { body, mediaType = "application/octet-stream" }) {
      if (durableRoot !== undefined) throw custodyError("ERR_CUSTODY_REPLACEMENT_UNSUPPORTED", "strict file custody does not support two-file replacement");
      const path = pathOf(key);
      writeFileBytesSync(path, Buffer.from(body));
      writeFileSync(`${path}.media-type`, `${mediaType}\n`);
      return Object.freeze({ conflict: false });
    },
    get(key) {
      const path = pathOf(key);
      let body;
      try { body = readFileSync(path); } catch (error) { if (missing(error)) return null; throw error; }
      return Object.freeze({ body, mediaType: mediaTypeOf(path) });
    },
    head(key) {
      const path = pathOf(key);
      let stat;
      try { stat = statSync(path); } catch (error) { if (missing(error)) return null; throw error; }
      return stat.isFile() ? Object.freeze({ size: stat.size, mediaType: mediaTypeOf(path), lastModified: stat.mtime }) : null;
    },
    /** Bytes start through end (inclusive) of one object, or null when it is absent. */
    read(key, range) {
      return readRange(pathOf(key), range);
    },
    verify(key, ni, options = {}) {
      try { return Object.freeze({ ...verifyContentFile(pathOf(key), ni, options), mediaType: mediaTypeOf(pathOf(key)) }); }
      catch (error) { if (missing(error)) return null; throw error; }
    },
    list(prefix = "", continuationToken) {
      if (continuationToken !== undefined) throw new Error("a file store lists in one page and takes no continuation token");
      const files = walkPosixPathsSync({ root: base, missing: "empty", paths: "absolute", result: "paths", symlinks: "skip", includeFile: ({ name }) => !name.endsWith(".media-type") && !name.startsWith(".") }).files;
      const keys = files.map((path) => relative(base, path).split(sep).join("/")).filter((key) => key.startsWith(prefix)).sort();
      return Object.freeze({ keys: Object.freeze(keys), continuationToken: undefined });
    },
  });
}

/** Promise-shaped callers share exactly the synchronous byte-store implementation. */
export function createFileStore(root, options) {
  const store = createFileStoreSync(root, options);
  return Object.freeze(Object.fromEntries(Object.entries(store).map(([key, value]) =>
    [key, typeof value === "function" ? async (...args) => value(...args) : value])));
}


function custodyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function strictRead(path, durableRoot) {
  let fd;
  try { fd = openDurableFileSync(path, constants.O_RDONLY, { durableRoot }); }
  catch (error) { if (missing(error)) return null; throw error; }
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

function sameRepresentation(retained, expected, label) {
  if (retained === null || !retained.equals(expected))
    throw custodyError("ERR_CUSTODY_CONFLICT", `strict custody ${label} differs from the expected representation`);
}

function putDurably(pathOf, key, input, durableRoot) {
  if (typeof key !== "string" || key.split("/").some(part => !part || part === "." || part === "..") || key.endsWith(".media-type"))
    throw new TypeError("strict custody requires a canonical object key outside the sidecar namespace");
  const { body, mediaType = "application/octet-stream" } = input;
  // The existing MIME owner bounds and parses the value; strict custody admits
  // only its canonical spelling, and compares the actual sidecar bytes.
  if (typeof mediaType !== "string" || /[\r\n]/u.test(mediaType) || parseMimeType({ mediaType }).serialized !== mediaType)
    throw new TypeError("strict custody requires a canonical media type without CR or LF");
  const bytes = Buffer.from(body), metadata = Buffer.from(mediaType + "\n");
  const path = pathOf(key), sidecar = path + ".media-type";
  for (const target of [path, sidecar]) assertDurableFilePathSync(target, { durableRoot });
  let retained = strictRead(path, durableRoot), heldType = strictRead(sidecar, durableRoot);
  let conflict = retained !== null;
  if (retained !== null) sameRepresentation(retained, bytes, "body");
  if (heldType !== null) sameRepresentation(heldType, metadata, "media type");
  if (retained !== null && heldType === null && input.mediaType === undefined)
    throw custodyError("ERR_CUSTODY_MEDIA_TYPE_REQUIRED", "recovering absent metadata requires an explicit mediaType");
  const publish = (target, expected, label) => {
    try { writeFileBytesSync(target, expected, { flag: "wx", mode: 0o600, durableRoot }); return false; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = strictRead(target, durableRoot);
      if (current === null) throw error; // A foreign temporary is not a destination.
      sameRepresentation(current, expected, label);
      return true;
    }
  };
  if (retained === null) conflict = publish(path, bytes, "body");
  // A racing body publisher may have been interrupted before its sidecar.
  if (conflict && heldType === null && input.mediaType === undefined) {
    heldType = strictRead(sidecar, durableRoot);
    if (heldType === null) throw custodyError("ERR_CUSTODY_MEDIA_TYPE_REQUIRED", "recovering absent metadata requires an explicit mediaType");
    sameRepresentation(heldType, metadata, "media type");
  }
  if (heldType === null) publish(sidecar, metadata, "media type");
  for (const [target, expected, label] of [[path, bytes, "body"], [sidecar, metadata, "media type"]])
    sameRepresentation(strictRead(target, durableRoot), expected, label);
  for (const target of [path, sidecar]) syncFileDurablySync(target, { durableRoot });
  for (const [target, expected, label] of [[path, bytes, "body"], [sidecar, metadata, "media type"]])
    sameRepresentation(strictRead(target, durableRoot), expected, label);
  return Object.freeze({ conflict, durable: true });
}
