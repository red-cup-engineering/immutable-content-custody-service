/**
 * An object store in one directory, the store shape immutable content custody
 * takes: each key is a file of its raw bytes under `<root>/objects/`, with its
 * media type in a `<file>.media-type` sidecar. Beyond get and putCurrent it
 * answers head, byte-range reads and prefix listing, so custody can serve large
 * media (video, audio) without reading whole files.
 */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { verifyContentFile } from "./file-content-custody.mjs";
import { relative, resolve, sep } from "node:path";
import { walkPosixPathsSync } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { writeFileBytesSync } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { extensionType } from "@red-cup-engineering/computer-serialized-content-engineering-services-section/services/http-data-services-section/src/media-type";

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

export function createFileStoreSync(root) {
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
    putIfAbsent(key, { body, mediaType = "application/octet-stream" }) {
      const path = pathOf(key);
      try { writeFileBytesSync(path, Buffer.from(body), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error?.code === "EEXIST") return Object.freeze({ conflict: true }); throw error; }
      writeFileSync(path + ".media-type", mediaType + "\n", { mode: 0o600 });
      return Object.freeze({ conflict: false });
    },
    putCurrent(key, { body, mediaType = "application/octet-stream" }) {
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
export function createFileStore(root) {
  const store = createFileStoreSync(root);
  return Object.freeze(Object.fromEntries(Object.entries(store).map(([key, value]) =>
    [key, typeof value === "function" ? async (...args) => value(...args) : value])));
}
