#!/usr/bin/env node
/**
 * Host-operated shell boundary over the ORIGINAL immutable NI content space.
 *
 * A trusted operator selects one absolute installed configuration. No HTTP
 * request, namespace string or content object may supply a storage root,
 * permission, witness or actor authority. This provides the same source-owned
 * Merkle tree/compare-and-publish operations to non-JavaScript programs.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createContentAddressedSpace } from "../src/content-space.mjs";
import { createFileContentCustody } from "../src/file-content-custody.mjs";

const DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024;
const OPTIONS = Object.freeze({
  config: { type: "string" },
  name: { type: "string" },
  expected: { type: "string" },
  path: { type: "string" },
  file: { type: "string" },
  ni: { type: "string" },
  out: { type: "string" },
  "media-type": { type: "string" },
  manifest: { type: "string" },
  "maximum-nodes": { type: "string" },
  "maximum-depth": { type: "string" },
});
const REQUIRED = Object.freeze({
  retain: ["config", "file"],
  put: ["config", "name", "expected", "path", "file"],
  link: ["config", "name", "expected", "path", "ni"],
  "link-batch": ["config", "name", "expected", "manifest"],
  get: ["config", "out"],
  tree: ["config", "ni"],
  at: ["config", "name", "path"],
  resolve: ["config", "name"],
  list: ["config"],
  walk: ["config"],
});
const PERMITTED = Object.freeze({
  retain: ["file", "media-type"],
  put: ["name", "expected", "path", "file", "media-type"],
  link: ["name", "expected", "path", "ni"],
  "link-batch": ["name", "expected", "manifest"],
  get: ["out", "ni", "name", "path"],
  tree: ["ni"],
  at: ["name", "path"],
  resolve: ["name"],
  list: [],
  walk: ["name", "ni", "maximum-nodes", "maximum-depth"],
});

const ordinary = (path, label) => {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new TypeError(`custody-space: ${label} must be an absolute host-selected file`);
  const st = lstatSync(path, { bigint: true });
  if (!st.isFile()) throw new TypeError(`custody-space: ${label} must be a regular file`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || st.dev !== opened.dev || st.ino !== opened.ino ||
        st.size !== opened.size || st.mtimeNs !== opened.mtimeNs ||
        st.ctimeNs !== opened.ctimeNs)
      throw new TypeError(`custody-space: ${label} changed before opening`);
    return { fd, before: opened };
  } catch (error) { closeSync(fd); throw error; }
};
function boundedFile(path, maximumBytes, label) {
  const { fd, before } = ordinary(path, label);
  try {
    if (before.size > BigInt(maximumBytes))
      throw new RangeError(`custody-space: ${label} exceeds installed byte budget`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (bytes.byteLength !== Number(before.size) ||
        [after, current].some(st =>
          !st.isFile() || st.dev !== before.dev || st.ino !== before.ino ||
          st.size !== before.size || st.mtimeNs !== before.mtimeNs ||
          st.ctimeNs !== before.ctimeNs))
      throw new TypeError(`custody-space: ${label} changed during admission`);
    return bytes;
  } finally { closeSync(fd); }
}
function installedConfig(file) {
  const bytes = boundedFile(file, 65536, "configuration");
  let config;
  try { config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("custody-space: host configuration must be UTF-8 JSON"); }
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(k => !["root", "durableRoot", "namespaces", "maximumBytes"].includes(k)) ||
      !Array.isArray(config.namespaces))
    throw new TypeError("custody-space: only root, durableRoot, namespaces and maximumBytes are admitted");
  const budget = config.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 1)
    throw new RangeError("custody-space: maximumBytes must be a positive safe integer");
  return { config, budget };
}
function pathSegments(text) {
  try { return JSON.parse(text); }
  catch { throw new TypeError("custody-space: --path must be a JSON array of canonical segments"); }
}
const expectation = value => value === "none" ? null : value;
const naturalOption = (value, label) => {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new TypeError(`custody-space: --${label} requires one canonical nonnegative integer`);
  return Number(value);
};
function batchManifest(file) {
  const bytes = boundedFile(file, 65536, "link manifest");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("custody-space: link manifest requires UTF-8 JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, "links"))
    throw new TypeError("custody-space: link manifest must contain only links");
  return value.links;
}

/**
 * Run one originally supported operation against an installed host root.
 * Output is a JSON-serializable address/receipt; never raw unbounded bytes.
 */
