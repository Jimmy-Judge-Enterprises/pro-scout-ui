// Bare-node test of the player table's data contract. No framework:
//   node test/player-table.test.mjs
//
// Every player here is read from the repository's own manifest. Fabricating one
// would test a shape nothing produces, and this file exists precisely because a
// shape mismatch between the two halves of that manifest is the failure it
// guards against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PRESENCE_VALUES, filterByPresence, playerRow, presenceOf } from "../src/presence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "data/player-manifest.json"), "utf8"));
const players = manifest.players;

// --- the test read a real manifest --------------------------------------------------

assert.ok(players.length > 100, "the manifest is nearly empty; nothing below would mean anything");
assert.ok(manifest.coverage, "the manifest carries no coverage block");

// --- held and available partition the file -------------------------------------------

const held = filterByPresence(players, "held");
const available = filterByPresence(players, "available");
const all = filterByPresence(players, "all");

assert.equal(held.length + available.length, players.length, "presence must partition the manifest");
assert.equal(all.length, players.length, '"all" must not filter');
assert.ok(held.length > 0 && available.length > 0, "one half is empty; the filter is untested in practice");
assert.equal(available.length, manifest.coverage.available_to_add);

const heldIds = new Set(held.map((p) => p.gsis_id));
assert.ok(
  !available.some((p) => heldIds.has(p.gsis_id)),
  "a player offered as addable is already captured; the delta is wrong",
);

// --- one row shape, both halves --------------------------------------------------------

// The table renders one set of columns. A field present on held rows and absent
// on available ones renders as undefined in a cell, which reads as a fact.
const COLUMNS = ["gsis_id", "name", "position", "team_id", "team_last_played",
  "last_played_season", "presence", "capture_status", "captured_at"];
for (const row of [held[0], available[0]]) {
  for (const column of COLUMNS) {
    assert.ok(column in row, `${row.presence} rows lack ${column}; the table would have two shapes`);
  }
}

// --- an unmarked row is held, never available ------------------------------------------

// An older manifest predates the field. Defaulting the other way would invite an
// ingest request for a player pro-scout already holds.
assert.equal(presenceOf({}), "held");
assert.equal(presenceOf({ presence: "available" }), "available");
assert.deepEqual(filterByPresence([{ gsis_id: "x" }], "available"), []);
assert.equal(filterByPresence([{ gsis_id: "x" }], "held").length, 1);

// --- a team change is shown, not hidden --------------------------------------------------

// The manifest used to withhold any player whose captured club differed from his
// current one, which hid exactly the players who had moved.
const movers = held.filter((p) => p.team_last_played && p.team_last_played !== p.team_id);
assert.ok(movers.length > 0, "no mover in the manifest; the case the table renders is unexercised");
for (const mover of movers) {
  assert.ok(mover.team_id, `${mover.name} has no current club to show`);
  assert.ok(mover.last_played_season, `${mover.name} has no season for his previous club`);
}
assert.deepEqual(manifest.withheld, [], "a team change must not withhold a player");

// --- nothing on this public page ranks ------------------------------------------------------

// Every column is a public NFL fact, so the boundary checker passes the file. But
// WHICH players appear and in WHAT ORDER is itself information: an ordering derived
// from league judgement would publish draft strategy through selection alone, with
// no forbidden string for the checker to find.
for (const row of players) {
  for (const forbidden of ["rank", "score", "priority", "vor", "value", "keeper", "tier"]) {
    assert.ok(!(forbidden in row), `the public manifest ranks players by ${forbidden}`);
  }
}
const serialised = JSON.stringify(manifest).toLowerCase();
for (const forbidden of ["kcffl", "owner-", "franchise_id"]) {
  assert.ok(!serialised.includes(forbidden), `the public manifest carries ${forbidden}`);
}

// Available rows are alphabetical, which is a generic order and must stay one.
const names = available.map((p) => p.name);
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)),
  "available rows are not in name order; a non-generic sort leaks judgement");

// --- what one row actually says ------------------------------------------------------------

// The row derivation is pure so it can be checked here; app.js turns the result
// into cells and does nothing else to it. What is NOT covered by this file is the
// browser render itself -- appendChild, styling, layout.
{
  const mover = movers[0];
  const drawn = playerRow(mover);
  assert.equal(drawn.team, mover.team_id, "the team column must show the current club");
  assert.equal(drawn.moved, true, "a player who changed clubs is not flagged");
  assert.match(drawn.lastPlayed, new RegExp(String(mover.last_played_season)));
  assert.match(drawn.lastPlayed, new RegExp(mover.team_last_played));

  const stayed = held.find((p) => p.team_last_played && p.team_last_played === p.team_id);
  assert.ok(stayed, "no player stayed put; the negative case is unexercised");
  assert.equal(playerRow(stayed).moved, false, "a player who did not move is flagged as moved");

  // An available player has no capture and no played season, and must say so
  // rather than render an empty cell that reads as a measured blank.
  const addable = playerRow(available[0]);
  assert.equal(addable.hasCapture, false, "an available row must not claim a capture state");
  assert.equal(playerRow(held[0]).hasCapture, true, "a held row has a capture to report");
  assert.equal(addable.lastPlayed, null, "an available row must not claim a played season");
  assert.ok(addable.name && addable.position, "an available row is missing its identity columns");

  // Missing values degrade to empty strings, never to "undefined" in a cell.
  const bare = playerRow({ gsis_id: "00-0000000" });
  assert.equal(bare.name, "00-0000000", "a nameless row must fall back to its id");
  assert.equal(bare.team, "");
  assert.equal(bare.moved, false);
  assert.equal(bare.lastPlayed, null);
  for (const value of Object.values(bare)) {
    assert.ok(String(value) !== "undefined", "a row cell would render the word undefined");
  }
}

// --- the filter vocabulary is closed ----------------------------------------------------------

assert.deepEqual([...PRESENCE_VALUES], ["held", "available", "all"]);
for (const value of new Set(players.map(presenceOf))) {
  assert.ok(PRESENCE_VALUES.includes(value), `the manifest uses an unknown presence: ${value}`);
}

console.log(`player-table tests passed: ${held.length} held, ${available.length} available, `
  + `${movers.length} shown as moved`);
