// Prove the public-boundary check can fail.
//
// A check that has only ever passed is indistinguishable from one that cannot
// fail, and this repository is the published end of the chain, so a checker
// that silently matched nothing would be worse than no checker at all -- it
// would read as a clean bill of health on every commit.
//
// Every forbidden pattern is planted here and must be caught; every legitimate
// shape is planted too and must not be. Nothing is written to disk: each case
// calls scanContent with an in-memory string, so no leak sample and no sample
// player ever reaches the repository. That is the "no sample data, anywhere"
// rule in CLAUDE.md, and it applies to a test about leaks more than to any
// other test here.
//
//   node test/public-boundary.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanContent, scanRepository, SELF } from "../scripts/check-public-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
}

// --- what must be caught, wherever it appears -------------------------------------------------

const LEAKS = [
  ["data/player-manifest.json", '{"owner_id": "OWNER-JJ-01"}', "an owner identifier"],
  ["data/player-manifest.json", '{"franchise_id": "KCFFL-F-07"}', "a franchise identifier"],
  ["data/player-manifest.json", '{"franchise_id": "KCFFL-F-H01"}', "a departed franchise"],
  ["data/team-manifest.json", '{"id": "FRANCHISE:KCFFL:07"}', "the pre-migration form"],
  ["data/team-manifest.json", '{"asset_id": "ASSET:KCFFL:PLAYER:00-0039064"}', "an asset id"],
  ["data/player-manifest.json", '{"kcffl_points_by_season": {"2025": 141.0}}', "league scoring"],
  ["data/player-manifest.json", '{"value_over_replacement_points": 41.2}', "a board valuation"],
  ["src/table-sort.mjs", '{"keeper_value": 3}', "a keeper judgment"],
  ["data/team-manifest.json", '{"franchise_mode": "contend"}', "franchise mode state"],
  ["data/team-manifest.json", '{"owner_objective_state": "win-now"}', "owner objective state"],
];

for (const [file, content, description] of LEAKS) {
  check(`catches ${description}`, scanContent(file, content).length > 0,
    `NOT CAUGHT: ${description} in ${file} -- ${content}`);
}

// AN IDENTIFIER IS FORBIDDEN INSIDE A CONTRACT, AND THIS REPOSITORY DIVERGES
// FROM PRO-SCOUT ON PURPOSE. DO NOT ALIGN THEM.
//
// The original reason was "a schema has no reason to carry a real owner id, and
// an example that does is a leak wearing documentation's clothes". pro-scout
// retired that reasoning in its #45, on the grounds that neither it nor
// Gameplan will ever be public, so there is no audience for a leak. It now
// permits identifiers in contracts/, schema/ and docs/, and refuses them only
// where data is persisted. For pro-scout that is sound.
//
// It does not reach here, for one reason that no argument about intent can
// change: THIS REPOSITORY IS PUBLIC. There is an audience. And contracts/ is
// not incidental to that -- VENDORED.json names pro-scout as upstream_repo and
// contracts/gameplan as upstream_subtree, so this directory is copied out of
// the repository that just relaxed the rule, into the one that cannot.
//
// So this case is the last check between an identifier and the open internet.
// If someone reconciles the two checkers because they look like drift, this is
// the line that must not move.
check("catches an owner identifier inside a contract example",
  scanContent("contracts/gameplan/player_observation.schema.json",
    '{"examples": [{"owner_id": "OWNER-JJ-01"}]}').length > 0);

// The data/ manifests are generated upstream and copied here wholesale, so a
// leak arrives already inside a file nobody hand-edits. It is still a leak.
check("catches a leak in a file this repo does not author",
  scanContent("data/team-manifest.json", '{"teams": [{"keeper_slot": 2}]}').length > 0);

// --- what must not be caught ------------------------------------------------------------------

// A contract naming the field is a shape, and shapes are not secrets.
check("allows a contract to declare an owner_id field",
  scanContent("contracts/gameplan/player_observation.schema.json",
    '"owner_id": {"type": "string", "pattern": "^OWNER-[0-9A-Z-]+$"}').length === 0);

// README.md and CLAUDE.md state what this repository forbids and have to be
// able to say what the rule is about.
check("allows the rule files to describe what they forbid",
  scanContent("CLAUDE.md",
    'never carry a "keeper_value": judgement into a public manifest').length === 0);

// The observed NFL facts the page exists to show.
check("allows observed football facts to pass",
  scanContent("data/player-manifest.json",
    '{"gsis_id": "00-0039064", "receptions": 72, "receiving_yards": 803}').length === 0);

// The existing narrower check in test/player-table.test.mjs lists "owner-" as a
// bare substring. That is not an identifier and must not trip this scanner, or
// the two checks would fight.
check("allows the bare marker strings the sibling tests assert on",
  scanContent("test/player-table.test.mjs",
    'for (const forbidden of ["kcffl", "owner-", "franchise_id"])').length === 0);

