// -------------------------------------------------------------- contract ---
// Construction of the Gameplan production boundary artifacts, and the rules
// that decide what is allowed to cross it.
//
// The boundary is narrow on purpose. A player_observation requires a canonical
// gsis_id, a registered source_id and a real observed_at clock; nothing may be
// substituted for any of them. So this module's job is mostly refusal: it emits
// only what a capture actually supports, and reports precisely what was missing
// for everything else. It never fills a required field with a default, a
// placeholder, or a value borrowed from a different clock.
//
// Two artifacts leave here:
//   observations -- JSONL of player_observation, resolved identities only
//   requests     -- identity searches for names with no proven identity
// They are never mixed. A name without a gsis_id is a question, not a fact.
//
// Pure by construction: no DOM, no globals, no clock of its own. Everything
// time- or identity-shaped is passed in, so the same code runs under test.

import { validate } from "./vendor/jsonschema.js";

export const PRODUCER_VERSION = "pro-scout-ui/intake-canvas@0.1.0";

const OBSERVATION_SCHEMA_VERSION = "1.2.0";
const MANIFEST_SCHEMA_VERSION = "1.0.0";
export const REQUESTS_SCHEMA_VERSION = "pro-scout-ui.identity-requests.v1";

const GSIS = /^00-[0-9]{7}$/;
// The contract's own date-time format. A bare calendar date does not satisfy it,
// and widening one into a timestamp would assert a precision no source gave.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const ACKNOWLEDGEMENT =
  "This is a request to search for identity, not an assertion that the player exists in the canonical index.";

const slug = (value) => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Gameplan registers sources; it does not accept ad-hoc ones. The id is derived
// from what the capture declares about itself, and a capture that declares no
// provider yields no id -- inventing one would be the contamination this whole
// module exists to prevent.
export function sourceIdFor(source) {
  const declared = source?.declared;
  if (!declared?.provider) return null;
  return [slug(declared.provider), declared.source_type ? slug(declared.source_type) : null]
    .filter(Boolean)
    .join(".");
}

function blocker(row, code, field, message, remedy) {
  return { name: row.captured, row_id: row.id, code, field, message, remedy };
}

// A depth-chart row is only a depth_chart fact if the source actually stated an
// order. depth_order is required and starts at 1, so a null depth is not a
// zero, a one, or an omission to paper over -- it is a different fact domain.
function depthChartFacts(row, source) {
  const fields = row.source_fields ?? {};
  const order = fields.depth;
  if (!Number.isInteger(order) || order < 1 || order > 20) return null;
  const team = source?.declared?.team;
  // Only what the source filed the player under. A position typed into the
  // canvas narrows a search; it is not an observation of a depth chart.
  const group = observed(row, "position");
  if (!team || !group) return null;
  const facts = { team, position_group: group, depth_order: order };
  // Source role labels are preserved verbatim rather than normalised.
  if (typeof fields.role === "string" && fields.role) facts.role = fields.role;
  if (typeof fields.status === "string" && fields.status) facts.roster_status = fields.status;
  return facts;
}

// The fallback domain: what the source said about who this is. The team is
// deliberately absent unless it was observed beside the player. A team named in
// a document header describes the document, not the player's current club, and
// a player can leave the club whose chart still lists him.
// Facts are what a source stated. A hint an analyst supplied to narrow a
// search is not a fact about the player, however well founded, so it never
// reaches this side of the boundary -- it travels on the request instead.
const observed = (row, field) => (row.hints[`${field}Basis`] === "observed" ? row.hints[field] : null);

function identityFacts(row) {
  const facts = { display_name: row.captured };
  const position = observed(row, "position");
  const team = observed(row, "team");
  if (position) facts.position = position;
  if (team) facts.team = team;
  return facts;
}

