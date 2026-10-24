# Immutable Content Custody Service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

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

Shared-space reads now require a **complete canonical media-type sidecar**, not
just a hash-valid body left by an interrupted two-file write. The original
low-level file-store's best-effort observations are unchanged; only the shared
space opts into `ERR_CUSTODY_INCOMPLETE` for body-only or malformed sidecars.
Recover an interrupted publication with the original exact bytes and explicit
media type through `retain`, which reestablishes physical durability barriers.
A successful read is still not an independently witnessed installation.

This delivers the **local shared immutable substrate and named-root operation**,
not automatic federation or a presently installed public L-Space. Registry
publication, host binding, source-root admission, remote byte transport and
actual consumer receiving remain separate effects under the existing 561 Group
production procedure. The previous `createImmutableContentCustody` API still
accepts a legacy `putCurrent`-only store for old consumers; durable callers
use `putIfAbsent`, which now takes precedence when both exist.

## Immutable collection roots (bounded Merkle trees)

The same original `./space` API now supports `retainTree(entries)` and `readTree(ni)` for one canonical, immutable directory of already-retained NI bodies. Entries are explicit `{name, ni}` records, with a unique lowercase single-segment name. The implementation sorts at most 256 slots and stores an exact UTF-8 JSON carrier under its own RFC 6920 NI, with media type `application/vnd.561.content-tree+json`. It does not mint a new hash or a second location index. A reader in another independently constructed space can use the same NI and root to recover the identical tree and its target addresses. Trees can refer to earlier trees to form an immutable Merkle DAG; a target must be retained before an enclosing tree is published.

`retainTree` checks the complete current bytes of every direct target before publishing. `readTree` validates the current tree body, exact media type and canonical representation; it exposes declared links, not an inference that every descendant remains accessible or authorized. A host must still grant read access separately for each content NI; no directory entry confers that access. A tree is **not** an IPFS UnixFS DAG, Git tree, Guix derivation, Plan 9 mount, FluffOS virtual object, SignGraph relation, Wang edge-matching proof, Chu context or glued sheaf section. Those are qualified adapters or interpretations over admitted resources, never properties deduced from matching hashes.


## Canonical Merkle-byte admission for independent receiving hosts

`createContentAddressedSpace(...).inspectTreeBytes(bytes)` is the **original
custody-owner** canonical parser for an externally received immutable tree.
It returns the bounded, validated, frozen typed tree (`kind`, `version`,
`entries`) but **does not publish bytes or dereference children**. The same
`decodeContentTree` and NI admission rules already used by `readTree`
are applied: exact UTF-8 JSON, canonical ordering, unique lowercase slots,
no extra object fields, and valid RFC 6920 NI child links.

The Networking service's existing `ni-peer` may use this on a bounded,
NI-verified HTTP response *before* deciding which descendants to request.
After independently authorizing and retaining those child bytes, it must
call the original `retainTree(entries)` to publish a canonical local tree
and compare the resulting NI with the advertised root. No HTTP content
type, arbitrary filename, foreign CID, or remote source authorization
is promoted into a local data or namespace grant. A denied child must not
turn into a fabricated absent or automatically linked resource.

This is the pure admission facet of the same local immutable space API,
not a rival codec or implicit peer transport. Source changes do not
establish publication of version `0.5.2` or installed network exchange.

## Merkle path authorship over named roots

The host-admitted `./space` surface can now **make and update** a tree of
immutable content objects without inventing another identity format or routing
writes through an application-owned database. Each path is an explicit array
of lowercase single-segment slot names, with a bounded depth of 16. It is not
a disk, URL or arbitrary Plan 9 path, and cannot be decoded as one.

```js
import { createContentAddressedSpace } from
  "@red-cup-engineering/immutable-content-custody-service/space";

const space = createContentAddressedSpace({
  root: "/srv/561/shared-content",
  durableRoot: "/srv/561/shared-content",
  namespaces: ["science/l-space", "engineering/source"],
});
const wang = await space.putPath({
  name: "science/l-space",
  expected: null,
  path: ["tilings", "wang"],
  bytes: new TextEncoder().encode("north=blue;east=red"),
  mediaType: "text/plain",
});
const earlierRoot = wang.rootNi;
const beads = await space.putPath({
  name: "science/l-space",
  expected: earlierRoot,
  path: ["tilings", "beads"],
  bytes: new Uint8Array([1, 0, 1, 0]),
});
const reading = await space.atPath("science/l-space", ["tilings", "wang"]);
console.log(reading.ni, reading.rootNi, beads.rootNi);
```

`putPath` retains the caller's exact bytes using the existing strict NI writer,
retains the changed enclosing trees with their own NI identifiers, and performs
one compare-and-publish of the named root. `linkPath` performs the same
composition for a previously retained `ni`, without another byte upload.
`atPath` traverses the current admitted root and returns both the exact
target and the root NI of the snapshot read. `retainTree` and `readTree`
remain available for explicit immutable collections.

