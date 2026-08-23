import { resolveTeamAlias } from "./team-aliases.mjs";

const state = {
  view: "teams",
  selectedId: null,
  query: "",
  manifests: { teams: [], players: [] },
};

const els = {
  listTitle: document.querySelector("#list-title"),
  count: document.querySelector("#entity-count"),
  search: document.querySelector("#entity-search"),
  list: document.querySelector("#entity-list"),
  empty: document.querySelector("#detail-empty"),
  content: document.querySelector("#detail-content"),
  toggleButtons: [...document.querySelectorAll("[data-view]")],
  sidebar: document.querySelector(".sidebar"),
  capture: document.querySelector("#capture-panel"),
  captureForm: document.querySelector("#capture-panel"),
  captureName: document.querySelector("#capture-name"),
  captureTeam: document.querySelector("#capture-team"),
  capturePosition: document.querySelector("#capture-position"),
  captureNotes: document.querySelector("#capture-notes"),
  captureHint: document.querySelector("#capture-hint"),
};

async function loadManifests() {
  const [teams, players] = await Promise.all([
    fetch("./data/team-manifest.json").then((r) => r.ok ? r.json() : []),
    fetch("./data/player-manifest.json").then((r) => r.ok ? r.json() : []),
  ]);
  state.manifests.teams = Array.isArray(teams) ? teams : teams.teams ?? [];
  state.manifests.players = Array.isArray(players) ? players : players.players ?? [];
}

function getEntities() {
  const entities = state.manifests[state.view] ?? [];
  const q = state.query.trim().toLowerCase();
  if (!q) return entities;

  // Team aliasing: "arizona", "cards", "az" etc. all mean the canonical
  // team_id used in the manifest (e.g. "ARI"). Resolved once per query, not
  // per entity, then matched directly against team_id -- this augments the
  // existing whole-record substring search below rather than replacing it,
  // so non-team queries are unaffected.
  const aliasedTeamId = resolveTeamAlias(q);
  if (aliasedTeamId) {
    return entities.filter((item) => (item.team_id ?? "").toUpperCase() === aliasedTeamId);
  }

  return entities.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
}

function entityId(item) {
  return state.view === "teams" ? item.team_id : item.gsis_id;
}

function entityLabel(item) {
  return state.view === "teams" ? (item.name ?? item.team_name ?? item.team_id) : (item.name ?? item.full_name ?? item.gsis_id);
}

function entityCode(item) {
  return state.view === "teams" ? item.team_id : (item.position ?? item.team_id ?? "");
}

// Freshness is derived at render time, never baked into the manifest: the
// manifest carries captured_at as fact, and a record does not become stale
// because a build ran. A record with no capture date is "unavailable", not
// assumed fresh -- missing evidence stays missing.
const DAY = 86400000;
function freshness(capturedAt) {
  if (!capturedAt) return "unavailable";
  const at = Date.parse(capturedAt);
  if (Number.isNaN(at)) return "unavailable";
  const age = (Date.now() - at) / DAY;
  if (age <= 14) return "recent";
  if (age <= 60) return "stale";
  return "unavailable";
}

function freshnessLabel(capturedAt) {
  return { recent: "Recent", stale: "Stale", unavailable: "No capture date" }[freshness(capturedAt)];
}

function renderList() {
  const entities = getEntities();
  els.listTitle.textContent = state.view === "teams" ? "Teams" : "Players";
  els.count.textContent = String(entities.length);
  els.search.placeholder = state.view === "teams" ? "Search teams" : "Search players";
  els.list.innerHTML = "";

  for (const item of entities) {
    const id = entityId(item);
    const button = document.createElement("button");
    button.className = `entity-row${state.selectedId === id ? " is-selected" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span class="status-dot ${freshness(item.captured_at)}" aria-hidden="true"></span>
      <span>${escapeHtml(entityLabel(item))}</span>
      <span class="entity-code">${escapeHtml(entityCode(item))}</span>
    `;
    button.addEventListener("click", () => selectEntity(item));
    els.list.appendChild(button);
  }

  if (!entities.length) {
    els.list.innerHTML = '<div class="card">No manifest records available.</div>';
  }
}

function selectEntity(item) {
  state.selectedId = entityId(item);
  renderList();
  renderDetail(item);
}

