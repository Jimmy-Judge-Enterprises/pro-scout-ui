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
      <span class="status-dot ${item.status ?? ""}" aria-hidden="true"></span>
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
        <div class="status-pill">${escapeHtml(item.status ?? "unknown")}</div>
      </header>
      <div class="section-grid">
        ${card("Record", {
          "Team ID": item.team_id,
          "Season": item.season,
          "Contract": item.contract_version,
          "Snapshot": item.snapshot_id,
        })}
        ${card("Provenance", {
          "Captured": item.captured_at,
          "Effective": item.effective_at,
          "Source status": item.status,
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
        <div class="status-pill">${escapeHtml(item.status ?? "available")}</div>
      </header>
      <div class="section-grid">
        ${card("Identity", {
          "GSIS ID": item.gsis_id,
          "Position": item.position,
          "NFL team": item.team_id,
          "Record URI": item.record_uri,
        })}
        ${card("Evaluation Inputs", {
          "Facts snapshot": item.facts_snapshot_id,
          "Team snapshot": item.team_snapshot_id,
          "Captured": item.captured_at,
          "Contract": item.contract_version,
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
  els.content.hidden = true;
  els.empty.hidden = false;
  renderList();
}

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
