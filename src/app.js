import { adoptVendoredAliases, resolveTeamAlias } from "./team-aliases.mjs";
import { escapeHtml } from "./escape.js";
import { intakeIssueUrl } from "./contract.js";
import { initIntake } from "./intake.js";

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
  workspace: document.querySelector(".workspace"),
  capture: document.querySelector("#capture-panel"),
  intake: document.querySelector("#intake-panel"),
  captureForm: document.querySelector("#capture-panel"),
  captureName: document.querySelector("#capture-name"),
  captureTeam: document.querySelector("#capture-team"),
  capturePosition: document.querySelector("#capture-position"),
  captureNotes: document.querySelector("#capture-notes"),
  captureHint: document.querySelector("#capture-hint"),
};

async function loadManifests() {
  // The vendored alias map travels with the manifests: club codes must be
  // resolvable before anything is searched or extracted, and pro-scout's copy
  // is the authority for the ones it declares.
  const [teams, players, aliases] = await Promise.all([
    fetch("./data/team-manifest.json").then((r) => r.ok ? r.json() : []),
    fetch("./data/player-manifest.json").then((r) => r.ok ? r.json() : []),
    fetch("./contracts/pro-scout/team-aliases.json")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`responded ${r.status}`)))
      .catch((error) => {
        console.error("Team alias map load failed; the codes it declares will not resolve", error);
        return null;
      }),
  ]);
  if (aliases) adoptVendoredAliases(aliases);
  state.manifests.teams = Array.isArray(teams) ? teams : teams.teams ?? [];
  state.manifests.players = Array.isArray(players) ? players : players.players ?? [];
}

function getEntities() {
  const entities = state.manifests[state.view] ?? [];
  const q = state.query.trim().toLowerCase();
  if (!q) return entities;

  const aliasedTeamId = resolveTeamAlias(q);
  if (state.view === "teams" && aliasedTeamId) {
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

  // Teams and Players browse the manifest; Capture and Intake replace the
  // browser entirely, so the sidebar and its empty state go with it.
  const browsing = view === "teams" || view === "players";
  els.sidebar.hidden = !browsing;
  els.workspace.classList.toggle("is-solo", !browsing);
  els.capture.hidden = view !== "capture";
  els.intake.hidden = view !== "intake";
  els.content.hidden = true;
  els.empty.hidden = !browsing;
  if (browsing) renderList();
}

// ------------------------------------------------------------- intake ---
// One player at a time. The canvas handles batches; both routes build the same
// prefilled issue, so the URL is built in one place.

els.captureForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.captureName.value.trim();
  if (!name) {
    els.captureName.focus();
    return;
  }
  const url = intakeIssueUrl({
    player_name: name,
    team_hint: els.captureTeam.value.trim(),
    position_hint: els.capturePosition.value.trim(),
    notes: els.captureNotes.value.trim(),
  });
  const opened = window.open(url, "_blank", "noopener");
  els.captureHint.textContent = opened
    ? "Intake request opened on GitHub. Submit it there to queue the ingest."
    : "Popup blocked. Open the request manually: " + url;
});

els.toggleButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
els.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderList();
});

loadManifests()
  .catch((error) => console.error("Manifest load failed", error))
  .finally(() => {
    // The canvas resolves names against the same manifests the browser lists,
    // so it is wired only once they have settled. If the load failed the index
    // is empty and every name becomes an upstream resolution request, which is
    // the correct answer with no index to check against.
    initIntake(state.manifests);
    setView("teams");
  });