A stale `expected` root refuses a competing publication; unrelated immutable
objects constructed by the losing writer may remain, but the winning named
root cannot be overwritten. Intermediate path slots must already be trees or
be absent; navigating *through* an ordinary byte object refuses instead of
silently promoting it to a directory. Existing child slots of reconstructed
trees persist unchanged. Each direct reference must name already retained
bytes. The existing storage boundary continues to verify complete bytes and
canonical media-type sidecars. Neither a path nor the possession of an NI
grants a reader authority: hosts must admit names and access separately.

This is a **local host-installed authoring primitive**, not an IPFS network,
Plan 9/9P mount, Git object adapter, Guix build realization, FluffOS loader,
VaultMaze scene, or published TUFTE projection. Consumers must explicitly
receive the newly installed package and bind their own lawful host roots.
A tree proves the immutable links it *declares*, not a Wang-edge
compatibility, a bead-weaving law, a Chu adjunction or sheaf gluing theorem.


## Host-operated shared-space CLI

The original package's `custody-space` executable exposes its **same**
`./space` library to programs in other languages, shell scripts, and
installed operators. It creates named immutable collections; it does **not**
start a server, create actor credentials, mount Plan 9/9P, or manufacture a
second content-addressing scheme.

The actual host first installs the shared physical custody directory and an
absolute, ordinary, access-controlled JSON configuration file, independently
of any client request. For example, an authorized local machine operator
could supply `/etc/561/content-space.json`:

```json
{
  "root": "/srv/561/shared-content",
  "durableRoot": "/srv/561/shared-content",
  "maximumBytes": 8388608,
  "namespaces": ["science/l-space", "engineering/source"]
}
```

The host is responsible for provisioning that directory, its ancestor
durability and file permissions. The command does not create the directory
or decide which actor may use any of those namespaces. With that installation
in place, a local authorized operator may invoke:

```sh
custody-space put \
  --config /etc/561/content-space.json \
  --name science/l-space --expected none \
  --path '["tilings","wang"]' \
  --file /var/lib/561/admitted/wang.txt \
  --media-type text/plain
```

This prints one JSON line including the received raw NI (`ni`) and the
new immutable collection root (`rootNi`). Reuse that *exact returned* root
for subsequent compare-and-publish operations:

```sh
custody-space put --config /etc/561/content-space.json \
  --name science/l-space --expected 'ni:///sha-256;THE_RETURNED_ROOT_DIGEST' \
  --path '["tilings","beads"]' \
  --file /var/lib/561/admitted/beads.bin
custody-space resolve --config /etc/561/content-space.json --name science/l-space
custody-space at --config /etc/561/content-space.json \
  --name science/l-space --path '["tilings","wang"]'
custody-space tree --config /etc/561/content-space.json \
  --ni 'ni:///sha-256;THE_RETURNED_ROOT_DIGEST'
custody-space list --config /etc/561/content-space.json
```

The `get` command completes the same producer/consumer circuit. It accepts
**either** `--ni <canonical-ni>` **or** `--name <admitted-name> --path
'["slot","name"]'`, plus `--out /absolute/new-file`. The output's parent
must be an existing, non-redirected directory outside the protected shared
store, and an existing destination is never overwritten. The original File
Custody `copyOut` operation validates the full NI bytes before atomically
linking the received output file; the original Shared Space `head` /
`atPath` reader first requires a complete, canonical media-type sidecar.
The wire result contains the exact NI, output location, byte length and
media type rather than raw bytes. The named form also returns the immutable
root NI and the selected ordered slots so consumers can retain the snapshot
they actually received.

```sh
custody-space get --config /etc/561/content-space.json \
  --name science/l-space --path '["tilings","wang"]' \
  --out /var/lib/561/received/wang.txt
```

Callers should prefer this **same host-config-bound `get`** when using
the shared namespace, instead of introducing a second `--root` selection
through the older `custody-file` command. Both commands use the same
original NI object key and physically compatible bytes, but only
`custody-space get` first checks the shared-space sidecar and installed
namespace selection. The local host must still supply lawful OS permissions;
no CLI flag grants access to another office's data or makes it public.

**Executable installation:** the `custody-space` script must ship with
Git file mode `100755` (the original `custody-file` already does), and
its command dispatch resolves npm/pnpm bin symlinks before comparing the
invoking path to its module file. A declared `bin` manifest alone does
not make a script launchable.

`retain` stores one host-admitted file without a named root. `link`
composes a previously retained exact `--ni` into a new named tree without
reading that source file again. `put` stores the input and composes it in
one command. `tree`, `at`, `resolve` and `list` perform bounded reads.
`--expected none` means an initially absent name; subsequent updates
MUST carry the previously returned root NI. `--path` is a JSON array of
canonical single-segment slot names, **never a filesystem path**, URL or
proof of typed semantic adjacency. Input files must be absolute regular
non-symlink paths and are rechecked during bounded admission.

Output uses one line of JSON with no raw bytes. For retrieving original
content into a new physical file, the existing `custody-file get --root
/srv/561/shared-content --ni <address> --out <new-file>` operates over
the same NI object keys; the separately granted host must authorize both
the content and the output location. Its original `get` is not a network
operation or a per-actor disclosure check. An absent, stale or forged root
cannot be used to grant child access. For private L-Space, the CAIRN
reader retains its independent `canReadSources` and `canReadContentSpace`
checks.

