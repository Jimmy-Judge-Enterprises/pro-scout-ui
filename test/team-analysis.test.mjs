// Bare-node test of the generated half of the team browser:
//   node test/team-analysis.test.mjs
//
// This module is the only place in the UI that produces sentences rather than
// displaying stored ones, which makes it the only place that can state something
// untrue. So the assertions are mostly about restraint: that every number is
// derived from the 32 rows on file, that nothing is invented where the record
// says it holds no data, and that nothing here ranks teams by quality.
//
// The league fixture is the repository's own team manifest. A fabricated league
// would let the arithmetic agree with itself while disagreeing with the data.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  INPUT_PURPOSE, analyseTeam, byDivision, coverage, ordinal, personnel, provenance, scheme,
} from "../src/team-analysis.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const league = JSON.parse(readFileSync(join(root, "data/team-manifest.json"), "utf8")).teams;

// --- the test read a real league ----------------------------------------------------

assert.equal(league.length, 32, `the manifest holds ${league.length} teams`);
assert.ok(league.every((t) => t.team_id), "a team row has no id");

// --- divisions ----------------------------------------------------------------------

const groups = byDivision(league);
assert.equal(groups.length, 8, `grouped into ${groups.length} divisions`);
assert.deepEqual(
  groups.map((g) => g.label),
  ["AFC East", "AFC North", "AFC South", "AFC West",
    "NFC East", "NFC North", "NFC South", "NFC West"],
  "divisions are not in standings order",
);
for (const group of groups) {
  assert.equal(group.teams.length, 4, `${group.label} has ${group.teams.length} teams`);
  const names = group.teams.map((t) => t.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)),
    `${group.label} is not in name order; ordering a public list by a captured value `
    + "is a judgement wearing a sort's clothing");
}
assert.equal(groups.flatMap((g) => g.teams).length, 32, "grouping lost or duplicated a team");

// The Rams and Cardinals resolve before they are grouped. Before the builder read
// the alias map these arrived as LAR/ARZ against players on LA/ARI.
const nfcWest = groups.find((g) => g.label === "NFC West").teams.map((t) => t.team_id);
assert.ok(nfcWest.includes("LAR") && !nfcWest.includes("LA"), `NFC West: ${nfcWest}`);
assert.ok(nfcWest.includes("ARI") && !nfcWest.includes("ARZ"), `NFC West: ${nfcWest}`);

// --- coverage is about the capture, not the club ------------------------------------

{
  const cov = coverage(league[0], league);
  assert.equal(cov.total, Object.keys(INPUT_PURPOSE).length);
  assert.ok(cov.present > 0 && cov.present <= cov.total);
  assert.ok(
    cov.uniform,
    "every team is currently missing the same three inputs; if that changes, the "
    + "uniform note must stop claiming it",
  );
  for (const block of cov.blocks) {
    assert.ok(block.blocks, `${block.input} is reported missing without saying what it costs`);
  }

  // A team missing something nobody else is missing must NOT be described as a
  // league-wide gap.
  const odd = { ...league[0], team_id: "ZZZ", inputs: { ...league[0].inputs, staff: false } };
  const oddCov = coverage(odd, league);
  assert.ok(oddCov.missing.includes("staff"));
  assert.equal(oddCov.uniform, false, "a gap peculiar to one club was called league-wide");
}

// --- personnel is a rank of a fact, never of a team ---------------------------------

{
  const usages = league.map((t) => t.personnel_usage_pct).filter(Number.isFinite);
  const top = league.find((t) => t.personnel_usage_pct === Math.max(...usages));
  const per = personnel(top, league);
  assert.equal(per.leagueRank, 1, "the highest usage is not ranked first");
  assert.ok(per.delta > 0, "the highest usage is not above the mean");
  assert.ok(Math.abs(per.leagueMean - (usages.reduce((a, b) => a + b, 0) / usages.length)) < 1e-9,
    "the reported mean is not the mean of the manifest");
  assert.ok(per.divisionRank >= 1 && per.divisionRank <= per.divisionSize);

  // The rank must be computed, not asserted. Checking only the top team passes
  // against a function that returns 1 for everybody, which is exactly what a
  // mutation test found. So every team's rank is recomputed independently here.
  for (const team of league.filter((t) => Number.isFinite(t.personnel_usage_pct))) {
    const p = personnel(team, league);
    const strictlyAbove = usages.filter((u) => u > team.personnel_usage_pct).length;
    assert.equal(
      p.leagueRank, strictlyAbove + 1,
      `${team.team_id} ranked ${p.leagueRank} with ${strictlyAbove} teams above him`,
    );
  }
  assert.ok(
    new Set(league.filter((t) => Number.isFinite(t.personnel_usage_pct))
      .map((t) => personnel(t, league).leagueRank)).size > 1,
    "every team received the same rank; the ranking is not ranking",
  );

  // A team with no captured usage gets nulls, not a zero and not the mean.
  const blank = personnel({ ...league[0], personnel_usage_pct: null }, league);
  assert.equal(blank.usage, null);
  assert.equal(blank.delta, null);
  assert.equal(blank.leagueRank, null, "an uncaptured team was given a rank anyway");
}

