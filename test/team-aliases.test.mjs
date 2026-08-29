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
import { resolveTeamAlias, TEAM_ALIASES } from "../src/team-aliases.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const teams = JSON.parse(readFileSync(join(root, "data", "team-manifest.json"), "utf8")).teams;
const ids = new Set(teams.map((team) => team.team_id));

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
};

const keys = Object.keys(TEAM_ALIASES);
const strays = keys.filter((key) => !ids.has(key));
check("every alias key is a team_id the manifest carries", strays.length === 0,
  `not in the manifest: ${strays.join(", ")}`);
check("every team in the manifest is reachable", keys.length === ids.size,
  `${keys.length} keyed, ${ids.size} in the manifest`);

// A resolved alias must land on a record, or the filter empties the view.
for (const [teamId, aliases] of Object.entries(TEAM_ALIASES)) {
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

check("an unknown query falls through rather than filtering", resolveTeamAlias("not a team") === null);
check("case and padding do not matter", resolveTeamAlias("  Cardinals  ") === resolveTeamAlias("cardinals"));

console.log(failures === 0 ? "team aliases: all checks passed" : `team aliases: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
