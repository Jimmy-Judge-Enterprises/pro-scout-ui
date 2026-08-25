import { resolveTeamAlias } from "./team-aliases.mjs";
import { filterByPresence, playerRow } from "./presence.mjs";
import { analyseTeam, byDivision } from "./team-analysis.mjs";
import { escapeHtml } from "./escape.js";
import { intakeIssueUrl } from "./contract.js";
import { initIntake } from "./intake.js";

const state = {
  view: "teams",
  selectedId: null,
  query: "",
  // Which half of the player manifest to show. Defaults to what pro-scout
  // actually holds: "available" is a queue to work through, not the roster.
  presence: "held",
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
  detailPanel: document.querySelector(".detail-panel"),
  presenceFilter: document.querySelector("#presence-filter"),
  presenceButtons: [...document.querySelectorAll("[data-presence]")],
  tablePanel: document.querySelector("#player-table-panel"),
  tableTitle: document.querySelector("#player-table-title"),
  tableLede: document.querySelector("#player-table-lede"),
  tableBody: document.querySelector("#player-table-body"),
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
  let entities = state.manifests[state.view] ?? [];

  // Presence narrows before the query does, so the count beside the search box
  // reports matches within the chosen half rather than across the whole file.
  if (state.view === "players") {
    entities = filterByPresence(entities, state.presence);
  }

  const q = state.query.trim().toLowerCase();
  if (!q) return entities;

  // Team aliasing: "arizona", "cards", "az" etc. all mean the canonical
  // team_id used in the manifest (e.g. "ARI"). Resolved once per query, not
  // per entity, then matched directly against team_id -- this augments the
  // existing whole-record substring search below rather than replacing it,
  // so non-team queries are unaffected.
  //
  // Deliberately not restricted to the teams view. Player records carry team_id
  // too, so "houston" in the player view finds the Texans' players, which is how
  // someone actually looks for a player whose name they are unsure of. A query
  // that is not a team alias resolves to null and never reaches this branch.
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

// The read-only table. Every column is a public NFL fact; nothing here ranks,
// scores or orders by league judgement, because WHICH players appear and in what
// order is itself information on a public page. Sort is the manifest's own --
// alphabetical for available rows, capture order for held ones.
const PRESENCE_COPY = {
  held: ["In pro-scout", "Players with a captured record."],
  available: ["Available to add", "Known to the identity index and not yet captured. Nothing here is persisted; the list is derived each build."],
  all: ["All players", "Captured records and addable players together."],
};

function renderPlayerTable(entities) {
  const [title, lede] = PRESENCE_COPY[state.presence] ?? PRESENCE_COPY.held;
  els.tableTitle.textContent = title;
  els.tableLede.textContent = `${entities.length} player${entities.length === 1 ? "" : "s"}. ${lede}`;
  els.tableBody.innerHTML = "";

  for (const item of entities) {
    const cells = playerRow(item);
    const row = document.createElement("tr");
    row.className = "player-row";
    row.innerHTML = `
      <th scope="row" class="player-name">${escapeHtml(cells.name)}</th>
      <td>${escapeHtml(cells.position)}</td>
      <td>${escapeHtml(cells.team)}${cells.moved
        ? ' <span class="moved-flag" title="Changed club since his last played season">moved</span>'
        : ""}</td>
      <td class="numeric">${cells.lastPlayed ? escapeHtml(cells.lastPlayed) : "&mdash;"}</td>
      <td>${cells.hasCapture
        ? escapeHtml(freshnessLabel(item.captured_at))
        : '<span class="presence-tag">not captured</span>'}</td>
    `;
    row.addEventListener("click", () => selectEntity(item));
    els.tableBody.appendChild(row);
  }
}

function renderList() {
  const entities = getEntities();
  if (state.view === "players") renderPlayerTable(entities);
  els.listTitle.textContent = state.view === "teams" ? "Teams" : "Players";
  els.count.textContent = String(entities.length);
  els.search.placeholder = state.view === "teams" ? "Search teams" : "Search players";
  els.list.innerHTML = "";

  // Teams are grouped into their divisions, which is how anyone looking for a club
  // actually looks for one -- nobody scans an alphabetical list of 32 to find the
  // AFC East. Players stay flat: 1,159 rows in eight groups would be eight long
  // lists rather than a navigable index.
  const groups = state.view === "teams"
    ? byDivision(entities)
    : [{ label: null, teams: entities }];

  for (const group of groups) {
    if (group.label) {
      const heading = document.createElement("div");
      heading.className = "division-heading";
      heading.textContent = group.label;
      els.list.appendChild(heading);
    }
    for (const item of group.teams) {
      const id = entityId(item);
      const button = document.createElement("button");
      button.className = `entity-row${state.selectedId === id ? " is-selected" : ""}`;
      button.type = "button";
      // Teams have no capture timestamp, so their dot reads the provider's own
      // source date instead. Passing captured_at would paint all 32 grey and say
      // nothing, when six distinct source dates are on file.
      const dotAt = state.view === "teams" ? (item.source_updated_at ?? null) : item.captured_at;
      button.innerHTML = `
        <span class="status-dot ${freshness(dotAt)}" aria-hidden="true"></span>
        <span>${escapeHtml(entityLabel(item))}</span>
        <span class="entity-code">${escapeHtml(entityCode(item))}</span>
      `;
      button.addEventListener("click", () => selectEntity(item));
      els.list.appendChild(button);
    }
  }

  if (!entities.length) {
    els.list.innerHTML = '<div class="card">No manifest records available.</div>';
  }
}

function selectEntity(item) {
  state.selectedId = entityId(item);
  if (els.tablePanel) els.tablePanel.hidden = true;
  renderList();
  renderDetail(item);
  showDetailFromTop();
}

// Two sections, labelled, and never interleaved.
//
// The FACT half is what the manifest carries: captured, provenanced, and shown
// exactly as stored. The ANALYSIS half is computed here from those facts every
// time the panel draws, and is stored nowhere.
//
// They are kept visually apart on purpose. This repository's whole discipline is
// that an observation and a judgement about it are different kinds of thing, and
// a console that renders "3-4 base" beside "shared with 21 of 32" in the same
// card teaches the reader that both arrived the same way. One is on file. The
// other was worked out a moment ago and would change if another team were
// recaptured.
function renderTeamRecord(item) {
  const league = state.manifests.teams ?? [];
  const analysis = analyseTeam(item, league);

  const staff = card("Staff", {
    "General manager": item.general_manager,
    "Head coach": item.head_coach,
    "Offensive coordinator": item.offensive_coordinator,
    "Defensive coordinator": item.defensive_coordinator,
    "Special teams": item.special_teams_coordinator,
  });

  const scheme = card("Scheme and personnel", {
    "Base front": item.base_front,
    "Primary personnel": item.personnel_code
      ? `${item.personnel_code}${item.personnel_label ? ` — ${item.personnel_label}` : ""}`
      : null,
    "Usage": Number.isFinite(item.personnel_usage_pct) ? `${item.personnel_usage_pct}%` : null,
    "Advanced rates": item.advanced_rates_status,
    "Red zone / goal line": item.red_zone_status,
  });

  const provenance = card("Provenance", {
    "Capture status": item.capture_status,
    "Depth chart": item.depth_chart_provider,
    "Source updated": item.source_updated_at ?? "no source date on file",
    // Not "unknown": the record genuinely carries no capture timestamp, and
    // saying so is different from failing to find one.
    "Captured": item.captured_at ?? "the record carries no capture time",
    "Source": item.source_provider,
    "Record URI": item.record_uri,
  });

  const record = card("Record", {
    "Team ID": item.team_id,
    "Division": item.division_label ?? [item.conference, item.division].filter(Boolean).join(" "),
    "Season": item.season,
    "Contract": item.contract_version,
    "Snapshot": item.snapshot_id,
  });

  const findings = analysis.findings.map((finding) => `
    <div class="finding">
      <div class="finding-heading">${escapeHtml(finding.heading)}</div>
      <p class="finding-body">${escapeHtml(finding.body)}</p>
      ${finding.note ? `<p class="finding-note">${escapeHtml(finding.note)}</p>` : ""}
    </div>
  `).join("");

  return `
    <header class="record-header">
      <div>
        <div class="record-kicker">NFL Team State</div>
        <h2 class="record-title">${escapeHtml(entityLabel(item))}</h2>
        <p class="record-subtitle">${escapeHtml(item.team_id ?? "")} · ${escapeHtml(item.division_label ?? "")} · ${escapeHtml(String(item.season ?? ""))}</p>
      </div>
      <div class="status-pill ${escapeHtml(item.capture_color ?? "")}">${escapeHtml(item.capture_status ?? "unknown")}</div>
    </header>

    <section class="pane pane-fact">
      <div class="pane-banner">
        <span class="pane-label">Facts</span>
        <span class="pane-caption">cached — as captured, from the team-state record</span>
      </div>
      <div class="section-grid">${record}${staff}${scheme}${provenance}</div>
    </section>

    <section class="pane pane-analysis">
      <div class="pane-banner">
        <span class="pane-label">Analysis</span>
        <span class="pane-caption">generated — derived from the facts above at render time, stored nowhere</span>
      </div>
      <div class="findings">${findings}</div>
    </section>
  `;
}

// A newly chosen record starts at its own beginning.
//
// Two scrollers to answer for, because the layout has two shapes. Above the
// stacking breakpoint the detail pane scrolls itself, so its scrollTop is what
// stranded the reader. Below it the pane is not a scroller at all and the page is,
// so resetting only the pane would fix the wide layout and leave the narrow one
// exactly as it was. Both are reset; whichever is not scrolling is already 0 and
// the assignment costs nothing.
function showDetailFromTop() {
  if (els.detailPanel) els.detailPanel.scrollTop = 0;
  // Not smooth: this is a jump to a different record, not travel within one, and
  // animating it makes the panel look like it is still showing the last one.
  window.scrollTo(0, 0);
}

function renderDetail(item) {
  els.empty.hidden = true;
  els.content.hidden = false;

  if (state.view === "teams") {
    els.content.innerHTML = renderTeamRecord(item);
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

  // The players view opens on the table rather than an empty panel: the whole
  // point of it is to be readable without choosing anything first.
  const table = view === "players";
  els.presenceFilter.hidden = !table;
  els.tablePanel.hidden = !table;
  els.empty.hidden = !browsing || table;
  if (browsing) renderList();
  showDetailFromTop();
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

els.presenceButtons.forEach((button) => button.addEventListener("click", () => {
  state.presence = button.dataset.presence;
  state.selectedId = null;
  els.presenceButtons.forEach((other) => {
    const active = other === button;
    other.classList.toggle("is-active", active);
    other.setAttribute("aria-pressed", String(active));
  });
  els.content.hidden = true;
  els.tablePanel.hidden = false;
  renderList();
  showDetailFromTop();
}));

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
