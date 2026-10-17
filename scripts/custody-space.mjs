#!/usr/bin/env node
/**
 * Host-operated shell boundary over the ORIGINAL immutable NI content space.
 *
 * A trusted operator selects one absolute installed configuration. No HTTP
 * request, namespace string or content object may supply a storage root,
 * permission, witness or actor authority. This provides the same source-owned
 * Merkle tree/compare-and-publish operations to non-JavaScript programs.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createContentAddressedSpace } from "../src/content-space.mjs";

const DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024;
const OPTIONS = Object.freeze({
  config: { type: "string" },
  name: { type: "string" },
  expected: { type: "string" },
  path: { type: "string" },
  file: { type: "string" },
  ni: { type: "string" },
  "media-type": { type: "string" },
});
const REQUIRED = Object.freeze({
  retain: ["config", "file"],
  put: ["config", "name", "expected", "path", "file"],
  link: ["config", "name", "expected", "path", "ni"],
  tree: ["config", "ni"],
  at: ["config", "name", "path"],
  resolve: ["config", "name"],
  list: ["config"],
});
const PERMITTED = Object.freeze({
  retain: ["file", "media-type"],
  put: ["name", "expected", "path", "file", "media-type"],
  link: ["name", "expected", "path", "ni"],
  tree: ["ni"],
  at: ["name", "path"],
  resolve: ["name"],
  list: [],
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

/**
 * Run one originally supported operation against an installed host root.
 * Output is a JSON-serializable address/receipt; never raw unbounded bytes.
 */
export async function runCustodySpace(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || !Object.hasOwn(REQUIRED, argv[0]))
    throw new TypeError("custody-space: expected retain, put, link, tree, at, resolve or list");
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
