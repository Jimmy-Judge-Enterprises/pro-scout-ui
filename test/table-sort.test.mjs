// Bare-node test of the sortable player table:
//   node test/table-sort.test.mjs
//
// Sorting is where a table quietly lies. A comparator that mishandles an absent
// value does not throw -- it puts rows somewhere plausible and wrong, and the
// reader has no way to tell. So the absent cases carry most of the assertions
// here, and the league fixture is the repository's own manifest rather than rows
// invented to suit the comparator.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DIRECTIONS, SORTABLE, ariaSort, loadSort, nextDirection, saveSort, sortRows,
} from "../src/table-sort.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const players = JSON.parse(readFileSync(join(root, "data/player-manifest.json"), "utf8")).players;

// --- the test read something real ----------------------------------------------------

assert.ok(players.length > 1000, `only ${players.length} rows; nothing below would mean much`);
const withSeason = players.filter((p) => p.last_played_season);
const withoutSeason = players.filter((p) => !p.last_played_season);
assert.ok(withSeason.length > 0 && withoutSeason.length > 0,
  "the manifest has no mix of played and unplayed rows, so the absent case is unexercised");

// --- only public facts are sortable ---------------------------------------------------

// The manifest's own order stays generic on purpose. A reader sorting is a
// different act -- but the columns he can sort by must still be facts, never a
// value this system computed about a player.
assert.deepEqual(Object.keys(SORTABLE).sort(), ["lastPlayed", "team"]);
for (const spec of Object.values(SORTABLE)) {
  for (const forbidden of ["rank", "score", "vor", "value", "keeper", "tier", "priority"]) {
    assert.ok(!spec.field.includes(forbidden), `${spec.field} is a judgement, not a fact`);
  }
}

// --- last played -----------------------------------------------------------------------

{
  const asc = sortRows(players, "lastPlayed", "asc");
  const desc = sortRows(players, "lastPlayed", "desc");

  assert.equal(asc.length, players.length, "sorting lost or duplicated rows");
  assert.equal(new Set(asc.map((p) => p.gsis_id)).size, new Set(players.map((p) => p.gsis_id)).size);

  // Absent sorts first ascending. "No season" is not season zero and is not the
  // latest season; it comes before the earliest.
  assert.ok(!asc[0].last_played_season, "ascending did not lead with an absent season");
  assert.equal(
    asc.slice(0, withoutSeason.length).filter((p) => p.last_played_season).length, 0,
    "a played season appeared among the leading absent block",
  );

  // Once past the absent block, seasons ascend.
  const seasons = asc.slice(withoutSeason.length).map((p) => p.last_played_season);
  assert.deepEqual(seasons, [...seasons].sort((a, b) => a - b), "seasons are not ascending");

  // Descending leads with the most recent and puts the absent block last.
  assert.equal(desc[0].last_played_season, Math.max(...withSeason.map((p) => p.last_played_season)));
  assert.ok(!desc[desc.length - 1].last_played_season, "descending did not put absent last");

  // A season recorded as 0 must not be treated as absent. Nothing in the manifest
  // carries one today, which is exactly why the comparator has to be asked.
  const zeroed = sortRows(
    [{ name: "Zero", last_played_season: 0 }, { name: "None", last_played_season: null },
      { name: "Recent", last_played_season: 2025 }],
    "lastPlayed", "asc",
  );
  assert.deepEqual(zeroed.map((p) => p.name), ["None", "Zero", "Recent"],
    "season 0 was folded together with an absent season");
}

// --- team -------------------------------------------------------------------------------

{
  const asc = sortRows(players, "team", "asc");
  const codes = asc.map((p) => p.team_id).filter(Boolean);
  assert.deepEqual(codes, [...codes].sort((a, b) => a.localeCompare(b)), "clubs are not in order");
  assert.equal(asc.length, players.length);

  // A missing club sorts last in BOTH directions. It is a missing value, not an
  // extreme one, and a column of blanks at the top reads as a finding.
  const mixed = [
    { name: "B", team_id: "BUF" }, { name: "Blank", team_id: null }, { name: "A", team_id: "ARI" },
  ];
  assert.equal(sortRows(mixed, "team", "asc").at(-1).name, "Blank");
  assert.equal(sortRows(mixed, "team", "desc").at(-1).name, "Blank",
    "an absent club led the descending sort instead of trailing it");
}

