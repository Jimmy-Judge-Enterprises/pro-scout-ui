// ------------------------------------------------------------ anatomy panel ---
// The rookie profile: hero card, athletic gauges, college production.
//
// A rookie has no NFL history, so every panel that reads production is empty for
// him. This is the only evidence that exists before he has played a snap.
//
// WHY THE GAUGE BARS ARE COMPUTED AND NOT SUPPLIED
//   The design this came from filled its bars from a percentile if one was passed
//   and otherwise from a literal: 65%, 78%, 70%, 50%. Its own comment called them
//   "mock visual percentages based on realistic ranges".
//
//   A filled bar is a claim about where a man sits among his peers. Invented, it
//   is the most confident-looking thing on the page and it means nothing. So the
//   percentile is computed here, at render time, against the players actually on
//   the page -- and where it cannot be computed there is no bar at all, only the
//   value and a note saying the cohort is too small to place him in.
//
//   Nothing is stored. A stored percentile freezes a comparison that moves
//   whenever another player is captured, which is the same reason freshness and
//   the team analysis are derived rather than published.
//
// WHY SOME METRICS INVERT
//   A forty-yard dash is better when it is smaller. Ranking every measure as
//   "higher is better" would have put the slowest man in the class at the top of
//   the speed bar. The direction is declared per measure below.

import { ordinal } from "./team-analysis.mjs";

const MIN_COHORT = 8;

// Each gauge: where the value lives, and which way is good. `lowerIsBetter` is
// not decoration -- it decides the direction of every bar drawn from it.
export const GAUGES = Object.freeze([
  { key: "forty_yard_dash", label: "40-yard dash", unit: "s", lowerIsBetter: true, tone: "cyan" },
  { key: "ten_yard_split", label: "10-yard split", unit: "s", lowerIsBetter: true, tone: "cyan" },
  { key: "ras", label: "RAS", unit: "", lowerIsBetter: false, tone: "green" },
  { key: "measures.speed_score", label: "Speed score", unit: "", lowerIsBetter: false, tone: "green" },
  { key: "measures.burst_score", label: "Burst score", unit: "", lowerIsBetter: false, tone: "amber" },
  { key: "measures.bmi", label: "BMI", unit: "", lowerIsBetter: false, tone: "amber" },
]);

// College production, shown as plain tiles. No bar: these are counting stats and
// rate stats from different colleges against different schedules, and a bar would
// imply a comparability the numbers do not have.
export const PRODUCTION = Object.freeze([
  { key: "measures.peak_yardage", label: "Peak yardage" },
  { key: "measures.peak_rec", label: "Peak receptions" },
  { key: "measures.career_yprr", label: "Career YPRR" },
  { key: "measures.peak_first_3_yprr", label: "Peak YPRR, first 3" },
  { key: "measures.college_ypa", label: "College YPA" },
  { key: "measures.ypa_dom", label: "YPA dominator" },
  { key: "measures.wdom", label: "WDOM" },
  { key: "measures.composite_bdr", label: "Composite BDR" },
  { key: "measures.career_bdr", label: "Career BDR" },
  { key: "measures.college_level", label: "College level" },
]);

export function dig(profile, path) {
  if (!profile) return null;
  const value = path.split(".").reduce((node, part) => (node == null ? null : node[part]), profile);
  return value === undefined ? null : value;
}

const numeric = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Where `value` sits among `cohort`, 0-100, or null when it cannot be said.
 *
 * Null rather than a default whenever the cohort is too small to mean anything.
 * A percentile drawn from three players is a bar the reader has no way to
 * discount.
 */
