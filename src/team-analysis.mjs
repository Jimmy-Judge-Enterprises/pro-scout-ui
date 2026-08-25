// --------------------------------------------------------- team analysis ---
// The generated half of the team browser.
//
// WHAT THIS IS
//   Everything here is DERIVED, at render time, from the cached facts the
//   manifest carries. Nothing is stored, nothing is fetched, and nothing here is
//   a scouting opinion. It is arithmetic over 32 rows: how one team's captured
//   facts sit against the other 31, and what the record says it does not know.
//
// WHY IT IS DERIVED RATHER THAN PUBLISHED
//   The manifest is a fact file. Writing "5 points above the league mean" into it
//   would freeze a comparison that changes whenever another team is recaptured,
//   and it would put a computed judgement in a file whose whole contract is that
//   it holds observations. The repository already draws this line for freshness --
//   captured_at is fact, "stale" is derived at render -- and this is the same line
//   in the same place.
//
// WHAT IT REFUSES TO DO
//   It does not rate teams, rank them by quality, or say what any of it is worth
//   to a roster. Those are league judgements, they belong in Gameplan, and this
//   page is public. Every number below is a count, a mean, or a position in an
//   ordering of a captured fact -- never an evaluation of one.
//
//   It also does not fill silence. Where the record says `not_captured`, the
//   analysis says so and names what that blocks, rather than inferring a value
//   from the fields that happen to be present. A confident sentence about
//   red-zone tendency, generated from a record that states it has no red-zone
//   data, would be the most damaging thing this module could produce.

// The inputs a team-state record accounts for, and what each one is needed for.
// Named here so a missing input can say what it costs instead of appearing as a
// bare false.
export const INPUT_PURPOSE = Object.freeze({
  staff: "who calls the offence and runs the defence",
  primary_personnel: "the base personnel grouping and how often it is used",
  defensive_base: "the front a defence lines up in",
  depth_chart: "who is on the roster and where",
  advanced_rates: "pace, pass rate over expectation, situational splits",
  red_zone_goal_line: "scoring-position usage, which is where touchdowns come from",
  contract_cap: "cap room and contract horizon",
});

const pct = (value) => (Number.isFinite(value) ? value : null);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Which declared inputs a record carries, and which it says it does not. */
export function coverage(team, league) {
  const inputs = team.inputs ?? {};
  const keys = Object.keys(INPUT_PURPOSE).filter((key) => key in inputs);
  const present = keys.filter((key) => inputs[key] === true);
  const missing = keys.filter((key) => inputs[key] !== true);

  // If every team is missing the same things, that is a fact about the CAPTURE,
  // not about this team, and saying "4 of 7" without saying so invites a reader
  // to think he has found a gap peculiar to the club he is looking at.
  const others = league.filter((other) => other.team_id !== team.team_id);
  const uniform = others.length > 0 && others.every(
    (other) => missing.every((key) => (other.inputs ?? {})[key] !== true),
  );

  return {
    present: present.length,
    total: keys.length,
    missing,
    uniform,
    blocks: missing.map((key) => ({ input: key, blocks: INPUT_PURPOSE[key] })),
  };
}

/** Where a team's base front sits among the 32. */
export function scheme(team, league) {
  const front = team.base_front ?? null;
  if (!front) return { front: null, sharedWith: 0, total: league.length, division: [] };
  const sharedWith = league.filter((other) => other.base_front === front).length;
  const division = league
    .filter((other) => other.division_label === team.division_label)
    .map((other) => ({
      team_id: other.team_id,
      front: other.base_front ?? null,
      same: other.base_front === front,
    }));
  return { front, sharedWith, total: league.length, division };
}

/**
 * Primary personnel against the league.
 *
 * Rank is over a CAPTURED FACT -- how often a grouping is used -- and is not a
 * ranking of teams. First in usage is not first in anything else.
 */
export function personnel(team, league) {
  const usage = pct(team.personnel_usage_pct);
  const measured = league.map((t) => pct(t.personnel_usage_pct)).filter((v) => v !== null);
  const leagueMean = mean(measured);
  if (usage === null || leagueMean === null) {
    return { code: team.personnel_code ?? null, label: team.personnel_label ?? null,
      usage: null, leagueMean, delta: null, leagueRank: null, divisionRank: null,
      measured: measured.length, codeShared: null, total: league.length };
  }
  const ordered = [...measured].sort((a, b) => b - a);
  const divisionUsage = league
    .filter((t) => t.division_label === team.division_label)
    .map((t) => pct(t.personnel_usage_pct))
    .filter((v) => v !== null)
    .sort((a, b) => b - a);
  return {
    code: team.personnel_code ?? null,
    label: team.personnel_label ?? null,
    usage,
    leagueMean,
    delta: usage - leagueMean,
    leagueRank: ordered.indexOf(usage) + 1,
    divisionRank: divisionUsage.indexOf(usage) + 1,
    divisionSize: divisionUsage.length,
    measured: measured.length,
    codeShared: team.personnel_code
      ? league.filter((t) => t.personnel_code === team.personnel_code).length
      : null,
    total: league.length,
  };
}