// --- ties are stable ----------------------------------------------------------------------

{
  // Every Texan shares a club. Reversing direction must not shuffle them, or the
  // reader watching the table flip sees motion that means nothing.
  const texans = players.filter((p) => p.team_id === "HOU");
  assert.ok(texans.length > 5, "too few shared-club rows to test tie stability");
  const inAsc = sortRows(texans, "team", "asc").map((p) => p.name);
  const inDesc = sortRows(texans, "team", "desc").map((p) => p.name);
  assert.deepEqual(inAsc, inDesc, "rows equal on the sorted column moved when direction flipped");
  assert.deepEqual(inAsc, [...inAsc].sort((a, b) => a.localeCompare(b)), "ties are not name-ordered");
}

// --- the input is not mutated ---------------------------------------------------------------

{
  const before = players.map((p) => p.gsis_id);
  sortRows(players, "team", "desc");
  assert.deepEqual(players.map((p) => p.gsis_id), before, "sortRows reordered the caller's array");
}

// --- an unknown column degrades to the manifest's order --------------------------------------

assert.deepEqual(
  sortRows(players, "nonesuch", "asc").map((p) => p.gsis_id), players.map((p) => p.gsis_id),
  "an unknown column must leave the order alone, not throw",
);
assert.deepEqual(sortRows(players, null).map((p) => p.gsis_id), players.map((p) => p.gsis_id));

// --- direction cycling and aria ----------------------------------------------------------------

assert.equal(nextDirection(null, "team", "asc"), "asc", "a first click sorts ascending");
assert.equal(nextDirection("team", "team", "asc"), "desc", "a second click reverses");
assert.equal(nextDirection("team", "team", "desc"), "asc", "a third click reverses back");
assert.equal(nextDirection("team", "lastPlayed", "desc"), "asc",
  "moving to another column starts ascending rather than inheriting");

assert.equal(ariaSort("team", "team", "asc"), "ascending");
assert.equal(ariaSort("team", "team", "desc"), "descending");
assert.equal(ariaSort("team", "lastPlayed", "asc"), "none", "an unsorted column claimed a direction");

// --- remembering, and surviving a browser that refuses ------------------------------------------

{
  const map = new Map();
  const ok = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
  assert.equal(loadSort(ok), null, "an unvisited browser must not claim a stored sort");
  saveSort(ok, "team", "desc");
  assert.deepEqual(loadSort(ok), { column: "team", direction: "desc" });

  // A stored column that no longer exists degrades to the manifest order rather
  // than sorting by nothing or throwing on the first paint.
  map.set("pro-scout-ui.player-sort.v1", JSON.stringify({ column: "gone", direction: "asc" }));
  assert.equal(loadSort(ok), null);
  map.set("pro-scout-ui.player-sort.v1", JSON.stringify({ column: "team", direction: "sideways" }));
  assert.equal(loadSort(ok), null, "an unknown direction was accepted");
  map.set("pro-scout-ui.player-sort.v1", "{not json");
  assert.equal(loadSort(ok), null, "corrupt stored state was not survived");

  // The accessor itself throws in a private window or with site data blocked --
  // it does not merely return null. Unguarded, that takes the page down before it
  // draws anything.
  const hostile = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.equal(loadSort(hostile), null, "a throwing storage was not survived on read");
  saveSort(hostile, "team", "asc"); // must not throw
  assert.equal(loadSort(null), null, "a missing storage object was not survived");
  saveSort(null, "team", "asc"); // must not throw

  assert.deepEqual([...DIRECTIONS], ["asc", "desc"]);
}

console.log(`table-sort tests passed: ${players.length} rows, `
  + `${withoutSeason.length} with no season lead the ascending sort`);