export function percentileOf(value, cohort, { lowerIsBetter = false } = {}) {
  const target = numeric(value);
  const values = (cohort ?? []).map(numeric).filter((v) => v !== null);
  if (target === null || values.length < MIN_COHORT) return null;
  const better = values.filter((v) => (lowerIsBetter ? v < target : v > target)).length;
  const equal = values.filter((v) => v === target).length;
  // Ties share the midpoint of the band they occupy, so two identical times do
  // not straddle a boundary and read as meaningfully different.
  //
  // equal/2 and NOT (equal - 1)/2. The cohort excludes the player himself, so
  // subtracting one counted a peer that is not there: a man nobody matched and
  // nobody beat came out at -0.5 of the way down, which rendered as the 103rd
  // percentile. The test caught it on Mike Washington Jr.
  const rank = better + equal / 2;
  const percentile = Math.round(100 - (rank / values.length) * 100);
  return Math.min(100, Math.max(0, percentile));
}

/**
 * The cohort a player is measured against: the same position group, from the
 * same source year, excluding himself.
 *
 * Not the whole page. A receiver's forty means something beside other receivers
 * and nothing beside a running back's, and a class is drafted against its own
 * class.
 */
export function cohortFor(player, players) {
  const profile = player?.anatomy;
  if (!profile) return [];
  return (players ?? [])
    .filter((other) => other?.anatomy
      && other.gsis_id !== player.gsis_id
      && other.anatomy.position_group === profile.position_group
      && other.anatomy.source_year === profile.source_year)
    .map((other) => other.anatomy);
}

export function gaugesFor(player, players) {
  const profile = player?.anatomy;
  if (!profile) return [];
  const cohort = cohortFor(player, players);
  const out = [];
  for (const gauge of GAUGES) {
    const value = numeric(dig(profile, gauge.key));
    if (value === null) continue; // not captured: no tile, rather than an empty one
    const percentile = percentileOf(
      value, cohort.map((c) => dig(c, gauge.key)), { lowerIsBetter: gauge.lowerIsBetter },
    );
    out.push({
      label: gauge.label,
      display: `${value}${gauge.unit}`,
      percentile,
      tone: gauge.tone,
      cohortSize: cohort.length,
      // Said out loud on the tile. A bar with no explanation of what it is a
      // percentile OF is a number the reader has to guess at.
      basis: percentile === null
        ? `too few ${profile.position_group}s captured for ${profile.source_year} to place him`
        : `${ordinal(percentile)} percentile of ${cohort.length + 1} ${profile.position_group}s, ${profile.source_year}`,
    });
  }
  return out;
}

export function productionFor(player) {
  const profile = player?.anatomy;
  if (!profile) return [];
  return PRODUCTION
    .map((tile) => ({ label: tile.label, value: dig(profile, tile.key) }))
    .filter((tile) => tile.value !== null && tile.value !== "");
}

/** The badges across the hero card. Facts only, each labelled with what it is. */
export function heroFor(player) {
  const profile = player?.anatomy;
  if (!profile) return null;
  const badges = [];
  if (profile.draft_status === "DRAFTED" && profile.nfl_draft_round) {
    // Round and OVERALL pick. The workbook counts within the round and this does
    // not; publishing its number here would read a third-rounder as a top-ten pick.
    const pick = profile.nfl_draft_pick ? `.${profile.nfl_draft_pick}` : "";
    badges.push({ label: "Drafted", value: `${profile.nfl_draft_round}${pick}` });
  } else if (profile.draft_status) {
    badges.push({ label: "Entry", value: profile.draft_status });
  }
  if (profile.source_year) badges.push({ label: "Class", value: String(profile.source_year) });
  if (profile.position_group) badges.push({ label: "Group", value: profile.position_group });
  const level = dig(profile, "measures.college_level");
  if (level) badges.push({ label: "College", value: String(level) });
  const declare = dig(profile, "measures.early_declare");
  if (declare === true) badges.push({ label: "Early declare", value: "Yes" });

  return {
    initials: initialsOf(player.name),
    badges,
    ras: numeric(profile.ras),
    // The workbook's own draft notation, kept visible beside the overall pick so
    // the two are never mistaken for the same number.
    sourceSlot: profile.draft_capital_source_value ?? null,
  };
}

export function initialsOf(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "--";
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}