function buildObservation(row, source, { knownAt, batchId, schemas }) {
  const blockers = [];
  const gsis = row.match?.gsis_id;
  if (!gsis || !GSIS.test(gsis)) {
    blockers.push(blocker(row, "gsis_invalid", "gsis_id",
      "Resolved identity is missing or is not a canonical nflverse id.",
      "Re-resolve this name against the canonical index."));
  }

  const sourceId = sourceIdFor(source);
  if (!sourceId) {
    blockers.push(blocker(row, "source_unregistered", "source_id",
      `The capture "${source?.label ?? "unknown"}" declares no provider, so it has no source id registered with Gameplan.`,
      "Ingest this player from a capture that declares its provider, or register the source upstream first."));
  }

  const declared = source?.declared ?? {};
  const observedAt = declared.observed_at;
  if (!observedAt) {
    blockers.push(blocker(row, "observed_at_unknown", "observed_at",
      "The capture records when it was checked, not when the source asserted the information.",
      "Set source_observation_date on the capture. observed_at, known_at and retrieved_at are distinct clocks and one may not stand in for another."));
  } else if (!DATE_TIME.test(observedAt)) {
    blockers.push(blocker(row, "observed_at_not_datetime", "observed_at",
      `The capture states the observation date as "${observedAt}", which carries no time of day.`,
      "Record source_observation_date as a full date-time; padding it to midnight would assert a precision the source never gave."));
  }

  if (blockers.length) return { observation: null, blockers };

  const depth = depthChartFacts(row, source);
  const observation = {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    record_type: "player_observation",
    gsis_id: gsis,
    source_id: sourceId,
    observed_at: observedAt,
    // When this batch was assembled: the earliest moment this side of the
    // boundary held the observation.
    known_at: knownAt,
    fact_domain: depth ? "depth_chart" : "identity_reference",
    facts: depth ?? identityFacts(row),
    // Diagnostic only. These never establish or override the gsis_id above.
    source_identity: { name: row.captured, ...(observed(row, "position") ? { position: observed(row, "position") } : {}) },
    ingestion: { batch_id: batchId, adapter_version: PRODUCER_VERSION },
  };
  if (DATE_TIME.test(declared.checked_at ?? "")) observation.retrieved_at = declared.checked_at;
  if (declared.url) observation.source_url = declared.url;

  const factSchema = depth ? schemas.depthChartFacts : schemas.identityReferenceFacts;
  for (const error of validate(observation.facts, factSchema)) {
    blockers.push(blocker(row, "facts_invalid", `facts${error.path}`, error.message,
      "The source value does not satisfy its fact domain contract."));
  }
  for (const error of validate(observation, schemas.playerObservation)) {
    blockers.push(blocker(row, "observation_invalid", error.path || "(root)", error.message,
      "The observation does not satisfy the Gameplan provider contract."));
  }

  return blockers.length ? { observation: null, blockers } : { observation, blockers };
}

// An unresolved name leaves as a search request carrying only what the source
// said. Hints discriminate between candidates; they never establish identity,
// which is why the basis of a team hint travels with it.
function buildRequest(row, source, batchId) {
  const request = {
    // The join key. A search that quotes this back -- the ledger's request
    // object accepts additional properties -- makes an exported batch
    // reconcilable against the searches that eventually ran for it.
    request_id: row.request_id,
    batch_id: batchId,
    player_name: row.captured,
    team_hint: row.hints.team ?? null,
    // The spelling the source used, not the code this canvas normalised it to.
    // Gameplan's adapters keep `source_identity.team_as_written` for the same
    // reason: the normalisation is an inference made here, and a search that
    // only ever sees the inference cannot check it against the document.
    team_hint_as_written: row.hints.teamAsWritten ?? null,
    team_hint_basis: row.hints.teamBasis ?? null,
    position_hint: row.hints.position ?? null,
    position_hint_basis: row.hints.positionBasis ?? null,
    notes: row.analyst_note ?? null,
    source_id: sourceIdFor(source),
    source_label: source?.label ?? null,
    occurrences: row.occurrences,
    acknowledgement: ACKNOWLEDGEMENT,
  };
  const role = row.source_fields?.role;
  const basis = row.source_fields?.source_basis;
  if (typeof role === "string" && role) request.source_role = role;
  if (typeof basis === "string" && basis) request.source_basis = basis;
  if (row.status === "review") {
    request.retained_candidates = row.candidates.map((candidate) => ({
      gsis_id: candidate.gsis_id,
      name: candidate.name,
    }));
  }
  // A hint that contradicted the index travels with the request: the search
  // needs to know the disagreement exists, not to have it resolved for it.
  if (row.conflict) request.hint_conflict = row.conflict;
  return request;
}