/**
 * How this team's source date sits among the others.
 *
 * Deliberately reads source_updated_at and not captured_at. The record carries no
 * timestamp for when the capture ran; the depth chart carries one for when the
 * provider last changed the page. Reporting the second as the first would be a
 * claim nobody made.
 */
export function provenance(team, league) {
  const dated = league
    .map((t) => ({ team_id: t.team_id, at: t.source_updated_at ? Date.parse(t.source_updated_at) : NaN }))
    .filter((t) => Number.isFinite(t.at))
    .sort((a, b) => b.at - a.at);
  // Ranked on the date THIS team carries, not on the league's copy of a row with
  // the same id. Looking it up by id alone gave an undated team a rank anyway --
  // it would have printed "16th most recent of 32" about a date it does not have.
  const position = team.source_updated_at
    ? dated.findIndex((t) => t.team_id === team.team_id)
    : -1;
  return {
    provider: team.depth_chart_provider ?? team.source_provider ?? null,
    sourceUpdatedAt: team.source_updated_at ?? null,
    hasCaptureDate: Boolean(team.captured_at),
    recencyRank: position === -1 ? null : position + 1,
    dated: dated.length,
    total: league.length,
  };
}

/**
 * The analysis section as ordered, renderable findings.
 *
 * Each finding is a heading and a body sentence. The strings are built here so
 * they can be asserted in a test; app.js escapes and lays them out and adds
 * nothing of its own.
 */
export function analyseTeam(team, league) {
  const cov = coverage(team, league);
  const sch = scheme(team, league);
  const per = personnel(team, league);
  const pro = provenance(team, league);
  const findings = [];

  if (per.usage !== null) {
    const direction = per.delta >= 0 ? "above" : "below";
    findings.push({
      heading: "Personnel",
      body: `${per.label ?? per.code} on ${per.usage}% of snaps, `
        + `${Math.abs(per.delta).toFixed(1)} points ${direction} the league mean of `
        + `${per.leagueMean.toFixed(1)}%. ${ordinal(per.leagueRank)} of ${per.measured} measured, `
        + `${ordinal(per.divisionRank)} of ${per.divisionSize} in the ${team.division_label}.`,
      note: per.codeShared === per.total
        ? `Every captured team runs ${per.code} personnel as its primary grouping, so the `
          + `grouping distinguishes nobody. The usage rate is where the variation is.`
        : `${per.codeShared} of ${per.total} teams run ${per.code} as their primary grouping.`,
    });
  }

  if (sch.front) {
    const rivals = sch.division.filter((d) => d.team_id !== team.team_id);
    const same = rivals.filter((d) => d.same).map((d) => d.team_id);
    findings.push({
      heading: "Defensive front",
      body: `${sch.front} base, shared with ${sch.sharedWith} of ${sch.total} captured teams.`,
      note: same.length
        ? `Also ${sch.front} in the division: ${same.join(", ")}.`
        : `The only ${sch.front} front in the ${team.division_label}.`,
    });
  }

  findings.push({
    heading: "Coverage",
    body: `${cov.present} of ${cov.total} declared inputs captured.`,
    note: cov.missing.length === 0
      ? "Every declared input is present."
      : cov.uniform
        ? `Missing: ${cov.missing.join(", ")}. Every other team is missing the same ones, `
          + `so this is a gap in the capture rather than anything about this club.`
        : `Missing: ${cov.missing.join(", ")}.`,
  });

  if (cov.blocks.length) {
    findings.push({
      heading: "Not answerable from this record",
      body: cov.blocks.map((b) => b.blocks).join("; ") + ".",
      note: "Stated rather than estimated. A confident sentence generated from a record "
        + "that says it holds no such data would be worse than an empty section.",
    });
  }

  findings.push({
    heading: "Provenance",
    body: pro.sourceUpdatedAt
      ? `${pro.provider ?? "unknown provider"}, source last updated `
        + `${pro.sourceUpdatedAt.slice(0, 10)} — ${ordinal(pro.recencyRank)} most recent of ${pro.dated}.`
      : `${pro.provider ?? "unknown provider"}; no source date on file.`,
    note: pro.hasCaptureDate
      ? null
      : "That is the provider's date for the page, not a record of when it was read. "
        + "The team-state record carries no capture timestamp, so freshness here is the "
        + "source's, not ours.",
  });

  return { coverage: cov, scheme: sch, personnel: per, provenance: pro, findings };
}

export function ordinal(n) {
  if (!Number.isFinite(n)) return String(n);
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/**
 * Teams grouped into divisions for the master list.
 *
 * Conference then division, both alphabetical, which puts AFC East first and NFC
 * West last -- the order every NFL standings page uses. Teams inside a division
 * are alphabetical by name and NOT by any captured value, because ordering a
 * public list by a measured quantity is a judgement wearing a sort's clothing.
 */
export function byDivision(teams) {
  const groups = new Map();
  for (const team of teams) {
    const label = team.division_label
      ?? [team.conference, team.division].filter(Boolean).join(" ")
      ?? "Unassigned";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(team);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, members]) => ({
      label,
      teams: [...members].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    }));
}
