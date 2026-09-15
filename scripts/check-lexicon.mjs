// Hold one word out of this repository's own prose: a KCFFL side is a FRANCHISE,
// an NFL side is a PRO TEAM, and "club" names neither.
//
//   node scripts/check-lexicon.mjs                 check; non-zero if the baseline grew
//   node scripts/check-lexicon.mjs --list          print every occurrence
//   node scripts/check-lexicon.mjs --update-baseline
//
// WHY A CHECK AND NOT A ONE-OFF RENAME. A rename is a fact about the day it ran.
// Nothing stops the word returning in the next file written, and the failure is
// silent: `grep club` comes back clean in whichever directory a reader happens to
// open, they conclude the rule holds, and the occurrences nobody swept sit
// somewhere else. This repository is the public face of the chain, so the word it
// uses is the word a reader outside the project learns.
//
// WHY A BASELINE RATCHET. Same shape as pro-scout's: the debt may shrink, never
// grow. It happens to start at zero here because the rename landed with it, but
// the mechanism matters more than the number -- a later import can be accepted
// and recorded rather than blocking the change that brought it.
//
// WHAT IS EXEMPT, AND WHY EACH ONE IS.
//   contracts/**   Vendored. contracts/VENDORED.json says do not edit by hand and
//                  scripts/verify-contracts.mjs enforces it by sha256. The word
//                  has to change upstream in pro-scout and arrive by re-copy --
//                  and upstream already says "pro team code", so this corrects
//                  itself at the next sync.
//   src/vendor/**  Third-party code. Not ours to reword.
//   this file, its test, its baseline -- all three must name the word to work on it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const BASELINE_PATH = ".github/lexicon-baseline.json";

// Substring, not /\bclub\b/. "_" is a word character, so a boundary match does not
// match trailer_club -- the identifier this whole rule started from. Nothing in
// this domain legitimately contains the letters, so the broad match costs nothing
// and the narrow one would have shipped a hole.
export const BANNED = /club/i;

export const EXEMPT = [
  "contracts/",
  "src/vendor/",
  "scripts/check-lexicon.mjs",
  "test/lexicon.test.mjs",
  BASELINE_PATH,
];

export function isExempt(file) {
  const f = file.split(path.sep).join("/");
  return EXEMPT.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
}

export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
}

/** A fresh, zeroed tally for scanFiles to fill in. */
export const newTally = () => ({ inspected: 0, exempt: 0, binary: 0, unreadable: 0 });

/**
 * `tally`, when given, records what the scan actually did. It is counted here
 * rather than predicted by the caller, because a prediction is one more thing
 * that can be right about a scan that never happened.
 */
export function scanFiles(root, files, tally = null) {
  const findings = [];
  for (const file of files) {
    if (isExempt(file)) { if (tally) tally.exempt += 1; continue; }
    let text;
    try { text = fs.readFileSync(path.join(root, file), "utf8"); }
    catch { if (tally) tally.unreadable += 1; continue; }
    if (text.includes("\0")) { if (tally) tally.binary += 1; continue; } // binary
    if (tally) tally.inspected += 1;
    text.split(/\r?\n/).forEach((line, i) => {
      if (BANNED.test(line)) findings.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return findings;
}

/**
 * The denominator, in the sentence check-public-boundary.mjs already prints in
 * this repository. The two checkers here should read alike, and until now only
 * one of them said what it had looked at.
 */
export function describeScope(tally, tracked) {
  const parts = [`${tally.binary} binary`, `${tally.exempt} exempt`];
  if (tally.unreadable) parts.push(`${tally.unreadable} UNREADABLE`);
  return `${tally.inspected} of ${tracked} tracked files inspected (${parts.join(", ")})`;
}

export function byFile(findings) {
  const counts = new Map();
  for (const f of findings) counts.set(f.file, (counts.get(f.file) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file, count]) => ({ file, count }));
}

export function readBaseline(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), "utf8")); }
  catch { return null; }
}

// A missing baseline is not treated as zero. That would turn "nobody has recorded
// this yet" into a failure on every existing occurrence, and the quickest way out
// would be to re-baseline -- which is how a ratchet becomes a rubber stamp.
export function verdict(count, baseline) {
  if (!baseline || typeof baseline.count !== "number") {
    return { ok: true, status: "no-baseline", count, baseline: null };
  }
  if (count > baseline.count) return { ok: false, status: "grew", count, baseline: baseline.count };
  return { ok: true, status: count < baseline.count ? "shrank" : "unchanged", count, baseline: baseline.count };
}

function main(argv) {
  // WHY THE DENOMINATOR IS NOT DECORATION.
  //
  // This printed "N occurrence(s) in M file(s)" and nothing else, where M counts
  // files WITH findings. So a scan of an empty file list printed
  // "0 occurrence(s) in 0 file(s)" -- byte-identical to a genuine clean pass.
  //
  // trackedFiles reads `git ls-files`, which is HEAD, so a run made before
  // `git add` scans a tree without the file just written and reports clean. That
  // is not hypothetical: it happened six times in one day in pro-scout, cost a
  // pull request five red pushes, and each time the local output gave no way to
  // tell an empty scan from a clean one.
  //
  // This repository is PUBLIC, which is the argument for porting it here first
  // rather than last: a check that cannot distinguish "found nothing" from
  // "looked at nothing" is worth least exactly where a leak has an audience.
  const tracked = trackedFiles(ROOT);
  const tally = newTally();
  const findings = scanFiles(ROOT, tracked, tally);
  const scope = describeScope(tally, tracked.length);
  const perFile = byFile(findings);

  if (argv.includes("--update-baseline")) {
    fs.writeFileSync(path.join(ROOT, BASELINE_PATH), `${JSON.stringify({
      note: 'Occurrences of "club" outside the exempt paths. May shrink, never grow.'
        + " See scripts/check-lexicon.mjs for what is exempt and why.",
      generated_by: "scripts/check-lexicon.mjs --update-baseline",
      count: findings.length,
      files: perFile,
    }, null, 2)}\n`);
    console.error(`lexicon baseline written: ${findings.length} occurrence(s); ${scope}`);
    return 0;
  }
  if (argv.includes("--list")) for (const f of findings) console.error(`${f.file}:${f.line}: ${f.text}`);

  const v = verdict(findings.length, readBaseline(ROOT));
  if (v.status === "no-baseline") {
    console.error(`lexicon: ${v.count} occurrence(s); ${scope}; no baseline recorded`);
    return 0;
  }
  console.error(`lexicon: ${v.count} occurrence(s) in ${perFile.length} file(s) with findings;`
    + ` ${scope}; baseline ${v.baseline}, ${v.status}`);
  if (!v.ok) {
    console.error(`::error::"club" grew from ${v.baseline} to ${v.count}.`
      + " A KCFFL side is a FRANCHISE, an NFL side is a PRO TEAM."
      + " Rename the new occurrence rather than re-baselining.");
    for (const { file, count } of perFile) console.error(`  ${file}: ${count}`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