These commands deliver a **shell-callable local shared-content producer**.
Operating deployment, package release, remote IPFS transport, Guix
realization, FluffOS object lifetimes, VaultMaze interaction and
independently received TUFTE/CAIRN consumers are still separate work.


## Atomic collection fabrication and bounded legibility (source addition, October 17, 2026)

The original custody `./space` maker now exposes `linkPaths({name, expected,
links})`. Each link is **only** an explicitly admitted `{path: string[], ni}`
record. The method accepts 1–128 links to already retained original NI bytes,
requires canonical path segments, and rejects duplicates, ancestor/descendant
overlaps, unheld targets, invalid ancestors and an out-of-date named root.
It materializes all changed immutable ancestors using the *existing*
`retainTree` and performs **one** original frontier compare-and-publish after
the entire collection exists. A refused or losing writer may leave immutable,
unreferenced source bytes but cannot announce a partial new root. The earlier
`linkPath` delegates to the same maker and keeps its existing receipt shape.
No Git object, CID, 9P path, Guix store item, Chu evaluation or Wang-edge
compatibility is inferred from these links.

```js
const wang = await space.retain(new TextEncoder().encode("north=blue;east=red"), {
  mediaType: "text/plain",
});
const bead = await space.retain(new TextEncoder().encode("entry->exit"), {
  mediaType: "text/plain",
});
const assembled = await space.linkPaths({
  name: "science/l-space",
  expected: space.resolve("science/l-space"),
  links: [
    { path: ["tilings", "wang"], ni: wang.ni },
    { path: ["beadwork", "ports"], ni: bead.ni },
  ],
});
const reading = await space.walkTree(assembled.rootNi, {
  maximumNodes: 64,
  maximumDepth: 16,
  // An untrusted reader supplies independent authorization for EVERY child.
  admitChild: async (ni, context) => admittedChildForActualPrincipal(ni, context),
});
```

`walkTree(rootNi, {maximumNodes=256, maximumDepth=16, admitChild?})`
is the original custody-owned, bounded Merkle **inventory**. It returns
sorted depth-first path occurrences with exact canonical NI, verified media
type and byte count, distinguishing object leaves from tree carriers. A
repeated child retains **one NI but every distinct appearance**. It refuses
on an incomplete/missing body, denied descendant, malformed tree, depth
overrun, node overrun or cyclic path, rather than returning a misleading
complete-looking partial traversal. It does not return source bodies, infer
application relationships or grant a root reader permission to see children.
Root access remains a separate host admission. Maximum node count is 2048
and maximum depth is 16, both subject to smaller caller budgets.

The same original host CLI adds `link-batch` and `walk`, which are only
available when the newly built package is actually installed. The
host-provisioned config still fixes storage, namespaces and byte budget:

```sh
# First invoke custody-space retain for each source and use the exact
# returned NI values in a canonical UTF-8 manifest, such as:
# {"links":[{"path":["tilings","wang"],"ni":"<actual-ni>"},
#           {"path":["beadwork","ports"],"ni":"<actual-ni>"}]}
custody-space link-batch --config /etc/561/content-space.json \
  --name science/l-space --expected none \
  --manifest /var/lib/561/admitted/collection.json
custody-space walk --config /etc/561/content-space.json \
  --name science/l-space --maximum-nodes 128 --maximum-depth 16
```

The batch manifest must be an absolute stable ordinary file, at most 64 KiB
and exactly a JSON record with `links`; no submitted manifest can choose the
host root or credentials. For later publications replace `--expected none`
with the **exact previously returned** `rootNi`. `walk` also accepts a
direct `--ni` in place of `--name`, but not both. Its JSON output contains
only structural observations, not raw source data. Independent consumers
may read `atPath` or `custody-space get` from the same configured
physical custody, each subject to its own actor and content read grants.

This is **source fabrication plus original test cases**, not yet a published
registry edition, running CI, commissioned host, remote peer transfer,
Science site formation or a CAIRN/TUFTE/VaultMaze installation. Downstream
Data → Code → Networking → Systems integration must select a genuinely
available released upstream package; do not fabricate a second native tree
builder or short-circuit original principal admission to simulate delivery.

## Producer/agent boundary — no custody-owned MCP adapter

The original `./space` API owns exact bytes, Merkle trees, names and durable
compare-and-publish. Its `tracePath` is now shared by its own `atPath` and
CAIRN's authorized read projection. It does not own MCP descriptors or agent
identity.

The typed `content-space-put-path` and `content-space-link-path` capability
operations now belong to
`@red-cup-engineering/computer-system-engine/rpc/content-space-capabilities`.
They compose the original custody effects with Code's typed operation execution,
Networking's standard MCP operation projection, and principal-bound Systems
authority. Their canonical JSON bytes are decoded by the existing Data codec.
The former `./publication` MCP factory was source-location debt and is retired,
not copied into another L-Space leaf.

An installed host must supply its already authorized durable NI space and an
independently authenticated principal-bound operation resolver. Presence in a
source tree or a package manifest is not an installed host admission or a
network-write grant.
