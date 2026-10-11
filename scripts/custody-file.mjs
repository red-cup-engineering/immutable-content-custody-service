#!/usr/bin/env node
/**
 * Command line for native file custody. The root is host-owned and named on every call.
 *
 *   custody-file.mjs retain      --root R --file F [--media-type T] [--expected-ni NI]
 *   custody-file.mjs retain-tree --root R --dir  D [--media-type T]
 *   custody-file.mjs verify      --root R --ni NI
 *   custody-file.mjs get         --root R --ni NI --out FILE
 *   custody-file.mjs get-tree    --root R --ni NI --out NEW_DIR
 *
 * A tree is retained as one deterministic gzip tar (sorted names, zero mtime, zero owner, no gzip
 * name or time), so the same tree is one address. Every result is one JSON line on stdout.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { createFileContentCustody } from "../src/file-content-custody.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TREE_MEDIA_TYPE = "application/gzip";
const TREE_PROFILE = "tar-gnu-sorted-mtime0-owner0-gzip-n";

/** Archive `directory` deterministically into `target`. */
export function packTree(directory, target) {
  const parent = dirname(resolve(directory)), name = basename(resolve(directory));
  const tar = spawnSync("sh", ["-c", `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -C "$1" -cf - "$2" | gzip -n -9 > "$3"`, "pack", parent, name, target], { stdio: ["ignore", "inherit", "inherit"] });
  if (tar.status !== 0) throw new Error("tree packing failed");
}

export function runCustodyFile(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, file: { type: "string" }, dir: { type: "string" }, ni: { type: "string" }, out: { type: "string" }, "media-type": { type: "string" }, "expected-ni": { type: "string" } } });
  if (!values.root) throw new TypeError("--root names the host-owned custody root");
  const custody = createFileContentCustody({ root: resolve(values.root) });
  switch (command) {
    case "retain":
      return custody.retainFile(resolve(values.file), { expectedNi: values["expected-ni"], mediaType: values["media-type"] });
    case "retain-tree": {
      const scratch = mkdtempSync(join(tmpdir(), "custody-tree-"));
      try {
        const archive = join(scratch, "tree.tgz");
        packTree(values.dir, archive);
        return { ...custody.retainFile(archive, { mediaType: values["media-type"] ?? TREE_MEDIA_TYPE }), packaging: TREE_PROFILE, tree: basename(resolve(values.dir)) };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    case "verify": {
      const head = custody.head(values.ni);
      return { ni: head.ni, byteLength: head.size, verified: true };
    }
    case "get":
      return custody.copyOut(values.ni, resolve(values.out));
    case "get-tree": {
      const out = resolve(values.out);
      if (existsSync(out)) throw new Error("--out must not exist");
      const scratch = mkdtempSync(join(tmpdir(), "custody-tree-"));
      try {
        const archive = join(scratch, "tree.tgz");
        custody.copyOut(values.ni, archive);
        mkdirSync(out, { recursive: true });
        const untar = spawnSync("tar", ["-xzf", archive, "-C", out, "--strip-components=1"], { stdio: ["ignore", "inherit", "inherit"] });
        if (untar.status !== 0) throw new Error("tree unpacking failed");
        return { ni: values.ni, out };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    default:
      throw new TypeError("command is retain, retain-tree, verify, get or get-tree");
  }
}

if ((process.argv[1] !== undefined && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  try { process.stdout.write(`${JSON.stringify(runCustodyFile(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ kind: "immutable-content-custody-refusal", message: error?.message ?? String(error) })}\n`); process.exitCode = 1; }
}
