// ------------------------------------------------------------ table sort ---
// Sorting the player table by a column the reader clicked.
//
// WHY THIS IS NOT THE SAME AS THE MANIFEST'S ORDER
//   The manifest is published in a deliberately generic order -- available rows
//   alphabetical, held rows in capture order -- because WHICH players a public
//   page lists and IN WHAT ORDER is itself information, and an ordering derived
//   from league judgement would publish draft strategy through selection alone.
//
//   A reader clicking a column header is a different thing entirely. He is asking
//   a question of data already in front of him, the answer is his alone, and no
//   ordering leaves the page. So the sortable columns are public facts -- club and
//   the season last played -- and nothing here sorts by a value this system
//   computed about a player.
//
// WHY EMPTY SORTS FIRST ASCENDING
//   A player with no last-played season has not played one, and "no season" comes
//   before the earliest season rather than after the latest. Ascending therefore
//   surfaces the players carrying no season data at all, which is the state worth
//   noticing: an available row has no capture, and a held row with no season is a
//   record that was captured and holds nothing to rank him on.
//
//   It is NOT a rookie filter, and must not be labelled one. Of the held players
//   with an empty Last Played, most are veterans whose captured record simply has
//   no season stats -- Donald Parham, Salvon Ahmed, Israel Abanikanda among them.
//   The manifest carries rookie_season only on available rows, so the table cannot
//   currently answer "is this a rookie" for a captured player at all.

// `absentLast` says whether a missing value participates in the ordering or is
// simply pushed to the bottom whichever way the column is sorted.
//
// An absent SEASON participates: "has not played" is a real position on a scale of
// seasons, before the earliest, so it leads ascending and trails descending.
//
// An absent CLUB does not. It is a gap in the record rather than a point on a
// scale, and it belongs at the bottom either way -- a block of blanks at the top
// of a descending sort reads as a finding when it is an absence.
export const SORTABLE = Object.freeze({
  // Alphabetical, not depth-chart order. QB/RB/WR/TE/K is how a football person
  // reads a roster, but it is a convention this module would have to assert, and
  // an unlisted position would have nowhere to go in it. Alphabetical is what a
  // text column does everywhere else on the page and needs no table of its own.
  position: { label: "Pos", field: "position", kind: "text", absentLast: true },
  team: { label: "Team", field: "team_id", kind: "text", absentLast: true },
  lastPlayed: { label: "Last played", field: "last_played_season", kind: "season", absentLast: false },
});

export const DIRECTIONS = Object.freeze(["asc", "desc"]);

const name = (row) => String(row?.name ?? row?.gsis_id ?? "");

function compareSeason(a, b) {
  const left = Number.isFinite(Number(a)) && a !== null && a !== "" ? Number(a) : null;
  const right = Number.isFinite(Number(b)) && b !== null && b !== "" ? Number(b) : null;
  if (left === right) return 0;
  // Absent is lower than any season, so ascending puts it first. Treating it as 0
  // would work by accident and break the day a season is recorded as 0.
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}

function compareText(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

const isAbsent = (value) => value === null || value === undefined || value === "";

/**
 * A copy of `rows`, ordered by `column`. An unknown column returns the rows
 * untouched, so a stored preference naming a column that no longer exists
 * degrades to the manifest's own order rather than throwing.
 */
export function sortRows(rows, column, direction = "asc") {
  const spec = SORTABLE[column];
  if (!spec) return [...rows];
  const sign = direction === "desc" ? -1 : 1;
  const compare = spec.kind === "season" ? compareSeason : compareText;
  return [...rows].sort((a, b) => {
    const left = a?.[spec.field];
    const right = b?.[spec.field];

    // Decided BEFORE the sign is applied, or reversing the column would carry the
    // blanks to the top with it -- which is what the first version of this did,
    // while its own comment claimed otherwise.
    if (spec.absentLast) {
      const leftAbsent = isAbsent(left);
      const rightAbsent = isAbsent(right);
      if (leftAbsent !== rightAbsent) return leftAbsent ? 1 : -1;
    }

    const primary = compare(left, right);
    // Name breaks ties, always ascending, so the order is stable and a reader
    // reversing the direction does not see equal rows shuffle beneath him.
    return primary !== 0 ? sign * primary : name(a).localeCompare(name(b));
  });
}

/** The direction a header click should produce, given what is already applied. */
export function nextDirection(current, column, direction) {
  if (current !== column) return "asc";
  return direction === "asc" ? "desc" : "asc";
}

/** What a screen reader should be told about a column. */
export function ariaSort(column, current, direction) {
  if (column !== current) return "none";
  return direction === "desc" ? "descending" : "ascending";
}

// --- remembering the choice ---------------------------------------------------
// Per viewer, in his own browser. It never reaches another viewer, another device
// or this repository -- it is a convenience, not state anyone else depends on.

const STORAGE_KEY = "pro-scout-ui.player-sort.v1";

/**
 * Every access is guarded. Storage is not merely empty in a private window or
 * with site data cleared -- the accessor itself throws in some contexts, and an
 * unguarded read would take the whole page down before it drew anything.
 */
export function loadSort(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!SORTABLE[parsed?.column]) return null;
    if (!DIRECTIONS.includes(parsed?.direction)) return null;
    return { column: parsed.column, direction: parsed.direction };
  } catch {
    return null;
  }
}

export function saveSort(storage, column, direction) {
  try {
    if (!SORTABLE[column]) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify({ column, direction }));
  } catch {
    // A viewer who blocks storage still gets a working table, just not a
    // remembered one. There is nothing to report and nobody to report it to.
  }
}
