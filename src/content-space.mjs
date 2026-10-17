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
import { CONTENT_TREE_MEDIA_TYPE, encodeContentTree, decodeContentTree, admitContentTreePath } from "./content-tree.mjs";

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

  /** Retain a canonical tree only after its immediate target bytes are held. */
  const retainTree = async entries => {
    const bytes = encodeContentTree(entries, immutableContentKey);
    const tree = decodeContentTree(bytes, immutableContentKey);
    for (const entry of tree.entries) {
      if (await custody.head(entry.ni) === null)
        throw new Error("content space: tree entry refers to unreceived content: " + entry.name);
    }
    return custody.put({ ni: makeNiUri(bytes), bytes, mediaType: CONTENT_TREE_MEDIA_TYPE });
  };

  const readTree = async ni => {
    const retained = await get(ni);
    if (retained === null) return null;
    if (retained.mediaType !== CONTENT_TREE_MEDIA_TYPE)
      throw new TypeError("content space: requested NI does not name a content tree");
    return decodeContentTree(retained.bytes, immutableContentKey);
  };

  /**
   * Read an immutable snapshot through an admitted name and explicit tree
   * slots. Return the root NI too: a concurrent rebinding cannot turn an old
   * snapshot into a claim about the new frontier.
   */
  const atPath = async (name, path) => {
    const reference = holder(name);
    const slots = admitContentTreePath(path);
    const rootNi = reference.read();
    if (rootNi === null) return null;
    let currentNi = rootNi;
    for (const slot of slots) {
      const tree = await readTree(currentNi);
      if (tree === null) throw new Error("content space: path parent is unavailable");
      const child = tree.entries.find(entry => entry.name === slot);
      if (child === undefined) return null;
      currentNi = child.ni;
    }
    const retained = await get(currentNi);
    if (retained === null) throw new Error("content space: path target is unavailable");
    return Object.freeze({ ...retained, rootNi, path: slots });
  };

  /**
   * Compose immutable Merkle ancestors around an already-retained target.
   * The ONLY mutable step is the existing compare-and-publish frontier.
   * Concurrent writers using the same expected root cannot silently merge
   * different histories: one succeeds and the other must retry explicitly.
   */
  const linkPath = async ({ name, expected, path, ni }) => {
    const reference = holder(name);
    const slots = admitContentTreePath(path);
    if (expected !== null) immutableContentKey(expected);
    immutableContentKey(ni);
    if (reference.read() !== expected)
      throw new TypeError("Persisted content reference changed before publication");
    if (await custody.head(ni) === null)
      throw new Error("content space: cannot link unreceived content");

    const replace = async (parentNi, depth) => {
      const tree = parentNi === null ? { entries: [] } : await readTree(parentNi);
      if (tree === null) throw new Error("content space: path parent is unavailable");
      const slot = slots[depth];
      const previous = tree.entries.find(entry => entry.name === slot);
      const childNi = depth === slots.length - 1
        ? ni : await replace(previous?.ni ?? null, depth + 1);
      const entries = [...tree.entries.filter(entry => entry.name !== slot), { name: slot, ni: childNi }];
      return (await retainTree(entries)).ni;
    };

    const rootNi = await replace(expected, 0);
    const published = reference.publish(expected, rootNi);
    return Object.freeze({ name, before: expected, rootNi, ni, path: slots, ...published });
  };

  /**
   * One hosted authoring operation: retain exact bytes, materialize immutable
   * ancestors, then move the admitted name with an expected-root CAS.
   * A losing writer may leave valid unreferenced immutable bytes; it cannot
   * overwrite a winning frontier or publish an incomplete tree.
   */
  const putPath = async ({ name, expected, path, bytes, mediaType = "application/octet-stream" }) => {
    const reference = holder(name);
    const slots = admitContentTreePath(path);
    if (expected !== null) immutableContentKey(expected);
    if (reference.read() !== expected)
      throw new TypeError("Persisted content reference changed before publication");
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("content space: putPath requires explicit raw bytes");
    const retained = await custody.put({ ni: makeNiUri(bytes), bytes, mediaType });
    const published = await linkPath({ name, expected, path: slots, ni: retained.ni });
    return Object.freeze({ ...published, retained });
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
    /**
     * Immutable Merkle directory: an explicitly named, sorted set of links
     * to already retained bodies. Its own NI names canonical tree bytes.
     * This does not invent a graph predicate, file mount, or new content ID.
     */
    retainTree,
    readTree,
    atPath,
    linkPath,
    putPath,
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
