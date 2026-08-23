// Verifies that the vendored Gameplan contracts are byte-identical to what
// contracts/VENDORED.json says they are.
//
// These files are copies, not sources. Gameplan owns them, pro-scout vendors
// them, and this repo vendors them again so a static page can validate against
// the same bytes CI does. A copy nobody checks is a copy that drifts, and a
// contract that has drifted validates the wrong thing while looking correct.
//
// Bare node, no dependencies, no test framework -- the same way the upstream
// repo runs its own validation.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = JSON.parse(readFileSync(join(root, "contracts", "VENDORED.json"), "utf8"));

const failures = [];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const [file, expected] of Object.entries(vendored.files)) {
  const path = resolve(root, file);
  let actual;
  try {
    actual = sha256(path);
  } catch (error) {
    failures.push(`${file}: ${error.code === "ENOENT" ? "missing" : error.message}`);
    continue;
  }
  if (actual !== expected) {
    failures.push(`${file}: expected ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}…`);
    continue;
  }
  // A schema that will not parse cannot validate anything, and would fail only
  // at runtime in someone's browser.
  if (file.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      failures.push(`${file}: not parseable JSON (${error.message})`);
    }
  }
}

const counted = Object.keys(vendored.files).length;
if (counted !== vendored.file_count) {
  failures.push(`file_count says ${vendored.file_count}, files lists ${counted}`);
}

if (failures.length) {
  console.error("Vendored contracts have drifted from their recorded hashes:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\nThese files are not edited here. Re-copy them from ${vendored.upstream_repo}`);
  console.error("and refresh contracts/VENDORED.json, or restore the originals.");
  process.exit(1);
}

console.log(`contracts: ${counted} vendored file(s) match ${vendored.upstream_repo}@${vendored.upstream_commit.slice(0, 7)}`);
