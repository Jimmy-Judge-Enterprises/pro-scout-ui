// Bare-node test of the prospect profile panel:
//   node test/anatomy-panel.test.mjs
//
// A gauge bar is a claim about where a man sits among his peers, and it is the
// most confident-looking thing on the page. The design this was mined from filled
// its bars from a literal when it had no percentile -- 65, 78, 70, 50, described
// in its own comment as "mock visual percentages".
//
// So most of what is asserted here is refusal: no bar without a cohort, no bar
// without a stated basis, and the right DIRECTION for a metric where smaller is
// better. A forty-yard dash ranked as "higher is better" puts the slowest man in
// the class at the top of the speed bar and looks entirely normal doing it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  GAUGES, PRODUCTION, cohortFor, dig, gaugesFor, heroFor, initialsOf, percentileOf, productionFor,
} from "../src/anatomy-panel.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const players = JSON.parse(readFileSync(join(root, "data/player-manifest.json"), "utf8")).players;
const withProfile = players.filter((p) => p.anatomy);

const cohort = (values) => values;

// --- the test read real profiles -----------------------------------------------------

assert.ok(withProfile.length > 50, `only ${withProfile.length} profiles; nothing below means much`);

// --- direction ------------------------------------------------------------------------

{
  // Ten times, 4.30 quickest. The quickest man must be at the top.
  const times = [4.30, 4.35, 4.40, 4.45, 4.50, 4.55, 4.60, 4.65, 4.70, 4.75];
  const quickest = percentileOf(4.30, cohort(times), { lowerIsBetter: true });
  const slowest = percentileOf(4.75, cohort(times), { lowerIsBetter: true });
  assert.ok(quickest > slowest, `4.30 ranked ${quickest} and 4.75 ranked ${slowest}`);
  assert.ok(quickest >= 90, `the quickest forty in the cohort is only ${quickest}th`);

  // The same numbers read as higher-is-better must invert. This is the assertion
  // that catches a gauge declared the wrong way round.
  assert.ok(percentileOf(4.30, cohort(times), { lowerIsBetter: false })
    < percentileOf(4.75, cohort(times), { lowerIsBetter: false }));
}

{
  const scores = [80, 85, 90, 95, 100, 105, 110, 115, 120, 125];
  assert.ok(percentileOf(125, cohort(scores)) >= 90, "the best speed score is not at the top");
  assert.ok(percentileOf(80, cohort(scores)) <= 15, "the worst speed score is not at the bottom");
}

// --- no cohort, no bar -------------------------------------------------------------------

{
  assert.equal(percentileOf(4.4, cohort([4.5, 4.6])), null,
    "a percentile was drawn from a cohort of two");
  assert.equal(percentileOf(4.4, cohort([])), null);
  assert.equal(percentileOf(4.4, null), null);
  assert.equal(percentileOf(null, cohort([4.5, 4.6, 4.7, 4.8, 4.9, 5.0, 5.1, 5.2])), null,
    "a percentile was computed for a player with no value");
  assert.equal(percentileOf("fast", cohort([4.5, 4.6, 4.7, 4.8, 4.9, 5.0, 5.1, 5.2])), null);

  // Eight is the floor. Seven must refuse.
  const seven = [1, 2, 3, 4, 5, 6, 7];
  assert.equal(percentileOf(4, cohort(seven)), null, "seven is below the stated minimum cohort");
  assert.ok(percentileOf(4, cohort([...seven, 8])) !== null, "eight should be enough");
}

// --- ties do not straddle a boundary --------------------------------------------------------

{
  // Times, so quicker is better and 4.5 must outrank 4.6.
  const tied = [4.5, 4.5, 4.5, 4.5, 4.6, 4.6, 4.6, 4.6];
  const quick = percentileOf(4.5, cohort(tied), { lowerIsBetter: true });
  assert.equal(quick, percentileOf(4.5, cohort(tied), { lowerIsBetter: true }),
    "the same value ranked differently twice");
  assert.ok(quick > percentileOf(4.6, cohort(tied), { lowerIsBetter: true }),
    `4.5 ranked ${quick} against 4.6 at ${percentileOf(4.6, cohort(tied), { lowerIsBetter: true })}`);
  // Every tied member sits at the same place, not spread across the band.
  assert.equal(quick, percentileOf(4.5, cohort(tied), { lowerIsBetter: true }));
}

// --- the cohort is his own position and his own class ------------------------------------------

