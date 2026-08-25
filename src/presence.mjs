// --------------------------------------------------------------- presence ---
// Which half of the player manifest to show.
//
// The manifest carries captured players and addable ones in ONE list under a
// `presence` field, because they are the same table with one column different.
// Splitting them into two files would let the two drift into different row
// shapes, which is how a column ends up holding current clubs for one half and
// last-played clubs for the other.
//
// Kept out of app.js so it can be tested without a DOM. app.js reads the
// document at module scope, so anything importable from a bare-node test has to
// live outside it.

export const PRESENCE_VALUES = Object.freeze(["held", "available", "all"]);

// A row with no `presence` is HELD, never available. An older manifest predates
// the field, and defaulting the other way would invite an ingest request for a
// player pro-scout has already captured -- work that looks new and is not.
export const presenceOf = (item) => item?.presence ?? "held";

export function filterByPresence(entities, presence) {
  if (presence === "all") return [...entities];
  if (!PRESENCE_VALUES.includes(presence)) return [...entities];
  return entities.filter((item) => presenceOf(item) === presence);
}

// ------------------------------------------------------------------ a row ---
// What one line of the table says, derived rather than assembled inline so it
// can be tested without a DOM. app.js turns this into cells and does nothing
// else to it.
//
// The `moved` flag is the point of the whole change. team_id is where a player
// is NOW; team_last_played is where his last snaps were. The manifest used to
// compare the two and withhold anyone whose answers differed, which hid exactly
// the players who had changed clubs. Here the difference is the headline.
export function playerRow(item) {
  const team = item.team_id ?? "";
  const lastTeam = item.team_last_played ?? "";
  return {
    name: item.name ?? item.gsis_id,
    position: item.position ?? "",
    team,
    moved: Boolean(lastTeam && team && lastTeam !== team),
    // Absent rather than zero: a player with no recorded season has not played
    // one, and an em dash says that without implying a measurement.
    lastPlayed: item.last_played_season ? `${lastTeam} ${item.last_played_season}`.trim() : null,
    // An available player has no capture to be fresh or stale about. A boolean
    // rather than a null-vs-undefined sentinel: the first version distinguished
    // the two halves by which flavour of empty it returned, and an empty that
    // carries meaning is one interpolation away from printing "undefined" in a
    // cell as though it were a fact.
    hasCapture: presenceOf(item) !== "available",
  };
}