// --- scheme -------------------------------------------------------------------------

{
  const sch = scheme(league[0], league);
  const actual = league.filter((t) => t.base_front === league[0].base_front).length;
  assert.equal(sch.sharedWith, actual, "the shared-front count disagrees with the manifest");
  assert.equal(sch.division.length, 4, "a division did not have four teams");
  const noFront = scheme({ ...league[0], base_front: null }, league);
  assert.equal(noFront.front, null);
  assert.equal(noFront.sharedWith, 0, "a team with no captured front was counted among a front");
}

// --- provenance reads the source date, never invents a capture date -----------------

{
  const pro = provenance(league[0], league);
  assert.equal(pro.hasCaptureDate, false,
    "captured_at is null on every team; if that changes this note must change with it");
  assert.ok(pro.sourceUpdatedAt, "no source date to report");
  assert.ok(pro.recencyRank >= 1 && pro.recencyRank <= pro.dated);

  const undated = provenance({ ...league[0], source_updated_at: null }, league);
  assert.equal(undated.recencyRank, null, "a team with no date was ranked by date anyway");
}

// --- the findings say only what the facts support ------------------------------------

for (const team of league) {
  const { findings } = analyseTeam(team, league);
  assert.ok(findings.length >= 3, `${team.team_id} produced ${findings.length} findings`);

  const text = findings.map((f) => `${f.heading} ${f.body} ${f.note ?? ""}`).join(" ");

  // Nothing may render as a missing value.
  assert.ok(!/undefined|null|NaN|Infinity/.test(text), `${team.team_id}: ${text.slice(0, 160)}`);

  // Nothing may rate the team. These are the words a generated section drifts
  // toward first, and every one of them would be a judgement on a public page.
  for (const forbidden of [
    "elite", "weak", "strong offense", "should draft", "avoid", "sleeper", "bust",
    "value", "upside", "recommend", "best ", "worst ",
  ]) {
    assert.ok(!text.toLowerCase().includes(forbidden),
      `${team.team_id} analysis says "${forbidden}", which is a judgement, not a derivation`);
  }

  // Where the record declares an input uncaptured, the analysis must say so rather
  // than describe it. A confident sentence about red-zone usage, generated from a
  // record stating it holds no red-zone data, is the worst thing this can produce.
  const cov = coverage(team, league);
  if (cov.missing.includes("red_zone_goal_line")) {
    assert.ok(
      findings.some((f) => f.heading === "Not answerable from this record"),
      `${team.team_id} hides its uncaptured inputs instead of naming them`,
    );
    assert.ok(!/red[- ]zone (usage|rate) (is|was|sits)/i.test(text),
      `${team.team_id} describes red-zone usage it does not have`);
  }
}

// --- every claimed number is checkable against the manifest ---------------------------

{
  const team = league.find((t) => Number.isFinite(t.personnel_usage_pct));
  const { findings } = analyseTeam(team, league);
  const body = findings.find((f) => f.heading === "Personnel").body;
  assert.ok(body.includes(`${team.personnel_usage_pct}%`), "the stated usage is not the team's");
  const per = personnel(team, league);
  assert.ok(body.includes(per.leagueMean.toFixed(1)), "the stated mean is not the computed mean");
  assert.ok(body.includes(ordinal(per.leagueRank)), "the stated rank is not the computed rank");
}

assert.equal(ordinal(1), "1st");
assert.equal(ordinal(2), "2nd");
assert.equal(ordinal(3), "3rd");
assert.equal(ordinal(4), "4th");
assert.equal(ordinal(11), "11th", "11th is not 11st");
assert.equal(ordinal(12), "12th");
assert.equal(ordinal(13), "13th");
assert.equal(ordinal(21), "21st");
assert.equal(ordinal(112), "112th");

console.log(`team-analysis tests passed: ${league.length} teams, ${groups.length} divisions, `
  + `every finding derived and none of them a judgement`);