/**
 * Assemble the boundary artifacts.
 *
 * `digest` is injected rather than reached for, so this module holds no
 * dependency on a runtime crypto API; omit it and sha256 is reported as null,
 * which the manifest contract permits.
 *
 * Returns { manifest, jsonl, observations, requests, blockers, counts }.
 * A null manifest means nothing may cross the boundary yet; blockers say why.
 */
export async function buildBundle({ rows, sources, schemas, knownAt, batchId, digest }) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const observations = [];
  const requests = [];
  const blockers = [];

  for (const row of rows) {
    // A row can be seen in several captures; the one that can register a source
    // is the one that can carry an observation.
    const candidates = row.sourceIds.map((id) => byId.get(id)).filter(Boolean);
    const source = candidates.find((entry) => sourceIdFor(entry)) ?? candidates[0] ?? null;

    if (row.status !== "resolved") {
      requests.push(buildRequest(row, source, batchId));
      continue;
    }
    const built = buildObservation(row, source, { knownAt, batchId, schemas });
    if (built.observation) observations.push(built.observation);
    else blockers.push(...built.blockers);
  }

  const counts = {
    candidates: rows.length,
    observations: observations.length,
    requests: requests.length,
    blocked: new Set(blockers.map((entry) => entry.row_id)).size,
  };

  if (!observations.length) return { manifest: null, jsonl: "", observations, requests, blockers, counts };

  // One manifest carries one source_id. A batch spanning two providers is not a
  // batch the contract can describe, and splitting it silently would misattribute
  // every line in it.
  const sourceIds = [...new Set(observations.map((entry) => entry.source_id))];
  if (sourceIds.length > 1) {
    blockers.push({
      name: null, row_id: null, code: "batch_spans_sources", field: "source_id",
      message: `This batch carries observations from ${sourceIds.length} sources: ${sourceIds.join(", ")}.`,
      remedy: "A batch manifest describes one source. Remove the other captures and export them separately.",
    });
    return { manifest: null, jsonl: "", observations, requests, blockers, counts };
  }

  const jsonl = `${observations.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    batch_id: batchId,
    source_id: sourceIds[0],
    generated_at: knownAt,
    record_count: observations.length,
    data_file: `${batchId}.jsonl`,
    sha256: digest ? await digest(jsonl) : null,
    producer_version: PRODUCER_VERSION,
  };

  for (const error of validate(manifest, schemas.batchManifest)) {
    blockers.push({
      name: null, row_id: null, code: "manifest_invalid", field: error.path || "(root)",
      message: error.message, remedy: "The batch manifest does not satisfy its contract.",
    });
  }

  return blockers.some((entry) => entry.code === "manifest_invalid")
    ? { manifest: null, jsonl: "", observations, requests, blockers, counts }
    : { manifest, jsonl, observations, requests, blockers, counts };
}

export function buildRequestsDocument({ requests, batchId, knownAt }) {
  return {
    schema_version: REQUESTS_SCHEMA_VERSION,
    batch_id: batchId,
    generated_at: knownAt,
    producer_version: PRODUCER_VERSION,
    request_count: requests.length,
    acknowledgement: ACKNOWLEDGEMENT,
    // Where these ids are expected to reappear, so a reader knows how to close
    // the loop without being told out of band.
    reconcile_via: "identity-search-ledger event request.request_id",
    requests,
  };
}

// The upstream intake mechanism is a GitHub issue form; the request fields map
// onto its inputs one for one. The page holds no credentials -- GitHub
// authenticates the submitter with their own session and performs the write.
const INTAKE_REPO = "Jimmy-Judge-Enterprises/pro-scout";
const INTAKE_TEMPLATE = "player-intake.yml";

export function intakeIssueUrl({ player_name, team_hint, position_hint, notes, request_id }) {
  const params = new URLSearchParams({ template: INTAKE_TEMPLATE, title: `[intake] ${player_name}` });
  params.set("player_name", player_name);
  if (team_hint) params.set("team_hint", team_hint);
  if (position_hint) params.set("position_hint", position_hint);
  if (request_id) params.set("request_id", request_id);
  if (notes) params.set("notes", notes);
  return `https://github.com/${INTAKE_REPO}/issues/new?${params}`;
}
