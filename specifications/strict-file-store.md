# Opt-in durable immutable file-store publication

The file-store owner composes the existing physical-file owner, rather than
implementing another atomic writer. `createFileStoreSync(root, {durableRoot})`
and its promise-shaped wrapper opt into this contract. Without the option,
first-write recovery and replacement retain their existing contracts.

## Preconditions and representation

The caller establishes an absolute, pre-existing durable directory anchor,
including its external ancestry. All store paths must remain below it, on its
device, with regular files and non-symlink directories. Directory topology and
published files must not be concurrently replaced, mutated or removed. Exclusive
writers may race to publish absent paths. These are stable-namespace conditions,
not hostile-filesystem fencing. The owner preflights both body and sidecar before
mutation using Data's path admission and reads through its validated descriptors.

Strict keys are canonical nonempty slash-separated segments, without empty,
dot or parent segments; the final segment cannot end in `.media-type`. This
reserves sidecar ownership and excludes the objects directory itself.

Media type is a scalar, at most 4096 UTF-8 bytes, canonical serialized MIME value
accepted by the existing MIME owner. CR/LF and noncanonical spellings refuse.
The exact sidecar representation is its UTF-8 bytes followed by one LF; even
semantically equivalent alternate sidecar bytes conflict. New bodies default to
`application/octet-stream`. Recovery of an existing body without a sidecar
requires an explicitly supplied valid mediaType, never inferred metadata.

## Publication and reconciliation

1. Validate input, body path and sidecar path before any file mutation.
2. Read existing body and sidecar. Different body or sidecar bytes throw
   `ERR_CUSTODY_CONFLICT`, preserving both. A sidecar-only conflict refuses before
   publishing the absent body. Missing metadata on an existing body without an
   explicit type throws `ERR_CUSTODY_MEDIA_TYPE_REQUIRED`.
3. Exclusively publish absent body and sidecar using Data's atomic writer with
   `durableRoot`, private mode and `wx`. EEXIST is only a reconciliation signal:
   reread through the validated descriptor and compare exact bytes. A temporary
   collision with no destination propagates its original EEXIST.
4. Verify both retained representations, then establish both file and complete
   ancestry barriers through Data's `syncFileDurablySync`, even for duplicates.
   Reread both exact representations before returning.
5. Return `{conflict: false, durable: true}` for a new body, or
   `{conflict: true, durable: true}` for an already retained exact body. Only
   these receipts establish this operation's complete durable representation.

Errors from writes, opens, fsync or ancestry admission propagate. A failure can
leave a body, sidecar or owned temporary behind; these uncertain partial outcomes
are retained, never acknowledged or rolled back by this owner. Retry reconciles
the same exact input and repeats every barrier. Foreign temporaries are untouched.

Strict `putCurrent` throws `ERR_CUSTODY_REPLACEMENT_UNSUPPORTED` before any
mutation. A two-file replacement has no atomic representation boundary here.
The default replacement API remains unchanged. Raw get/head/read/verify/list are
observations, not strict durable-publication receipts; they retain their existing
behavior and must not be used to infer successful completion after an error.
The higher-level shared content-addressed space opts into
`requireCompleteRepresentation` when constructing this store. In that mode,
observation refuses an absent, malformed, or noncanonical UTF-8 media-type
sidecar with `ERR_CUSTODY_INCOMPLETE`, rather than converting incomplete
publication into a nameable content object. This mode is read-only and does not
itself certify durability; the existing strict `putIfAbsent` publication and
barriers remain the sole receipt-generating operation.

## Acceptance

Sync and async callers cover new/duplicate/empty bodies, exact receipts and
barriers, incompatible bodies and metadata, sidecar-only states, explicit missing
metadata recovery, missing expected type, EEXIST races and foreign temporaries,
write/file-sync/directory-sync/ancestor failures and same-input retry. Read-only
preflight covers containment, symlinks, nonregular paths, device mismatch, invalid
keys/types and unsupported replacement. Existing default tests remain unchanged.
Source tests do not simulate physical power loss or qualify machine deployment.
