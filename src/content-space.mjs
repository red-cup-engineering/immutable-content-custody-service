/**
 * One host-admitted content-addressed space for code and non-code bytes.
 *
 * NI identifies raw bytes; names are separate, versioned mutable frontiers.
 * Multiple Code, Science and Public consumers can bind the SAME durableRoot
 * and receive the same byte identity without pretending their file paths,
 * Git OIDs, IPFS CIDs or Guix references are interchangeable addresses.
 *
 * This is a library over the ORIGINAL NI custody, strict File writer, and
 * immutable frontier owners. It does not create mounts, authenticate a caller,
 * traverse a checkout, expose an HTTP endpoint, or grant read/write rights.
 */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { createFileStore } from "./file-store.mjs";
import { createImmutableContentCustody, immutableContentKey } from "./immutable-content-custody.mjs";
import { createFileContentReference } from "./file-content-reference.mjs";

const NAME_PART = /^[a-z0-9][a-z0-9._-]*$/u;
const named = value => {
  if (typeof value !== "string" || value.length > 512) throw new TypeError("content space: a bounded namespace name is required");
  const segments = value.split("/");
  if (!segments.length || segments.length > 16 ||
      segments.some(s => !NAME_PART.test(s) || s === "." || s === ".." || s.endsWith(".json")))
    throw new TypeError("content space: namespace segments must be canonical and cannot traverse paths");
  return segments;
};
const directory = (value, label) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`content space: ${label} must be an installed absolute directory`);
  const path = resolve(value);
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new TypeError(`content space: ${label} must be an ordinary non-redirected directory`);
  return path;
};

/**
 * Create a shared, deterministic NI byte store with named versioned roots.
 *
 * The host has independently established durability and access to the
 * existing durableRoot and root. No submitted resource or URL chooses them.
 * A namespace declaration is admission data, not proof of authority.
 */
export function createContentAddressedSpace({
  root, durableRoot, namespaces = [], maximumBytes,
} = {}) {
  const anchor = directory(durableRoot, "durableRoot");
  const located = directory(root, "root");
  const within = relative(anchor, located);
  if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
    throw new TypeError("content space: root must belong to its existing durable anchor");
  if (!Array.isArray(namespaces) || namespaces.length > 128)
    throw new TypeError("content space: at most 128 host-admitted namespaces are supported");
  const holders = new Map();
  for (const name of namespaces) {
    const parts = named(name);
    if (holders.has(name)) throw new TypeError("content space: duplicate namespace declaration");
    const path = join(located, "names", ...parts) + ".json";
    holders.set(name, createFileContentReference(path, { durableRoot: anchor }));
  }
  const custody = createImmutableContentCustody({
    store: createFileStore(located, { durableRoot: anchor, requireCompleteRepresentation: true }),
    ...(maximumBytes === undefined ? {} : { maximumBytes }),
  });
  const holder = name => {
    const selected = holders.get(name);
    if (selected === undefined) throw new TypeError("content space: namespace is not admitted by this host");
    return selected;
  };
  const get = async ni => {
    immutableContentKey(ni);
    // The existing verifyContentFile opens the actual leaf without following a
    // symlink and verifies all current source bytes before get's exact read.
    // As with File custody, topology must remain stable during this operation.
    const actual = await custody.head(ni);
    return actual === null ? null : custody.get(ni);
  };
  const at = async name => {
    const ni = holder(name).read();
    if (ni === null) return null;
    const retained = await get(ni);
    if (retained === null) throw new Error("content space: a named root refers to unavailable bytes");
    return retained;
  };
  return Object.freeze({
    kind: "semiotic-content.addressed-space.v1",
    namespaces: Object.freeze([...holders.keys()]),
    /** Content identity is computed by the existing URI/Data owner. */
    async retain(bytes, { mediaType = "application/octet-stream" } = {}) {
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("content space: retain requires explicit raw bytes");
      return custody.put({ ni: makeNiUri(bytes), bytes, mediaType });
    },
    get,
    head: ni => custody.head(ni),
    range: (ni, range) => custody.read(ni, range),
    resolve: name => holder(name).read(),
    at,
    /**
     * Compare-and-publish one admitted name to already-custodied content.
     * The transition is committed by the original immutable frontier owner;
     * this method never rewrites a content blob or chooses an external mount.
     */
    async bind({ name, expected, ni }) {
      const reference = holder(name);
      if (expected !== null) immutableContentKey(expected);
      immutableContentKey(ni);
      if (await custody.head(ni) === null)
        throw new Error("content space: cannot bind a name to unreceived content");
      const published = reference.publish(expected, ni);
      return Object.freeze({ name, before: expected, ni, ...published });
    },
    /** Only the host-admitted namespace surface is enumerable. */
    list: () => Object.freeze([...holders].map(([name, ref]) =>
      Object.freeze({ name, ni: ref.read() }))),
  });
}
