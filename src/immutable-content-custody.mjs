import { createHash } from "node:crypto";

import {
  isNiUri,
  niUriDigest,
  verifyNiUri,
} from "@red-cup-engineering/uri-services-section/ni-uri";

const DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024;
const PROFILE = "org.red-cup-engineering.immutable-content-reference.v1";
const digest = (bytes, encoding) => createHash("sha256").update(bytes).digest(encoding);

function requiredStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.putCurrent !== "function") {
    throw new TypeError("immutable content custody requires a store with get and putCurrent operations");
  }
  return store;
}

function maximumBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("maximumBytes must be one positive safe integer");
  return value;
}

function exactBytes(value, limit) {
  const bytes = Buffer.from(value ?? []);
  if (bytes.length === 0 || bytes.length > limit) {
    throw new RangeError(`immutable content must contain 1 through ${limit} bytes`);
  }
  return bytes;
}

function identity(ni) {
  if (!isNiUri(ni)) throw new TypeError("content identity must be one canonical SHA-256 ni URI");
  return niUriDigest(ni);
}

/**
 * @param {string} ni Canonical content identity.
 * @returns {string} Immutable object-store key.
 * @throws {TypeError} If the identity is not a canonical SHA-256 ni URI.
 */
export function immutableContentKey(ni) {
  const suffix = identity(ni);
  return `immutable/sha-256/${suffix.slice(0, 2)}/${suffix}`;
}

function verify(ni, bytes) {
  identity(ni);
  if (!verifyNiUri(bytes, ni)) throw new Error("content bytes do not match their declared ni identity");
}

/**
 * @typedef {{body: Uint8Array, mediaType?: string, etag?: string}} StoredContent
 * @typedef {{get: (key: string) => Promise<StoredContent | null>, putCurrent: (key: string, value: StoredContent & {byteLength: number, sha256: string}) => Promise<unknown>}} ContentStore
 * @typedef {{profile: string, ni: string, key: string, byteLength: number, mediaType: string}} ContentReference
 */

/**
 * @param {{store?: ContentStore, maximumBytes?: number}} [options] Injected custody boundary and upload limit.
 * @returns {{put: (input: {ni: string, bytes: Uint8Array, mediaType?: string}) => Promise<Readonly<ContentReference>>, get: (reference: string | ContentReference) => Promise<Readonly<{ni: string, bytes: Buffer, mediaType: string, etag: string | undefined}> | null>}} Verified custody operations.
 * @throws {TypeError} If the store lacks its required operations.
 * @throws {RangeError} If maximumBytes is not a positive safe integer.
 */
export function createImmutableContentCustody({ store, maximumBytes: offeredMaximum = DEFAULT_MAXIMUM_BYTES } = {}) {
  const objects = requiredStore(store);
  const limit = maximumBytes(offeredMaximum);

  async function get(referenceOrNi) {
    const ni = typeof referenceOrNi === "string" ? referenceOrNi : referenceOrNi?.ni;
    const key = immutableContentKey(ni);
    if (typeof referenceOrNi === "object"
      && (referenceOrNi.profile !== PROFILE || referenceOrNi.key !== key)) {
      throw new Error("foreign immutable content reference");
    }
    const object = await objects.get(key);
    if (!object) return null;
    const bytes = Buffer.from(object.body);
    verify(ni, bytes);
    return Object.freeze({
      ni,
      bytes,
      mediaType: object.mediaType ?? "application/octet-stream",
      etag: object.etag,
    });
  }

  async function put({ ni, bytes: source, mediaType = "application/octet-stream" }) {
    const bytes = exactBytes(source, limit);
    const key = immutableContentKey(ni);
    verify(ni, bytes);
    await objects.putCurrent(key, {
      body: bytes,
      byteLength: bytes.length,
      sha256: digest(bytes, "hex"),
      mediaType,
    });
    const retained = await get(ni);
    if (!retained || !retained.bytes.equals(bytes)) {
      throw new Error("content custody read-back failed");
    }
    return Object.freeze({
      profile: PROFILE,
      ni,
      key,
      byteLength: bytes.length,
      mediaType: retained.mediaType ?? mediaType,
    });
  }

  // Native file custody verifies the complete current body with bounded I/O
  // before metadata or a range leaves custody. Other stores use verified get().
  async function head(ni) {
    if (typeof objects.verify === "function") return objects.verify(immutableContentKey(ni), ni);
    if (typeof objects.head !== "function") {
      const found = await get(ni);
      return found && Object.freeze({ ni, size: found.bytes.length, mediaType: found.mediaType });
    }
    const found = await get(ni);
    return found && Object.freeze({ ni, size: found.bytes.length, mediaType: found.mediaType });
  }

  async function read(ni, range) {
    if (typeof objects.verify === "function") return (await objects.verify(immutableContentKey(ni), ni, { range }))?.bytes ?? null;
    // A generic store range cannot verify the entire declared body.

    const found = await get(ni);
    return found && found.bytes.subarray(range.start, range.end + 1);
  }

  return Object.freeze({ put, get, head, read });
}

/** @type {string} */
export const IMMUTABLE_CONTENT_REFERENCE_PROFILE = PROFILE;
/** @type {number} */
export const IMMUTABLE_CONTENT_DEFAULT_MAXIMUM_BYTES = DEFAULT_MAXIMUM_BYTES;

function freezeVerifiedValue(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("verified content results must contain only records, arrays, and primitives");
  }
  seen.add(value);
  for (const child of Object.values(value)) freezeVerifiedValue(child, seen);
  return Object.freeze(value);
}

/**
 * Read current bytes on every call and memoize one pure verifier by exact content.
 * The reader instance fixes verifier identity; verification must depend only on bytes.
 * Results are deeply frozen records/arrays. Limits bound retained input bytes and
 * result count; oversized inputs are verified without retention. Throws are not cached.
 * @template Key, Value
 * @param {{read: (key: Key) => Uint8Array, verify: (bytes: Buffer) => Value, maximumEntries?: number, maximumBytes?: number}} options
 * @returns {(key: Key) => Value} Synchronous verified read operation.
 * @throws {TypeError} If an adapter or its input/result is unsupported.
 * @throws {RangeError} If a cache limit is not a positive safe integer.
 */
export function createVerifiedContentReader({ read, verify: verifyContent, maximumEntries = 4096, maximumBytes: byteBudget = 64 * 1024 * 1024 }) {
  if (typeof read !== "function" || typeof verifyContent !== "function") {
    throw new TypeError("verified content reader requires read and verify functions");
  }
  maximumBytes(maximumEntries);
  maximumBytes(byteBudget);
  const entries = new Map();
  let retainedBytes = 0;
  return (key) => {
    const source = read(key);
    if (!(source instanceof Uint8Array)) throw new TypeError("verified content read must return bytes");
    const bytes = Buffer.from(source);
    const hash = digest(bytes, "hex");
    const cached = entries.get(hash);
    if (cached !== undefined && cached.bytes.equals(bytes)) {
      entries.delete(hash);
      entries.set(hash, cached);
      return cached.value;
    }
    const value = freezeVerifiedValue(verifyContent(Buffer.from(bytes)));
    if (bytes.length > byteBudget) return value;
    if (cached !== undefined) {
      entries.delete(hash);
      retainedBytes -= cached.bytes.length;
    }
    while (entries.size >= maximumEntries || retainedBytes + bytes.length > byteBudget) {
      const oldest = entries.keys().next().value;
      retainedBytes -= entries.get(oldest).bytes.length;
      entries.delete(oldest);
    }
    entries.set(hash, { bytes, value });
    retainedBytes += bytes.length;
    return value;
  };
}
