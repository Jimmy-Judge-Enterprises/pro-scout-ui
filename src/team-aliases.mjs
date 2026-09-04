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

// Alternate club codes this repo owns: relocations, renames and provider
// spellings met here that upstream has not enumerated. Upstream's rule is
// "enumerate, do not infer", so they are listed rather than derived, and they
// are candidates to contribute back.
//
// The aliases pro-scout declares are NOT repeated here. They arrive from
// contracts/pro-scout/team-aliases.json through adoptVendoredAliases, because a
// value restated in two places is a value that can disagree with itself. The
// test fails if any of them reappears below.
const LOCAL_ALIASES = {
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

// The merged view: what this repo owns, plus whatever the vendored file adds.
const identity = { ...LOCAL_ALIASES };

// Rebuilt when the vendored file arrives, not per keystroke.
const QUERY_INDEX = new Map();
function rebuildQueryIndex() {
  QUERY_INDEX.clear();
  for (const [teamId, aliases] of Object.entries(SEARCH_ALIASES)) {
    for (const alias of aliases) QUERY_INDEX.set(alias, teamId);
    QUERY_INDEX.set(teamId.toLowerCase(), teamId);
  }
  for (const [alias, canonical] of Object.entries(identity)) {
    QUERY_INDEX.set(alias.toLowerCase(), canonical);
  }
}
rebuildQueryIndex();

/**
 * Take the club codes pro-scout declares, from the vendored copy of its
 * config/team-aliases.json. This is the only place those values enter, so they
 * cannot drift from the file that owns them. Call it before anything reads the
 * table; if the file never arrives the codes it carries are simply absent,
 * which is louder than quietly resolving them from a stale copy.
 */
export function adoptVendoredAliases(document) {
  for (const [code, entry] of Object.entries(document?.aliases ?? {})) {
    if (entry?.canonical) identity[code] = entry.canonical;
  }
  rebuildQueryIndex();
  return identity;
}

/** The merged club-code table: repo-owned entries plus whatever was adopted. */
export function identityAliases() {
  return identity;
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
  return identity[code] ?? null;
}

export { LOCAL_ALIASES, SEARCH_ALIASES };
