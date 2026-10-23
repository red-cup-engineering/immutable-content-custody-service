# Explicit finite carrier observations

The Data carrier-snapshot owner SHALL offer an optional `paths` selection on
the existing `directoryCarrierFiles(root, options)` provider. This selection
observes only those literal carrier-relative POSIX regular files. It SHALL NOT
enumerate a directory, invoke Git, expand a glob, follow a symlink or substitute
a recursive walk when a selected file is absent or unreadable. Existing directory
enumeration remains an explicitly selected separate mode for its original users.

The complete selection SHALL be received before yielding a file: at most 1,024
unique paths and 65,536 UTF-8 path bytes; at most 8 MiB per body and 64 MiB total
observed body bytes. Callers MAY choose smaller positive byte bounds. These are
finite observation limits, not resource reservations. Excluded directory names,
invalid paths, missing/nonregular files, redirected root or ancestry, and exceeded
bounds SHALL refuse the selection without yielding an apparently complete subset.

The provider SHALL reuse the existing finite `readWhole` byte reader, checking
the received file identity before and after reading. A changed identity, size or
stamp SHALL refuse that read. The caller owns stable directory topology during
the observation; this does not promise hostile concurrent namespace fencing.
Metadata stamps continue to feed `admitCarrier`'s original unchanged-body cache.
NI identity, canonical addressed snapshots, retention, partial checkpoints and
old snapshot readability SHALL retain their original laws.

This is required by FeltOS's host-owned L-Space: a development `repositoryRoot`
can address an entire service forest for other work and is not permission to
enumerate that forest at startup. FeltOS consumes this Data provider with a
finite host-source selection. No competing scanner, content format or store is
introduced.

Receiving SHALL exercise selected regular/empty files and incremental edits,
unselected deep trees and Git submodules never enumerated, missing selections,
path/count/byte bounds, secrets excluded by the host before Data observation,
symlink ancestry and identity drift, and continued readability of old snapshots
after a refused new observation. Original recursive-provider tests remain.