export async function runCustodySpace(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || !Object.hasOwn(REQUIRED, argv[0]))
    throw new TypeError("custody-space: expected retain, put, link, link-batch, walk, get, tree, at, resolve or list");
  const [command, ...args] = argv;
  const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  if (positionals.length !== 0) throw new TypeError("custody-space: unrecognized positional arguments");
  for (const flag of REQUIRED[command])
    if (typeof values[flag] !== "string" || values[flag].length === 0)
      throw new TypeError(`custody-space: --${flag} is required for ${command}`);
  for (const flag of Object.keys(values))
    if (flag !== "config" && !PERMITTED[command].includes(flag))
      throw new TypeError(`custody-space: --${flag} is not part of ${command}`);
  const { config, budget } = installedConfig(values.config);
  const space = createContentAddressedSpace(config);
  const mediaType = values["media-type"] ?? "application/octet-stream";
  switch (command) {
    case "retain": {
      const bytes = boundedFile(values.file, budget, "source");
      return space.retain(bytes, { mediaType });
    }
    case "put": {
      const bytes = boundedFile(values.file, budget, "source");
      return space.putPath({
        name: values.name, expected: expectation(values.expected),
        path: pathSegments(values.path), bytes, mediaType,
      });
    }
    case "link":
      return space.linkPath({
        name: values.name, expected: expectation(values.expected),
        path: pathSegments(values.path), ni: values.ni,
      });
    case "link-batch":
      return space.linkPaths({
        name: values.name, expected: expectation(values.expected),
        links: batchManifest(values.manifest),
      });
    case "walk": {
      const named = values.name !== undefined;
      if (named === (values.ni !== undefined))
        throw new TypeError("custody-space walk: select exactly one --name or --ni");
      const rootNi = named ? space.resolve(values.name) : values.ni;
      if (rootNi === null) return { found: false, name: values.name };
      const maximumNodes = naturalOption(values["maximum-nodes"], "maximum-nodes");
      const maximumDepth = naturalOption(values["maximum-depth"], "maximum-depth");
      return {
        found: true,
        ...(named ? { name: values.name } : {}),
        ...await space.walkTree(rootNi, {
          ...(maximumNodes === undefined ? {} : { maximumNodes }),
          ...(maximumDepth === undefined ? {} : { maximumDepth }),
        }),
      };
    }
    case "get": {
      // Exactly one coordinate: either a direct NI or a named Merkle snapshot
      // slot. Never interpret a URL/file path as a content-addressed name.
      const direct = values.ni !== undefined;
      const named = values.name !== undefined && values.path !== undefined;
      if (direct === named || (direct && (values.name !== undefined || values.path !== undefined)) ||
          (!direct && !named))
        throw new TypeError("custody-space get: require either --ni or --name with --path");
      const target = values.out;
      if (!isAbsolute(target) || resolve(target) !== target ||
          realpathSync(dirname(target)) !== dirname(target))
        throw new TypeError("custody-space get: output requires an absolute path with a real parent");
      for (const input of [config.root, config.durableRoot]) {
        const prefix = resolve(input);
        if (target === prefix || target.startsWith(prefix + sep))
          throw new TypeError("custody-space get: cannot materialize into shared custody");
      }
      const held = direct ? await space.head(values.ni)
        : await space.atPath(values.name, pathSegments(values.path));
      if (held === null)
        throw new RangeError("custody-space get: selected content is not retained");
      const ni = held.ni;
      const size = direct ? held.size : held.bytes.byteLength;
      if (size > budget)
        throw new RangeError("custody-space get: selected content exceeds installed byte budget");
      // This original File Custody producer stores bodies at exactly the same
      // immutableContentKey under root/objects; it hashes the full source
      // during copy, publishes only after the identity matches, and refuses
      // to replace an existing target. The shared-space admission above
      // additionally enforces the complete canonical media-type sidecar.
      const copied = createFileContentCustody({ root: config.root, maximumBytes: budget })
        .copyOut(ni, target);
      return Object.freeze({
        ...copied, mediaType: held.mediaType,
        ...(direct ? {} : { name: values.name, rootNi: held.rootNi, path: held.path }),
      });
    }
    case "tree": {
      const value = await space.readTree(values.ni);
      return { found: value !== null, rootNi: values.ni,
        ...(value === null ? {} : { tree: value }) };
    }
    case "at": {
      const value = await space.atPath(values.name, pathSegments(values.path));
      return value === null
        ? { found: false, name: values.name }
        : { found: true, name: values.name, ni: value.ni, rootNi: value.rootNi,
          path: value.path, mediaType: value.mediaType, byteLength: value.bytes.byteLength };
    }
    case "resolve":
      return { name: values.name, ni: space.resolve(values.name) };
    case "list":
      return { namespaces: space.list() };
  }
}

// npm/pnpm install binaries as symlinks. Compare resolved file identities,
// not argv's symlink spelling; importing this module as a library stays inert.
const directInvocation = process.argv[1] !== undefined && (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (directInvocation) {
  try {
    const result = await runCustodySpace(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    // The CLI reports failure without echoing original file contents, caller
    // credentials or arbitrary thrown object properties.
    const expected = error instanceof TypeError || error instanceof RangeError;
    process.stderr.write(JSON.stringify({
      kind: "immutable-content-custody-refusal",
      code: typeof error?.code === "string" ? error.code : "ERR_CONTENT_SPACE_COMMAND",
      message: expected ? error.message : "content-space operation refused",
    }) + "\n");
    process.exitCode = 1;
  }
}
