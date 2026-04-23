#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && p.endsWith(".wgsl")) yield p;
  }
}

const files = [...walk(join(root, "src"))];
if (files.length === 0) process.exit(0);

const r = spawnSync("naga", ["--bulk-validate", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
