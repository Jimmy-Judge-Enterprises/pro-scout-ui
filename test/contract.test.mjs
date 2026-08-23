// Bare-node test of the boundary contract. No dependencies and no test
// framework, matching how the upstream repo runs its own validation in CI:
//   node test/contract.test.mjs
//
// No identity here is invented. Every gsis_id and name is read from the repo's
// own player manifest, and the capture shapes around them carry only fields a
// real capture carries. A test that fabricated a player would be the exact
// contamination the module under test exists to prevent.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildBundle, buildRequestsDocument, sourceIdFor } from "../src/contract.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const schemas = {
  playerObservation: read("contracts/gameplan/player_observation.schema.json"),
  batchManifest: read("contracts/gameplan/batch_manifest.schema.json"),
  identityReferenceFacts: read("contracts/gameplan/facts/identity_reference.schema.json"),
  depthChartFacts: read("contracts/gameplan/facts/depth_chart.schema.json"),
};

const manifest = read("data/player-manifest.json");
const [alpha, beta] = manifest.players;
const digest = async (text) => createHash("sha256").update(text).digest("hex");

const KNOWN_AT = "2026-08-23T12:00:00Z";
const BATCH_ID = "test-batch";

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
}
const codes = (bundle) => bundle.blockers.map((entry) => entry.code);

function row(player, overrides = {}) {
  return {
    id: `row-${player.gsis_id}`,
    captured: player.name,
    status: "resolved",
    match: player,
    hints: { position: player.position, team: null, teamBasis: null },
    sourceIds: ["src-1"],
    occurrences: 1,
    candidates: [],
    ...overrides,
  };
}
function source(declared, overrides = {}) {
  return { id: "src-1", label: "capture", declared, ...overrides };
}

const complete = {
  provider: "PlayerProfiler",
  source_type: "depth_chart_page",
  url: "https://www.playerprofiler.com/depth-charts/kansas-city-chiefs/",
  capture_status: "partial",
  observed_at: "2026-08-14T03:45:00+02:00",
  checked_at: "2026-08-14T03:45:00+02:00",
  team: alpha.team_id,
};
const bundle = (rows, sources) =>
  buildBundle({ rows, sources, schemas, knownAt: KNOWN_AT, batchId: BATCH_ID, digest });

// --- what a complete capture produces --------------------------------------
{
  const out = await bundle([row(alpha)], [source(complete)]);
  check("complete capture emits one observation", out.observations.length === 1, JSON.stringify(out.blockers));
  check("no blockers", out.blockers.length === 0, JSON.stringify(out.blockers));
  const observation = out.observations[0];
  check("carries the canonical id", observation?.gsis_id === alpha.gsis_id);
  check("source id derives from the declared provider", observation?.source_id === "playerprofiler.depth_chart_page");
  check("observed_at is the source clock", observation?.observed_at === complete.observed_at);
  check("known_at is the batch clock", observation?.known_at === KNOWN_AT);
  check("retrieved_at is kept distinct", observation?.retrieved_at === complete.checked_at);
  check("no depth stated means identity_reference", observation?.fact_domain === "identity_reference");
  check("manifest is emitted", out.manifest !== null);
  check("manifest counts the lines", out.manifest?.record_count === 1);
  check("data file is jsonl", /\.jsonl$/.test(out.manifest?.data_file ?? ""));
  check("sha256 covers the jsonl", out.manifest?.sha256 === (await digest(out.jsonl)));
  check("jsonl is one object per line", out.jsonl.trim().split("\n").length === 1);
}

// --- the clocks may not stand in for one another ---------------------------
{
  const out = await bundle([row(alpha)], [source({ ...complete, observed_at: null })]);
  check("null observation date blocks the line", out.observations.length === 0);
  check("and names the clock", codes(out).includes("observed_at_unknown"), JSON.stringify(codes(out)));
  check("and ships no manifest", out.manifest === null);
}
{
  const out = await bundle([row(alpha)], [source({ ...complete, observed_at: "2026-08-14" })]);
  check("a bare date is not a date-time", codes(out).includes("observed_at_not_datetime"), JSON.stringify(codes(out)));
}

// --- an unregistered source cannot carry an observation --------------------
{
  const out = await bundle([row(alpha)], [source({ ...complete, provider: null })]);
  check("no provider means no source id", sourceIdFor(source({ provider: null })) === null);
  check("and the line is blocked", codes(out).includes("source_unregistered"), JSON.stringify(codes(out)));
}

// --- identity questions never enter the observation feed -------------------
{
  const unresolved = {
    id: "row-unresolved", captured: alpha.name, status: "pending", match: null,
    hints: { position: "RB", team: alpha.team_id, teamBasis: "document" },
    sourceIds: ["src-1"], occurrences: 2, candidates: [],
  };
  const out = await bundle([unresolved], [source(complete)]);
  check("unresolved yields no observation", out.observations.length === 0);
  check("unresolved yields a request", out.requests.length === 1);
  check("the request carries the hint basis", out.requests[0].team_hint_basis === "document");
  check("the request states it is not an assertion", /not an assertion/.test(out.requests[0].acknowledgement));
  const document = buildRequestsDocument({ requests: out.requests, batchId: BATCH_ID, knownAt: KNOWN_AT });
  check("requests document counts its requests", document.request_count === 1);
}

// --- a document-scope team is never asserted about a player ----------------
{
  const inherited = row(alpha, { hints: { position: "RB", team: "KC", teamBasis: "document" } });
  const out = await bundle([inherited], [source(complete)]);
  check("inherited team stays out of identity facts", out.observations[0]?.facts.team === undefined,
    JSON.stringify(out.observations[0]?.facts));
  const observed = row(alpha, { hints: { position: "RB", team: "KC", teamBasis: "observed" } });
  const seen = await bundle([observed], [source(complete)]);
  check("observed team is carried", seen.observations[0]?.facts.team === "KC");
}

// --- depth becomes a depth-chart fact only when the source stated one ------
{
  const charted = row(alpha, {
    hints: { position: "RB", team: null, teamBasis: null },
    source_fields: { depth: 1, role: "Satellite", status: null, source_basis: "playerprofiler_editorial" },
  });
  const out = await bundle([charted], [source(complete)]);
  check("stated depth routes to depth_chart", out.observations[0]?.fact_domain === "depth_chart",
    JSON.stringify(out.blockers));
  check("depth_order is the source order", out.observations[0]?.facts.depth_order === 1);
  check("the source role label is preserved", out.observations[0]?.facts.role === "Satellite");
  check("the chart's team is the fact's team", out.observations[0]?.facts.team === complete.team);

  const unstated = row(alpha, {
    hints: { position: "RB", team: null, teamBasis: null },
    source_fields: { depth: null, role: "Satellite", status: null },
  });
  const fallback = await bundle([unstated], [source(complete)]);
  check("a null depth is not a depth fact", fallback.observations[0]?.fact_domain === "identity_reference");
}

// --- one manifest describes one source -------------------------------------
{
  const second = source({ ...complete, provider: "Ourlads", source_type: "depth_chart_page" },
    { id: "src-2", label: "second capture" });
  const out = await bundle(
    [row(alpha), row(beta, { id: "row-b", sourceIds: ["src-2"] })],
    [source(complete), second],
  );
  check("a split batch is refused", out.manifest === null);
  check("and says why", codes(out).includes("batch_spans_sources"), JSON.stringify(codes(out)));
}

console.log(failures === 0 ? "contract: all checks passed" : `contract: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
