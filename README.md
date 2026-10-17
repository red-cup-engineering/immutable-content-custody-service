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

## Strict durable publication

`createFileStoreSync(root, {durableRoot})` and `createFileStore(root, {durableRoot})`
opt into [the strict file-store contract](specifications/strict-file-store.md).
Only exact body and canonical media-type custody with both full barriers returns
`durable: true`, including exact duplicates. Missing sidecar recovery requires an
explicit type. Strict replacement refuses before mutation; default callers retain
the existing APIs and behavior. Read observations are not durability receipts.


## Shared content-addressed space: byte identity and named frontiers

`./space` now composes this **original** NI custody producer, the strict
physical File Engineering writer and the existing immutable-reference chain
as one host-installed library. This is the reusable binary foundation for
code, datasets, designs, images, scientific carriers and package materials.

```js
import { createContentAddressedSpace } from "@red-cup-engineering/immutable-content-custody-service/space";

const space = createContentAddressedSpace({
  // Installed and authorized by the host, never a request parameter.
  root: "/srv/561/shared-content",
  durableRoot: "/srv/561/shared-content",
  namespaces: ["science/l-space", "engineering/source", "operations/receiving"],
});
const retained = await space.retain(new Uint8Array([0, 255, 1]), {
  mediaType: "application/octet-stream",
});
await space.bind({ name: "engineering/source", expected: null, ni: retained.ni });
const bytes = (await space.at("engineering/source")).bytes;
```

**No new identity format:** The original URI owner mints the RFC 6920 SHA-256
`ni:///sha-256;…`. The original immutable custody owner derives
`immutable/sha-256/<first-two-digest-characters>/<digest>`; File Engineering
owns first-write publication, recovery and full ancestry fsync. A duplicate
with the same bytes and canonical media type is idempotent. Empty files have
a real NI. Conflicting media is refused instead of overwriting a first-writer
sidecar. Multiple code packages with the same declared root can receive the
same bytes independently, without retrieving them from one another's source
checkout. A named root is a **mutable relation** to those immutable bytes,
with a compare-and-publish transition history. It is not another byte identity.

The host establishes the directory and its outside ancestry as durable,
non-symlink, authorized and stable before calling. The space validates the
physical root and uses the original strict writer; it does not itself issue
filesystem credentials, mount a 9P namespace, expose a network endpoint,
install a Guix generation, or decide who may read a given blob or bind a name.
Names are an explicit host-admitted finite set; an HTTP route must not forward
untrusted names or path strings to this library. Binding a name to an NI that
is not already actually retained refuses. Content reads independently verify
the complete current NI-addressed body. A corrupted or missing referenced body
never silently becomes an unknown reading.

### Typed external coordinates and consumers

- **IPFS** CIDs, UnixFS DAG layout, and CAR exchange are foreign serialization
  and transport *adapters*. A raw-block CID can be mapped to NI after checking
  the actual bytes; a multi-block UnixFS root does not name the same raw bytes
  as its file merely because they describe one user-facing file.
- **Git** commits/blobs and refs remain Git-native histories; Git's OID is not
  converted by text substitution. A source-observation adapter must retain
  the Git object bytes or the reconstructed raw file bytes and then bind the
  verified resulting NI with an attributed witness.
- **Guix** `/gnu/store` paths and derivations are installed/build reference
  coordinates. This space does not override the Guix daemon or claim that a
  byte-identical artifact implies an equivalent build graph.
- **Plan 9** bind/mount and **FluffOS** virtual objects motivate separate
  per-actor namespace and object-loading projections. Their authentication,
  lifecycle, method calls and capabilities belong to qualified host adapters,
  not to mutable blob-store metadata.
- **CAIRN**, SignCell/SignChain/SignGraph/SignCraft and L-Space consume original
  NI bytes and typed relations from this common custody substrate. No document
  directory is the topology. WIT/ACK/ATT, FOUR, Chu and sheaf readings require
  separate admitted claims and restrictions, never guessed from coincident
  paths, matching bytes, or timestamps.

This delivers the **local shared immutable substrate and named-root operation**,
not automatic federation or a presently installed public L-Space. Registry
publication, host binding, source-root admission, remote byte transport and
actual consumer receiving remain separate effects under the existing 561 Group
production procedure. The previous `createImmutableContentCustody` API still
accepts a legacy `putCurrent`-only store for old consumers; durable callers
use `putIfAbsent`, which now takes precedence when both exist.