// --- the repository as it stands --------------------------------------------------------------

const contractFiles = ["contracts/gameplan/player_observation.schema.json", "contracts/VENDORED.json"];
const contractFindings = scanRepository(contractFiles,
  (relative) => readFileSync(join(root, relative), "utf8"));
check("the vendored contracts pass as they stand", contractFindings.length === 0,
  JSON.stringify(contractFindings));

// --- unreadable and binary files ---------------------------------------------------------------

// An unreadable file must be REPORTED, not skipped: a file that was not checked
// is not a clean one, and swallowing the error would turn a scan that inspected
// nothing into a pass.
const unreadable = scanRepository(["data/player-manifest.json"], () => {
  throw new Error("EACCES");
});
check("an unreadable file is reported, not skipped", unreadable.length === 1);
check("and it is reported as not checked",
  unreadable.length === 1 && /not checked/.test(unreadable[0].description));

// A genuinely binary file has no text to match and is skipped without complaint.
check("a binary file is skipped, not reported",
  scanRepository(["src/logo.png"], () => `PNG${String.fromCharCode(0, 0)}IHDR`).length === 0);

// --- the checker is actually wired to the tree --------------------------------------------------

// Non-vacuity: if trackedFiles() ever returned nothing, every assertion above
// would still pass while the repository went unscanned.
const tracked = scanRepository([], () => "");
check("an empty file list finds nothing, which is why the count below matters",
  tracked.length === 0);

// --- the exclusion list, and whether its entries earn their place --------------------------------

// NECESSITY, not membership. An exclusion is a hole: whatever is later written
// into an excluded file is exempt from this check permanently, and the files
// excluded here are by construction the ones that know what a leak looks like.
// An unneeded entry behaves identically to a needed one, so the only way to
// tell them apart is to scan the file unexcluded and see whether anything is
// actually there. This is the same question pro-scout#39 got wrong in the
// other direction -- it excluded a file that named no patterns at all.
for (const relative of SELF) {
  const content = readFileSync(join(root, relative), "utf8");
  check(`the exclusion for ${relative} earns its place`,
    scanContent(relative, content).length > 0,
    `${relative} is excluded from the scan, but scanning it finds nothing --`
    + " the exclusion is unnecessary and exempts every future edit to that file");
}

// --- a source file must never go invisible to the scanner ----------------------------------------

// scanRepository skips any file containing a NUL byte as "genuinely binary".
// That is right for a PNG and catastrophic for a source file: one stray NUL and
// the file stops being scanned, with no error and no finding.
//
// This is not hypothetical. check-public-boundary.mjs itself carried a literal
// NUL on the line that performs this very skip -- written where the escape "\0"
// was meant -- which made it binary to grep, unreviewable in a GitHub diff, and
// skippable by its own rule. It survived only because SELF happened to cover it.
const SOURCE_EXTENSION = /\.(mjs|js|json|md|html|css|ya?ml|txt)$/;
const trackedPaths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const sourcePaths = trackedPaths.filter((relative) => SOURCE_EXTENSION.test(relative));

check("there are source files to check, so the loop below is not vacuous",
  sourcePaths.length > 0);

for (const relative of sourcePaths) {
  check(`${relative} carries no NUL byte`,
    !readFileSync(join(root, relative)).includes(0),
    `${relative} contains a NUL, so the boundary check skips it as binary and`
    + " anything in it goes unscanned");
}

// --- a skip must be counted, never silent --------------------------------------------------------

// The count is what turns "scanned clean" into a claim with a denominator. A
// bare continue said nothing when a file went uninspected, so a leak inside a
// skipped file read exactly like no leak at all.
const binaryTally = {};
scanRepository(["src/logo.png"], () => `PNG${String.fromCharCode(0, 0)}IHDR`, binaryTally);
check("a skipped binary file is counted, not silently dropped",
  binaryTally.binary === 1 && binaryTally.inspected === 0,
  JSON.stringify(binaryTally));

const selfTally = {};
scanRepository([SELF[0]], () => "", selfTally);
check("a self-excluded file is counted too",
  selfTally.excluded === 1 && selfTally.inspected === 0,
  JSON.stringify(selfTally));

const realTally = {};
scanRepository(contractFiles, (relative) => readFileSync(join(root, relative), "utf8"), realTally);
check("the tally reports files actually inspected, not files merely listed",
  realTally.inspected === contractFiles.length, JSON.stringify(realTally));

console.log(failures === 0
  ? `public boundary: all checks passed (${LEAKS.length} planted leaks caught,`
    + ` ${SELF.length} exclusions justified, ${sourcePaths.length} source files NUL-free)`
  : `public boundary: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
