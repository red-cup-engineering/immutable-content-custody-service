# Immutable Content Custody Service

Retains and retrieves exact bytes under a SHA-256 ni URI.

This package owns exact byte custody and verification. Callers supply its storage
boundary; provider and network transport remain outside it. Object custody takes `get(key)` and `putCurrent(key, value)` operations:

```js
const custody = createImmutableContentCustody({ store, maximumBytes: 8 * 1024 * 1024 });
await custody.put({ ni, bytes, mediaType: "application/json" });
const retained = await custody.get(ni);
```

Cloudflare R2 wiring belongs to
`@red-cup-engineering/cloudflare-r2-services-section/immutable-content-custody`.
The default maximum remains 8 MiB; larger bounded artifact classes must opt in
with an explicit positive safe-integer `maximumBytes`.

For existing files, the native ./file-content export provides createFileContentCustody({root, maximumBytes?}), identifyContentFile(path) and verifyContentFile(path, ni, options?). The root and any byte budget are host-owned. retainFile(path, {expectedNi?, mediaType?}) streams a regular file into the same immutable-content key space with exact raw RFC ni identity; it refuses changed input and verifies read-back. There is no fixed source-file size cutoff. Empty bodies are valid in this file carrier.

window(ni, {offset, limit}) returns a fatal-decoded UTF-8 view measured in Unicode codepoints, up to 16384 characters. Each view verifies the complete current physical body with bounded I/O; it retains only the selected output and an I/O block. File replacement cannot change an already held body. Corruption outside the selected window still refuses the read. Metadata and byte ranges from native file custody use the same current-body verification. A generic object store uses verified get before exposing them; raw unaddressed store reads retain their separate byte-range behavior.

A raw file ni names bytes. A source descriptor names the semantic relation between its admitted locator and those bytes. Neither name establishes a program's semantic contract or authority to read it. AOE derives source references from the receiver's exact readable snapshot, lets agents select them by identity, and rechecks current source and authority before returning a bounded view. Large source bodies are held once, rather than embedded repeatedly in the derivation journal.

`copyOut(ni, destination)` streams the held body to a new file, hashing while it writes. It leaves nothing at `destination` when the body does not match its ni, and it refuses an existing destination. `scripts/custody-file.mjs` is the command line for this carrier: `retain`, `verify` and `get` for a file, and `retain-tree` and `get-tree` for a directory. A tree is held as one deterministic gzip tar (sorted names, zero mtime and owner, no gzip name or time), so the same tree has one address; `get-tree` unpacks it into a directory that does not yet exist. The host names the root on every call. The house's bulk observations are held at `lib/emsenn/services/561-group/services/561-group-services-section/data/state/content-custody`, which Git ignores; a record in the owning section names each payload's ni, size and packaging.

## Native custody command

The package ships `custody-file` from the same native custody source as the
file-content exports. Every call names the host-owned root and the command's
required inputs. Importing the command remains inert. `retain-tree` composes
GNU tar and gzip with argument arrays, checks both producer outcomes, and
publishes the archive only after both succeed. It does not turn a failed tar
producer into a retained gzip object or replace an existing target on failure.
These commands require the native tar/gzip tools; source integration is
separate from installation and custody of a particular host's files.

## File-store first-write recovery

`createFileStoreSync(root).putIfAbsent(key, {body, mediaType})` keeps the first
body under the existing key. A different proposed body returns `{conflict:true}`
without changing either the retained bytes or their media-type sidecar. An
already retained matching body also returns `{conflict:true}`.

Body and sidecar publication are separate, atomic exclusive file operations.
If a process stops after publishing the body, a later call with those exact
bytes can finish an absent sidecar. A competing sidecar is read back under the
existing media-type reading semantics and never overwritten. Incompatible
retained media returns `{conflict:true}`, including when this caller published
the body but another caller published incompatible metadata first.

A conflict is not proof that the caller's complete representation is held.
Consumers with a required media type must read back both the exact bytes and
that media type before acknowledging their own record. `putCurrent` keeps its
separate replacement contract.
