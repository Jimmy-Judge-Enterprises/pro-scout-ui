// Team identity for search and for extraction. Two layers, because the two
// consumers match differently and conflating them breaks one of them.
//
// IDENTITY_ALIASES are alternate spellings of a club's code. They are matched
// one token at a time, which is what the intake extractor needs: it uses them
// to know that a bare "ARZ" in a capture is a club and not somebody's name.
//
// SEARCH_ALIASES are what a person types into the search box -- nicknames and
// city names. They are matched against a whole query and never against a single
// token, and that restriction is load-bearing rather than tidy. Three of them
// are also parts of real player names in this manifest: "dallas" (Dallas
// Goedert), "washington" (seven players) and "kc". A token-level matcher fed
// these would decide "Dallas" is a club, break the name run before "Goedert",
// and silently drop the player -- the same failure as treating an ordinary word
// as a stopword. test/team-aliases.test.mjs pins the separation.
//
// Canonical codes are the team_id values data/team-manifest.json carries. Read
// them from the file rather than from memory: Jacksonville is JAX, not JAC, and
// Arizona published as ARZ until pro-scout's generator began resolving source
// spellings against its own alias map. A key that matches no record filters the
// list to nothing AND skips the substring fallback, so the search gets worse
// rather than better.

// Alternate club codes. The first three are vendored from pro-scout's
// config/team-aliases.json, which is the authority and is hash-checked by
// scripts/verify-contracts.mjs; the test asserts this table still agrees with
// it. The rest are relocations, renames and provider spellings this repo has
// met and upstream has not yet enumerated -- upstream's rule is "enumerate, do
// not infer", so they are listed here rather than derived, and they are
// candidates to contribute back.
const IDENTITY_ALIASES = {
  // vendored from pro-scout config/team-aliases.json
  LA: "LAR",
  JAC: "JAX",
  ARZ: "ARI",
  // additions owned by this repo
  AZ: "ARI",
  WSH: "WAS",
  WFT: "WAS",
  SFO: "SF",
  GNB: "GB",
  KAN: "KC",
  NWE: "NE",
  NOR: "NO",
  NOS: "NO",
  TAM: "TB",
  LVR: "LV",
  OAK: "LV",
  SD: "LAC",
  SDG: "LAC",
  STL: "LAR",
  CLV: "CLE",
  BLT: "BAL",
  HST: "HOU",
};

// Whole-query only. Keys are canonical team_ids.
const SEARCH_ALIASES = {
  ARI: ["arizona", "cardinals", "cards"],
  ATL: ["atlanta", "falcons"],
  BAL: ["baltimore", "ravens"],
  BUF: ["buffalo", "bills"],
  CAR: ["carolina", "panthers"],
  CHI: ["chicago", "bears"],
  CIN: ["cincinnati", "bengals"],
  CLE: ["cleveland", "browns"],
  DAL: ["dallas", "cowboys"],
  DEN: ["denver", "broncos"],
  DET: ["detroit", "lions"],
  GB: ["green bay", "packers"],
  HOU: ["houston", "texans"],
  IND: ["indianapolis", "colts"],
  JAX: ["jacksonville", "jaguars"],
  KC: ["kansas city", "chiefs"],
  LAC: ["san diego", "los angeles chargers", "la chargers", "chargers"],
  LAR: ["st louis", "los angeles rams", "la rams", "rams"],
  LV: ["oakland", "las vegas", "raiders"],
  MIA: ["miami", "dolphins"],
  MIN: ["minnesota", "vikings"],
  NE: ["new england", "patriots", "pats"],
  NO: ["new orleans", "saints"],
  NYG: ["new york giants", "ny giants", "giants"],
  NYJ: ["new york jets", "ny jets", "jets"],
  PHI: ["philadelphia", "eagles"],
  PIT: ["pittsburgh", "steelers"],
  SEA: ["seattle", "seahawks"],
  SF: ["san francisco", "49ers", "niners"],
  TB: ["tampa bay", "buccaneers", "bucs"],
  TEN: ["tennessee", "titans"],
  WAS: ["washington", "commanders"],
};

// Built once at module load, not per keystroke.
const QUERY_INDEX = new Map();
for (const [teamId, aliases] of Object.entries(SEARCH_ALIASES)) {
  for (const alias of aliases) QUERY_INDEX.set(alias, teamId);
  QUERY_INDEX.set(teamId.toLowerCase(), teamId);
}
for (const [alias, canonical] of Object.entries(IDENTITY_ALIASES)) {
  QUERY_INDEX.set(alias.toLowerCase(), canonical);
}

/**
 * The canonical team_id for a whole search query -- a nickname, a city, a code.
 * Null when the query is not a team, so the caller falls back to a substring
 * search over the record rather than filtering the list to nothing.
 */
export function resolveTeamAlias(query) {
  return QUERY_INDEX.get(String(query ?? "").trim().toLowerCase()) ?? null;
}

/**
 * The canonical team_id for a single token, for callers scanning text where a
 * token is either a club code or part of somebody's name. Deliberately blind to
 * nicknames and city names: see the note at the top of this file.
 */
export function teamTokenCode(token) {
  const code = String(token ?? "").trim().toUpperCase();
  return IDENTITY_ALIASES[code] ?? null;
}

export { IDENTITY_ALIASES, SEARCH_ALIASES };