{
  const receiver = withProfile.find((p) => p.anatomy.position_group === "WR");
  const peers = cohortFor(receiver, players);
  assert.ok(peers.length > 10, `only ${peers.length} peers for a receiver`);
  assert.ok(peers.every((c) => c.position_group === "WR"),
    "a running back was in a receiver's cohort; his forty means nothing there");
  assert.ok(peers.every((c) => c.source_year === receiver.anatomy.source_year),
    "another draft class was in the cohort");
  assert.ok(!peers.includes(receiver.anatomy), "a player is in his own cohort");
}

// --- every gauge states what its bar is a percentile of ------------------------------------------

for (const player of withProfile) {
  for (const gauge of gaugesFor(player, players)) {
    assert.ok(gauge.basis, `${player.name}: a gauge with no stated basis`);
    if (gauge.percentile === null) {
      assert.match(gauge.basis, /too few/, "a missing percentile did not say why");
    } else {
      assert.ok(gauge.percentile >= 0 && gauge.percentile <= 100,
        `${player.name}: percentile ${gauge.percentile}`);
      assert.match(gauge.basis, /percentile of \d+/, "a bar without a cohort size beside it");
    }
    assert.ok(!/undefined|null|NaN/.test(`${gauge.display} ${gauge.basis}`), gauge.display);
  }
}

// --- nothing is invented ------------------------------------------------------------------------

{
  // A player with a value but no peers gets the value and NO bar. This is the
  // whole point: the source design would have drawn one at 65%.
  const lonely = {
    gsis_id: "x", name: "Only One",
    anatomy: { position_group: "WR", source_year: 1999, forty_yard_dash: 4.4, measures: {} },
  };
  const [gauge] = gaugesFor(lonely, [lonely]);
  assert.equal(gauge.percentile, null, "a bar was drawn with a cohort of nobody");
  assert.equal(gauge.display, "4.4s");

  // A measure that was not captured produces no tile at all, rather than an
  // empty one that reads as a measurement of zero.
  const bare = { gsis_id: "y", name: "No Testing",
    anatomy: { position_group: "WR", source_year: 2026, measures: {} } };
  assert.deepEqual(gaugesFor(bare, players), []);
  assert.deepEqual(productionFor(bare), []);
}

// --- the hero card ---------------------------------------------------------------------------------

{
  // Round two or later. In round one the overall selection and the pick within the
  // round are the same number, so a round-one player cannot tell the two apart --
  // which is exactly what made the original mix-up look correct.
  const drafted = withProfile.find((p) => p.anatomy.draft_status === "DRAFTED"
    && p.anatomy.nfl_draft_pick && p.anatomy.nfl_draft_round >= 2);
  assert.ok(drafted, "no drafted profile past round one to distinguish the two notations");
  const hero = heroFor(drafted);
  const badge = hero.badges.find((b) => b.label === "Drafted");
  assert.equal(badge.value, `${drafted.anatomy.nfl_draft_round}.${drafted.anatomy.nfl_draft_pick}`);
  assert.notEqual(badge.value, drafted.anatomy.draft_capital_source_value,
    "the badge shows the workbook's within-round pick instead of the overall selection");
  assert.ok(hero.sourceSlot, "the workbook's own slot is not kept beside it");

  const udfa = withProfile.find((p) => p.anatomy.draft_status === "UDFA");
  assert.ok(udfa, "no undrafted free agent has a profile; that was the reported bug");
  assert.equal(heroFor(udfa).badges.find((b) => b.label === "Entry").value, "UDFA");
  assert.ok(!heroFor(udfa).badges.some((b) => b.label === "Drafted"));

  assert.equal(heroFor({ name: "Nobody" }), null, "a player with no profile got a hero card");
}

assert.equal(initialsOf("Makai Lemon"), "ML");
assert.equal(initialsOf("Omar Cooper Jr."), "OC", "only the first two names make the initials");
assert.equal(initialsOf(""), "--");
assert.equal(initialsOf(null), "--");

// --- shape ------------------------------------------------------------------------------------------

assert.equal(dig({ measures: { bmi: 24.6 } }, "measures.bmi"), 24.6);
assert.equal(dig({ measures: {} }, "measures.bmi"), null);
assert.equal(dig(null, "measures.bmi"), null);
assert.equal(dig({}, "a.b.c"), null, "a missing path must not throw");

for (const gauge of GAUGES) {
  assert.equal(typeof gauge.lowerIsBetter, "boolean",
    `${gauge.label} does not declare its direction; a bar would guess`);
}
assert.ok(PRODUCTION.every((tile) => tile.key.startsWith("measures.")),
  "a production tile reads outside the measures block");

console.log(`anatomy-panel tests passed: ${withProfile.length} profiles, `
  + "every bar computed from a real cohort or not drawn");
