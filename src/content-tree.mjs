/**
 * One deterministic, immutable directory of already-addressed content.
 *
 * This is a storage-carrier projection, not a substitute for SignGraph edges,
 * typed predicates, proof witnesses, a Guix derivation or a UnixFS root.
 * An entry's name is a local exact byte-free slot; its NI names exact bytes.
 * The NI of the encoded tree names its canonical UTF-8 representation, not
 * the concatenation of the objects to which its entries refer.
 */

export const CONTENT_TREE_MEDIA_TYPE = "application/vnd.561.content-tree+json";
export const CONTENT_TREE_KIND = "semiotic-content.content-tree";
export const CONTENT_TREE_VERSION = 1;
const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_ENTRIES = 256;

/** Encode one bounded canonical tree. admitAddress is the original NI validator. */
export function encodeContentTree(entries, admitAddress) {
  if (typeof admitAddress !== "function")
    throw new TypeError("content tree requires the original NI address admission operation");
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    throw new TypeError("content tree requires at most " + MAX_ENTRIES + " explicit entries");
  const seen = new Set();
  const ordered = entries.map(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "name") ||
        !Object.hasOwn(entry, "ni"))
      throw new TypeError("content tree entries have exactly name and ni fields");
    if (typeof entry.name !== "string" || entry.name.length > 128 || !NAME.test(entry.name))
      throw new TypeError("content tree entry names are bounded, single-segment, lowercase ASCII");
    if (seen.has(entry.name)) throw new TypeError("content tree entry names must be unique");
    seen.add(entry.name);
    // Identity admission stays with the original immutable NI owner. No rival
    // digest spelling or reinterpretation is admitted here.
    admitAddress(entry.ni);
    return { name: entry.name, ni: entry.ni };
  });
  ordered.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return Buffer.from(JSON.stringify({
    kind: CONTENT_TREE_KIND, version: CONTENT_TREE_VERSION, entries: ordered,
  }) + "\n", "utf8");
}

/** Read canonical tree bytes without interpreting any resource relationship. */
export function decodeContentTree(bytes, admitAddress) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("content tree requires exact bytes");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("content tree must be valid UTF-8 JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.kind !== CONTENT_TREE_KIND || value.version !== CONTENT_TREE_VERSION)
    throw new TypeError("content tree kind or version is not admitted");
  const canonical = encodeContentTree(value.entries, admitAddress);
  if (!Buffer.from(bytes).equals(canonical))
    throw new TypeError("content tree bytes must be canonical, with no additional fields or ordering variants");
  return Object.freeze({
    kind: CONTENT_TREE_KIND,
    version: CONTENT_TREE_VERSION,
    entries: Object.freeze(value.entries.map(entry => Object.freeze({ name: entry.name, ni: entry.ni }))),
  });
}
