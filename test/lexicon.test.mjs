// Bare-node test of the lexicon check:
//   node test/lexicon.test.mjs
//
// A checker nobody has seen refuse anything is indistinguishable from one that
// passes everything. So every case here plants a violation and requires it to be
// caught, rather than running against a clean tree and calling green a proof.
//
// The last case is the one that matters most and is the easiest to leave out:
// it points the checker at THIS repository. pro-scout's first version of this
// file tested only fixtures, so a real "club" in a real file would have passed
// the whole suite while the checker sat there looking enforced. Fixtures prove
// the checker works; only a repository scan proves it is being used.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanFiles, isExempt, verdict, byFile, BANNED, trackedFiles, readBaseline, ROOT,
  newTally, describeScope,
} from "../scripts/check-lexicon.mjs";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "lexicon-ui-"));
const write = (rel, text) => {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return rel;
};
const scan = (...rels) => scanFiles(fixture, rels);
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; };

// --- the word is caught in every spelling it actually appears in --------------------

check("lower, capitalised and upper case all count", () => {
  assert.equal(scan(write("a.md", "the club\nthe Club\nthe CLUB\n")).length, 3);
});

check("the plural counts", () => {
  assert.equal(scan(write("b.md", "two clubs share a name\n")).length, 1);
});

check("trailer_club is caught -- what a word-boundary match would miss", () => {
  // The reason BANNED is a substring. "_" is a word character, so /\bclub\b/ does
  // not match trailer_club: the identifier this rule began with would have sailed
  // through a checker that looked entirely correct.
  assert.equal(scan(write("c.js", "trailer_club: null,\n")).length, 1);
  assert.equal(/\bclub\b/i.test("trailer_club"), false,
    "the boundary matcher now catches trailer_club; the substring rule is no longer the reason");
  assert.equal(BANNED.test("trailer_club"), true);
});

check("the line and file are reported, not just a count", () => {
  const [only] = scan(write("d.md", "clean\nthe club\nclean\n"));
  assert.equal(only.file, "d.md");
  assert.equal(only.line, 2, "line numbers are 1-indexed");
});

check("the approved words do not trip it", () => {
  assert.deepEqual(scan(write("e.md", "a KCFFL side is a FRANCHISE, an NFL side is a PRO TEAM\n")), []);
});

check("a binary file is skipped rather than scanned as text", () => {
  assert.deepEqual(scan(write("f.bin", "club\0club\n")), []);
});

// --- the exemptions are exactly the ones declared, and no more ----------------------

check("vendored contracts and vendored source are exempt", () => {
  assert.equal(isExempt("contracts/pro-scout/identity-requests.schema.json"), true);
  assert.equal(isExempt("src/vendor/jsonschema.js"), true);
});

check("the checker, its test and its baseline are exempt", () => {
  for (const f of ["scripts/check-lexicon.mjs", "test/lexicon.test.mjs", ".github/lexicon-baseline.json"]) {
    assert.equal(isExempt(f), true, `${f} must be exempt; it has to name the word to work on it`);
  }
});

check("a path that merely starts with the same letters is NOT exempt", () => {
  // The trap a naive startsWith invites: "contracts/" must not exempt
  // "contracts-draft/", and the prefix must be anchored at the repository root.
  assert.equal(isExempt("contracts-draft/x.json"), false);
  assert.equal(isExempt("docs/contracts/x.md"), false);
  assert.equal(isExempt("src/vendored/x.js"), false);
});

check("exempting one file does not exempt the scan", () => {
  write("contracts/v.json", '{"note":"one row per player per club"}\n');
  const dirty = write("docs/h.md", "the club\n");
  assert.deepEqual(scan("contracts/v.json"), []);
  assert.equal(scan("contracts/v.json", dirty).length, 1);
});

// --- the ratchet: the debt may shrink, never grow -----------------------------------

check("growth fails, parity and shrinkage pass", () => {
  assert.equal(verdict(1, { count: 0 }).ok, false);
  assert.equal(verdict(1, { count: 0 }).status, "grew");
  assert.equal(verdict(0, { count: 0 }).status, "unchanged");
  assert.equal(verdict(3, { count: 7 }).status, "shrank");
  assert.equal(verdict(3, { count: 7 }).ok, true);
});

check("a missing or malformed baseline passes and says so", () => {
  // If "no baseline" meant "baseline zero", the first run would fail on debt
  // nobody had accepted, and the quickest way out would be to re-baseline --
  // which is how a ratchet becomes a rubber stamp.
  assert.equal(verdict(9, null).status, "no-baseline");
  assert.equal(verdict(9, { note: "no count field" }).status, "no-baseline");
});

check("per-file counts are sorted worst-first", () => {
  assert.deepEqual(
    byFile([{ file: "b.md" }, { file: "a.md" }, { file: "a.md" }]),
    [{ file: "a.md", count: 2 }, { file: "b.md", count: 1 }],
  );
});

// --- the scan reports what it scanned, not only what it found -----------------------
//
// The output used to be "N occurrence(s) in M file(s)" and nothing else, where M
// counts files WITH findings. A scan of an empty file list therefore printed
// "0 occurrence(s) in 0 file(s)" -- byte for byte what a genuine clean pass
// prints. trackedFiles reads `git ls-files`, so a run made before `git add`
// scans a tree without the file just written and reports clean.

check("the tally counts every disposition, not just the interesting one", () => {
  const t = newTally();
  const files = [
    write("scope/prose.md", "a FRANCHISE\n"),
    write("scope/bad.md", "a club\n"),
    write("scope/blob.bin", "club\0club\n"),
    "contracts/vendored.json",
    "scope/gone.md",
  ];
  assert.equal(scanFiles(fixture, files, t).length, 1);
  assert.deepEqual(t, { inspected: 2, exempt: 1, binary: 1, unreadable: 1 });
});

check("an empty scan cannot be mistaken for a clean one", () => {
  const t = newTally();
  assert.deepEqual(scanFiles(fixture, [], t), []);
  assert.equal(describeScope(t, 0), "0 of 0 tracked files inspected (0 binary, 0 exempt)");
  // The old output for this same situation. Still true, still useless alone.
  assert.equal(`0 occurrence(s) in ${byFile([]).length} file(s)`, "0 occurrence(s) in 0 file(s)");
});

check("a real scan says how many files it read", () => {
  const t = newTally();
  scanFiles(fixture, [write("scope/x.md", "a FRANCHISE\n")], t);
  assert.equal(describeScope(t, 9), "1 of 9 tracked files inspected (0 binary, 0 exempt)");
});

check("an unreadable file is shouted, not folded into the total", () => {
  const t = newTally();
  scanFiles(fixture, ["scope/missing-entirely.md"], t);
  assert.match(describeScope(t, 1), /1 UNREADABLE/);
});

// --- and the case that points it at this repository ---------------------------------

check("no occurrence in this repository, measured against the baseline", () => {
  const found = scanFiles(ROOT, trackedFiles(ROOT));
  const v = verdict(found.length, readBaseline(ROOT));
  assert.equal(v.ok, true,
    `"club" grew from ${v.baseline} to ${v.count}: `
    + byFile(found).map(({ file, count }) => `${file} (${count})`).join(", "));
});

fs.rmSync(fixture, { recursive: true, force: true });
console.log(`lexicon tests passed: ${checks} checks, repository at ${scanFiles(ROOT, trackedFiles(ROOT)).length} occurrence(s)`);
