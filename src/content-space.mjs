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

  /** One immutable NI path walk, with host-supplied read and child admission for bounded projections. */
  const tracePath = async (rootNi, path = [], { readTree: reader = readTree, admitChild } = {}) => {
    immutableContentKey(rootNi);
    if (!Array.isArray(path) || path.length > 16 ||
        typeof reader !== "function" ||
        (admitChild !== undefined && typeof admitChild !== "function"))
      throw new TypeError("content space: bounded path, reader and admission required");
    const slots = path.length === 0 ? Object.freeze([]) : admitContentTreePath(path);
    let ni = rootNi;
    const steps = [];
    for (const part of slots) {
      const tree = await reader(ni);
      if (tree === null) throw new Error("content space: path parent is unavailable");
      if (!tree || !Array.isArray(tree.entries))
        throw new TypeError("content space: source reader returned no content tree");
      const found = tree.entries.filter(entry => entry.name === part);
      if (found.length === 0) return null;
      if (found.length !== 1 || typeof found[0].ni !== "string")
        throw new TypeError("content space: ambiguous immutable link");
      const next = found[0].ni;
      immutableContentKey(next);
      if (admitChild && await admitChild(next) !== true)
        throw new RangeError("content space: addressed child not admitted");
      steps.push(Object.freeze({ from: ni, via: part, to: next }));
      ni = next;
    }
    return Object.freeze({ rootNi, ni, path: slots, steps: Object.freeze(steps) });
  };

  /** Read the named snapshot through that same original immutable path walk. */
  const atPath = async (name, path) => {
    const reference = holder(name);
    const slots = admitContentTreePath(path);
    const rootNi = reference.read();
    if (rootNi === null) return null;
    const trace = await tracePath(rootNi, slots);
    if (trace === null) return null;
    const retained = await get(trace.ni);
    if (retained === null) throw new Error("content space: path target is unavailable");
    return Object.freeze({ ...retained, rootNi, path: slots });
  };

  /**
   * Compose immutable Merkle ancestors around an already-retained target.
   * The ONLY mutable step is the existing compare-and-publish frontier.
   * Concurrent writers using the same expected root cannot silently merge
   * different histories: one succeeds and the other must retry explicitly.
   */
  /**
   * One CAS publication for several already-retained Merkle paths. Unlike
   * repeated linkPath calls this cannot expose a partially authored collection.
   * The original tree encoder and immutable frontier remain the only writers.
   */
  const linkPaths = async ({ name, expected, links }) => {
    const reference = holder(name);
    if (expected !== null) immutableContentKey(expected);
    if (!Array.isArray(links) || links.length < 1 || links.length > 128)
      throw new TypeError("content space: linkPaths requires 1 through 128 links");
    if (reference.read() !== expected)
      throw new TypeError("Persisted content reference changed before publication");

    const patch = { children: new Map() };
    const admitted = [];
    for (const link of links) {
      if (link === null || typeof link !== "object" || Array.isArray(link) ||
          Reflect.ownKeys(link).length !== 2 ||
          !Object.hasOwn(link, "path") || !Object.hasOwn(link, "ni"))
        throw new TypeError("content space: each link requires exactly path and ni");
      const pathField = Object.getOwnPropertyDescriptor(link, "path");
      const niField = Object.getOwnPropertyDescriptor(link, "ni");
      if (!Object.hasOwn(pathField, "value") || !Object.hasOwn(niField, "value"))
        throw new TypeError("content space: link fields must be own data values");
      const path = admitContentTreePath(pathField.value);
      const ni = niField.value;
      immutableContentKey(ni);
      let node = patch;
      for (const part of path) {
        if (node.ni !== undefined)
          throw new TypeError("content space: a link cannot contain another link path");
        if (!node.children.has(part)) node.children.set(part, { children: new Map() });
        node = node.children.get(part);
      }
      if (node.ni !== undefined || node.children.size !== 0)
        throw new TypeError("content space: duplicate or overlapping link paths");
      node.ni = ni;
      admitted.push(Object.freeze({ path, ni }));
    }

    // No immutable ancestor or mutable frontier may be written until every
    // caller-provided target has actually been admitted to this host.
    for (const { ni } of admitted)
      if (await custody.head(ni) === null)
        throw new Error("content space: cannot link unreceived content");

    const materialize = async (priorNi, node) => {
      const prior = priorNi === null ? { entries: [] } : await readTree(priorNi);
      if (prior === null) throw new Error("content space: path parent is unavailable");
      const entries = new Map(prior.entries.map(entry => [entry.name, entry.ni]));
      for (const [slot, child] of node.children) {
        const next = child.ni === undefined
          ? await materialize(entries.get(slot) ?? null, child)
          : child.ni;
        entries.set(slot, next);
      }
      return (await retainTree([...entries].map(([slot, ni]) => ({ name: slot, ni })))).ni;
    };
    const rootNi = await materialize(expected, patch);
    const published = reference.publish(expected, rootNi);
    return Object.freeze({
      name, before: expected, rootNi, links: Object.freeze(admitted), ...published,
    });
  };

  /** The existing single-path contract delegates to the same batch maker. */
  const linkPath = async ({ name, expected, path, ni }) => {
    const result = await linkPaths({ name, expected, links: [{ path, ni }] });
    const { links: unused, ...published } = result;
    return Object.freeze({ ...published, path: admittedSinglePath(path), ni });
  };
  const admittedSinglePath = path => admitContentTreePath(path);

  /**
   * Bounded, deterministic, verified inventory of a held Merkle DAG. Each
   * occurrence has its OWN path even when two paths reference the same NI.
   * This is custody structure, not a semantic graph, Chu pairing or license.
   * Host readers must independently admit the root and each child.
   */
  const walkTree = async (rootNi, {
    maximumNodes = 256, maximumDepth = 16, admitChild,
  } = {}) => {
    immutableContentKey(rootNi);
    if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 2048 ||
        !Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 16 ||
        (admitChild !== undefined && typeof admitChild !== "function"))
      throw new TypeError("content space: bounded walk budgets and optional admission required");
    const records = [];
    const active = new Set();
    const visit = async (ni, path) => {
      if (records.length >= maximumNodes)
        throw new RangeError("content space: tree walk exceeds node budget");
      const metadata = await custody.head(ni);
      if (metadata === null)
        throw new Error("content space: tree walk refers to unavailable content");
      const treeKind = metadata.mediaType === CONTENT_TREE_MEDIA_TYPE;
      records.push(Object.freeze({
        path: Object.freeze([...path]), ni,
        kind: treeKind ? "tree" : "object",
        mediaType: metadata.mediaType, byteLength: metadata.size,
      }));
      if (!treeKind) return;
      if (active.has(ni)) throw new TypeError("content space: cyclic content tree");
      active.add(ni);
      const tree = await readTree(ni);
      if (path.length >= maximumDepth && tree.entries.length !== 0)
        throw new RangeError("content space: tree walk exceeds depth budget");
      for (const entry of tree.entries) {
        const childPath = Object.freeze([...path, entry.name]);
        if (admitChild !== undefined &&
            await admitChild(entry.ni, { parentNi: ni, path: childPath }) !== true)
          throw new RangeError("content space: addressed child not admitted");
        await visit(entry.ni, childPath);
      }
      active.delete(ni);
    };
    await visit(rootNi, []);
    return Object.freeze({ rootNi, nodes: Object.freeze(records), count: records.length });
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
    /** Canonical typed-tree admission by its original store owner, BEFORE
     * any peer fetch follows child links or any named root is published.
     * No bytes are retained by inspecting an externally received carrier. */
    inspectTreeBytes: bytes => decodeContentTree(bytes, immutableContentKey),
    atPath,
    tracePath,
    walkTree,
    linkPaths,
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
