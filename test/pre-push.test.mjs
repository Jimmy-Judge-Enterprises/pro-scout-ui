// Bare-node test of the pre-push hook:
//   node test/pre-push.test.mjs
//
// A guard that has only ever allowed things is indistinguishable from one that
// cannot refuse. So every case here drives the real hook and requires the exit
// code to change when the repository it is pointed at changes.
//
// The cases that matter build a THROWAWAY repository and control its contents.
// Running the hook against this repository would prove nothing: the guards are
// clean here, so it would exit 0 whether it ran them or not.
//
// This hook deliberately does NOT refuse a push to main, unlike pro-scout's.
// That one exists because GitHub withholds ruleset enforcement from private
// repositories on the Free plan. This repository is public, its ruleset
// enforces, and `main` is genuinely protected -- so a client-side copy of a
// refusal the server will actually make would be a false claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BANNED } from "../scripts/check-lexicon.mjs";

/** The retired term, taken from the checker so this file never spells it. */
const BANNED_WORD = () => BANNED.source;

/**
 * An owner identifier, ASSEMBLED rather than spelled.
 *
 * Writing it literally would make this file a boundary violation -- correctly:
 * identifiers are refused everywhere in this repository, contracts/ included,
 * because it is public. The tempting fix is a third entry on check-public-
 * boundary's SELF list, and that is the wrong one: an exclusion is a hole, and
 * whatever is later written into an excluded file is exempt from every boundary
 * check forever. SELF has exactly two entries, both files that must name every
 * pattern they forbid in order to work. This file does not.
 *
 * So the pattern `"OWNER-...` never appears contiguously in these bytes, and
 * the string only exists at runtime, inside a throwaway repository.
 */
const ownerLeak = () => `{ "${"OWN"}${"ER"}-JJ-01" }\n`;

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = path.join(ROOT, ".githooks", "pre-push");

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OLD = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; };
const sandboxes = [];

/**
 * A minimal repository the hook can actually refuse in. Both checkers derive
 * their ROOT from their own module URL and the hook derives its root from its
 * own path, so copying the three files is enough: none of them can reach back
 * into this repository, which is what makes the result a statement about the
 * hook rather than about the tree it happens to sit in.
 */
const sandbox = ({ prose = "a KCFFL side is a FRANCHISE\n", leak = null, checkers = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-ui-"));
  sandboxes.push(dir);
  for (const d of [".githooks", "scripts", ".github"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.copyFileSync(HOOK, path.join(dir, ".githooks", "pre-push"));
  if (checkers) {
    for (const f of ["check-lexicon.mjs", "check-public-boundary.mjs"]) {
      fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(dir, "scripts", f));
    }
  }
  fs.writeFileSync(path.join(dir, ".github", "lexicon-baseline.json"),
    `${JSON.stringify({ count: 0, files: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "doc.md"), prose);
  if (leak !== null) fs.writeFileSync(path.join(dir, "data.json"), leak);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@e.invalid");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "sandbox");
  return dir;
};

const run = (dir, env = {}) => {
  const r = spawnSync("bash", [path.join(dir, ".githooks", "pre-push"), "origin", "https://e.invalid/r.git"], {
    input: `refs/heads/local ${SHA} refs/heads/feat/x ${OLD}\n`,
    encoding: "utf8",
    env: { ...process.env, SKIP_PUSH_CHECKS: "", ...env },
  });
  assert.equal(r.error, undefined, `hook failed to run: ${r.error}`);
  assert.notEqual(r.status, null, "hook was killed by a signal rather than exiting");
  return r;
};

// --- it can refuse, and the pair is the proof ---------------------------------------

check("clean prose and no leak passes", () => {
  assert.equal(run(sandbox()).status, 0);
});

check("the retired term is refused -- same sandbox, one word changed", () => {
  const r = run(sandbox({ prose: `a KCFFL side is a ${BANNED_WORD()}\n` }));
  assert.equal(r.status, 1, "the hook let a ratchet-growing push through");
  assert.match(r.stderr, /baseline 0, grew/);
});

check("an owner identifier is refused -- the guard that matters most here", () => {
  const r = run(sandbox({ leak: ownerLeak() }));
  assert.equal(r.status, 1, "the hook let an owner identifier through");
  assert.match(r.stderr, /owner identifier/i);
});

check("the refusal names what was scanned, not just what was found", () => {
  assert.match(run(sandbox()).stderr, /of \d+ tracked files inspected/);
});

// --- a check that could not run is not a check that passed --------------------------

check("a missing checker is refused, not skipped", () => {
  const r = run(sandbox({ checkers: false }));
  assert.equal(r.status, 1, "an absent checker read as a passing one");
  assert.match(r.stderr, /is missing/);
});

check("no node on PATH is refused, not skipped", () => {
  // PATH is rebuilt with exactly the externals the hook needs, minus node.
  // Emptying it outright would break `dirname` too, and the hook would fail for
  // a reason that has nothing to do with node being absent.
  const dir = sandbox();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nonode-ui-"));
  sandboxes.push(bin);
  for (const tool of ["sh", "bash", "cat", "dirname", "git"]) {
    const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    assert.equal(real.status, 0, `${tool} is not on PATH; this case cannot run`);
    fs.symlinkSync(real.stdout.trim(), path.join(bin, tool));
  }
  const probe = spawnSync(path.join(bin, "sh"), ["-c", "command -v node"], { encoding: "utf8", env: { PATH: bin } });
  assert.equal(probe.error, undefined, `the probe itself could not run: ${probe.error}`);
  // Not `=== 1`: `command -v` reports not-found as 127 in dash and 1 in bash.
  assert.notEqual(probe.status, 0, "node is still reachable, so this case proves nothing");
  const r = run(dir, { PATH: bin });
  assert.equal(r.status, 1, "an uninstalled node read as a passing check");
  assert.match(r.stderr, /node is not on PATH/);
});

check("a scan of a tree other than the one being pushed says so", () => {
  assert.match(run(sandbox()).stderr, /none of the pushed commits is HEAD/);
});

// --- the escape hatch -----------------------------------------------------------------

check("SKIP_PUSH_CHECKS=1 lets a refusal through, and says it did", () => {
  const r = run(sandbox({ prose: `a KCFFL side is a ${BANNED_WORD()}\n` }), { SKIP_PUSH_CHECKS: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /SKIP_PUSH_CHECKS=1/);
});

check("any other value of the variable does not", () => {
  for (const value of ["0", "true", "yes", ""]) {
    assert.equal(run(sandbox({ leak: ownerLeak() }), { SKIP_PUSH_CHECKS: value }).status, 1,
      `SKIP_PUSH_CHECKS=${JSON.stringify(value)} should not open the gate`);
  }
});

// --- it ships usable ------------------------------------------------------------------

check("git records the hook as executable, which is the bit that ships", () => {
  // ASK GIT, NOT THE FILESYSTEM. Windows has no executable bit, so Node reports
  // 666 for a file git correctly records as 100755. The mode git holds is also
  // the one that matters: it is what everyone who clones gets.
  const mode = execFileSync("git", ["ls-files", "-s", "--", ".githooks/pre-push"],
    { cwd: ROOT, encoding: "utf8" }).trim().split(/\s+/)[0];
  assert.equal(mode, "100755",
    `git records .githooks/pre-push as ${mode}, not 100755, so the hook will not run for anyone who clones`);
});

for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true });
console.log(`pre-push tests passed: ${checks} checks`);
