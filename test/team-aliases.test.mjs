// The search aliases resolve to a canonical team_id, and the Teams view filters
// on exact equality against it. So a key that no manifest record carries does
// not merely fail to help -- it filters the list to nothing AND skips the
// substring fallback, leaving a search that used to work returning nothing.
//
// Two ids in this manifest are not the abbreviations you would guess (ARZ, not
// ARI; JAX, not JAC), which is exactly how that shipped once. This pins it.
//
//   node test/team-aliases.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTeamAlias, teamTokenCode, IDENTITY_ALIASES, SEARCH_ALIASES } from "../src/team-aliases.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const teams = JSON.parse(readFileSync(join(root, "data", "team-manifest.json"), "utf8")).teams;
const ids = new Set(teams.map((team) => team.team_id));

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
};

const keys = Object.keys(SEARCH_ALIASES);
const strays = keys.filter((key) => !ids.has(key));
check("every alias key is a team_id the manifest carries", strays.length === 0,
  `not in the manifest: ${strays.join(", ")}`);
check("every team in the manifest is reachable", keys.length === ids.size,
  `${keys.length} keyed, ${ids.size} in the manifest`);

// A resolved alias must land on a record, or the filter empties the view.
for (const [teamId, aliases] of Object.entries(SEARCH_ALIASES)) {
  for (const alias of aliases) {
    const resolved = resolveTeamAlias(alias);
    check(`"${alias}" resolves to a real team`, resolved === teamId && ids.has(resolved),
      `got ${resolved}`);
  }
}

// Each team's own name and nickname should get there, since that is what people
// type; caught from the manifest rather than restated here.
for (const team of teams) {
  const nickname = team.name.split(" ").at(-1).toLowerCase();
  check(`"${nickname}" finds ${team.team_id}`, resolveTeamAlias(nickname) === team.team_id,
    `got ${resolveTeamAlias(nickname)}`);
}

// --- the vendored map is the authority for club codes -----------------------
const vendored = JSON.parse(readFileSync(join(root, "contracts", "pro-scout", "team-aliases.json"), "utf8"));
for (const [code, entry] of Object.entries(vendored.aliases)) {
  check(`vendored ${code} -> ${entry.canonical} is honoured`, IDENTITY_ALIASES[code] === entry.canonical,
    `this repo maps it to ${IDENTITY_ALIASES[code]}`);
  check(`vendored ${code} resolves to a real team`, ids.has(entry.canonical));
}
for (const [alias, canonical] of Object.entries(IDENTITY_ALIASES)) {
  check(`club code ${alias} points at a team the manifest has`, ids.has(canonical), `-> ${canonical}`);
  check(`club code ${alias} is matched as a token`, teamTokenCode(alias) === canonical);
}

// --- nicknames must never reach the token matcher ---------------------------
// "dallas" is half of Dallas Goedert's name and "washington" is seven players'
// surname. A token-level matcher fed these breaks the name run and drops them
// with no error, which is the bug this separation exists to prevent.
const players = JSON.parse(readFileSync(join(root, "data", "player-manifest.json"), "utf8")).players;
const nameTokens = new Set();
for (const player of players) {
  for (const token of String(player.name).split(/\s+/)) {
    const flat = token.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (flat) nameTokens.add(flat);
  }
}
const leaked = Object.values(SEARCH_ALIASES).flat()
  .filter((alias) => !alias.includes(" ") && nameTokens.has(alias.toUpperCase()) && teamTokenCode(alias));
check("no search alias that is also a player name is matched as a token", leaked.length === 0,
  `leaked: ${leaked.join(", ")}`);

check("an unknown query falls through rather than filtering", resolveTeamAlias("not a team") === null);
check("case and padding do not matter", resolveTeamAlias("  Cardinals  ") === resolveTeamAlias("cardinals"));

console.log(failures === 0 ? "team aliases: all checks passed" : `team aliases: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
