// Team name/abbreviation aliasing for search. The manifest only stores the
// canonical nflverse team_id (e.g. "ARI"); people search using whatever
// they're used to (city, nickname, alternate abbreviation). This table maps
// every alias a person might type to its canonical team_id, so the search
// query can be expanded before it's matched against the manifest rather than
// requiring the manifest itself to carry every synonym.
//
// Keys are the canonical team_id values this repo's manifests actually carry
// -- read them from data/team-manifest.json rather than from memory, because
// two of them are not the abbreviations you would guess: Arizona is ARZ and
// Jacksonville is JAX. A key that matches no record filters the list to
// nothing and skips the substring fallback, so the search gets worse rather
// than better. Extend this list; do not invent a second source of truth for
// team identity.
const TEAM_ALIASES = {
  ARZ: ["arz", "ari", "az", "arizona", "cardinals", "cards"],
  ATL: ["atl", "atlanta", "falcons"],
  BAL: ["bal", "baltimore", "ravens"],
  BUF: ["buf", "buffalo", "bills"],
  CAR: ["car", "carolina", "panthers"],
  CHI: ["chi", "chicago", "bears"],
  CIN: ["cin", "cincinnati", "bengals"],
  CLE: ["cle", "cleveland", "browns"],
  DAL: ["dal", "dallas", "cowboys"],
  DEN: ["den", "denver", "broncos"],
  DET: ["det", "detroit", "lions"],
  GB: ["gb", "gnb", "green bay", "packers"],
  HOU: ["hou", "houston", "texans"],
  IND: ["ind", "indianapolis", "colts"],
  JAX: ["jax", "jac", "jacksonville", "jaguars"],
  KC: ["kc", "kan", "kansas city", "chiefs"],
  LAC: ["lac", "sd", "san diego", "los angeles chargers", "la chargers", "chargers"],
  LAR: ["lar", "la", "st louis", "los angeles rams", "la rams", "rams"],
  LV: ["lv", "oak", "oakland", "las vegas", "raiders"],
  MIA: ["mia", "miami", "dolphins"],
  MIN: ["min", "minnesota", "vikings"],
  NE: ["ne", "nwe", "new england", "patriots", "pats"],
  NO: ["no", "nor", "new orleans", "saints"],
  NYG: ["nyg", "new york giants", "ny giants", "giants"],
  NYJ: ["nyj", "new york jets", "ny jets", "jets"],
  PHI: ["phi", "philadelphia", "eagles"],
  PIT: ["pit", "pittsburgh", "steelers"],
  SEA: ["sea", "seattle", "seahawks"],
  SF: ["sf", "sfo", "san francisco", "49ers", "niners"],
  TB: ["tb", "tam", "tampa bay", "buccaneers", "bucs"],
  TEN: ["ten", "tennessee", "titans"],
  WAS: ["was", "wsh", "washington", "commanders"],
};

// Reverse index: every alias -> its canonical team_id. Built once at module
// load, not per-keystroke.
const ALIAS_TO_TEAM_ID = new Map();
for (const [teamId, aliases] of Object.entries(TEAM_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_TEAM_ID.set(alias, teamId);
  ALIAS_TO_TEAM_ID.set(teamId.toLowerCase(), teamId); // canonical id matches itself
}

/**
 * If the query text is a known team alias, return the canonical team_id.
 * Otherwise return null (not a team query -- caller falls back to normal
 * substring search over the whole record).
 */
export function resolveTeamAlias(query) {
  const q = query.trim().toLowerCase();
  return ALIAS_TO_TEAM_ID.get(q) ?? null;
}

export { TEAM_ALIASES };