function renderDetail(item) {
  els.empty.hidden = true;
  els.content.hidden = false;

  if (state.view === "teams") {
    els.content.innerHTML = `
      <header class="record-header">
        <div>
          <div class="record-kicker">NFL Team State</div>
          <h2 class="record-title">${escapeHtml(entityLabel(item))}</h2>
          <p class="record-subtitle">${escapeHtml(item.team_id ?? "")} · ${escapeHtml(String(item.season ?? ""))}</p>
        </div>
        <div class="status-pill">${escapeHtml(item.capture_status ?? "unknown")}</div>
      </header>
      <div class="section-grid">
        ${card("Record", {
          "Team ID": item.team_id,
          "Conference": [item.conference, item.division].filter(Boolean).join(" "),
          "Season": item.season,
          "Contract": item.contract_version,
          "Snapshot": item.snapshot_id,
        })}
        ${card("Staff", {
          "Head coach": item.head_coach,
          "Offensive coordinator": item.offensive_coordinator,
        })}
        ${card("Provenance", {
          "Capture status": item.capture_status,
          "Captured": item.captured_at ?? "not recorded upstream",
          "Freshness": freshnessLabel(item.captured_at),
          "Source": item.source_provider,
          "Record URI": item.record_uri,
        })}
      </div>
    `;
  } else {
    els.content.innerHTML = `
      <header class="record-header">
        <div>
          <div class="record-kicker">Player Evaluation</div>
          <h2 class="record-title">${escapeHtml(entityLabel(item))}</h2>
          <p class="record-subtitle">${escapeHtml(item.position ?? "")} · ${escapeHtml(item.team_id ?? "")} · ${escapeHtml(item.gsis_id ?? "")}</p>
        </div>
        <div class="status-pill">${escapeHtml(item.capture_status ?? "unknown")}</div>
      </header>
      <div class="section-grid">
        ${card("Identity", {
          "GSIS ID": item.gsis_id,
          "Position": item.position,
          "NFL team": item.team_id,
          "Name source": item.name_resolved ? "resolved by GSIS from nflverse" : "as captured",
        })}
        ${card("Capture", {
          "Capture status": item.capture_status,
          "Captured": item.captured_at ?? "not recorded upstream",
          "Freshness": freshnessLabel(item.captured_at),
          "Contract": item.contract_version,
          "Record URI": item.record_uri,
        })}
      </div>
    `;
  }
}

function card(title, values) {
  const rows = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  return `<section class="card"><h3>${escapeHtml(title)}</h3><dl class="definition-list">${rows || "<dd>No data</dd>"}</dl></section>`;
}

function setView(view) {
  state.view = view;
  state.selectedId = null;
  state.query = "";
  els.search.value = "";
  els.toggleButtons.forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const capturing = view === "capture";
  els.sidebar.hidden = capturing;
  els.capture.hidden = !capturing;
  els.content.hidden = true;
  els.empty.hidden = capturing;
  if (!capturing) renderList();
}

// ------------------------------------------------------------- intake ---
// The public page never holds a token and never calls an API. It builds a
// prefilled GitHub issue URL against the private repo; GitHub authenticates
// the submitter with their own session and performs the write.
const INTAKE_REPO = "Jimmy-Judge-Enterprises/pro-scout";
const INTAKE_TEMPLATE = "player-intake.yml";

function intakeUrl({ name, team, position, notes }) {
  const params = new URLSearchParams({ template: INTAKE_TEMPLATE, title: `[intake] ${name}` });
  params.set("player_name", name);
  if (team) params.set("team_hint", team);
  if (position) params.set("position_hint", position);
  if (notes) params.set("notes", notes);
  return `https://github.com/${INTAKE_REPO}/issues/new?${params}`;
}

els.captureForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.captureName.value.trim();
  if (!name) {
    els.captureName.focus();
    return;
  }
  const url = intakeUrl({
    name,
    team: els.captureTeam.value.trim(),
    position: els.capturePosition.value.trim(),
    notes: els.captureNotes.value.trim(),
  });
  const opened = window.open(url, "_blank", "noopener");
  els.captureHint.textContent = opened
    ? "Intake request opened on GitHub. Submit it there to queue the ingest."
    : "Popup blocked. Open the request manually: " + url;
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

els.toggleButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
els.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderList();
});

loadManifests()
  .catch((error) => console.error("Manifest load failed", error))
  .finally(() => setView("teams"));
