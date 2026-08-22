// ---------------------------------------------------------------- intake ---
// The intake canvas turns whatever an analyst has -- a pasted roster, a saved
// depth chart, a transcript, a screenshot -- into a batch of intake records.
//
// Two rules shape the whole module. The first: identity is never guessed. A
// name either matches the nflverse index carried by the manifests, or it
// leaves as a resolution request with its hints attached, for the upstream
// resolver to settle against nflverse itself. Nothing here mints a GSIS id.
//
// The second: the page holds no credentials and makes no API calls, so work it
// cannot do it does not fake. Text, tables, transcripts and saved pages are
// read here; images, video and URLs are staged as sources and marked for the
// upstream pipeline, where OCR, transcription and fetching actually run.

import { escapeHtml } from "./escape.js";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function norm(value) {
  return String(value ?? "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "A.J. Brown", "AJ Brown" and "a.j. brown" are one person; so are "Kenneth
// Walker" and "Kenneth Walker III". Comparison keys drop punctuation, spacing
// and generational suffixes so all of those collapse together.
const nameParts = (value) => norm(value).split(" ").filter((part) => part && !SUFFIXES.has(part));
const nameKey = (value) => nameParts(value).join("");
const lastName = (value) => nameParts(value).at(-1) ?? "";
const firstName = (value) => nameParts(value)[0] ?? "";

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const POSITIONS = new Set(
  "QB RB FB WR TE OL OT OG DL DE DT NT EDGE LB ILB OLB MLB CB DB FS SS LS DEF DST ATH IDP FLEX".split(" ")
);

// Words that pass a capitalisation test but are never a player name. Headlines,
// depth-chart headers and transcripts are full of them.
const STOP = new Set(
  ("player players name names team teams pos position positions rank rk tier notes note " +
   "week wk depth chart starter starters backup backups injury report status active inactive " +
   "practice squad questionable doubtful probable projected proj rating grade age exp college " +
   "draft round pick bye opponent opp the and or of new top list targets snap snaps yards yds " +
   "tds td rec att carries fantasy points ppr adp watch board update updates breaking source " +
   "sources camp preseason season game games start starts starting sign signs signed trade " +
   "traded return returns expects expect said says added per via with from after before will " +
   "has had was were are that this then now but so out over under about into during today " +
   "monday tuesday wednesday thursday friday saturday sunday january february march april may " +
   "june july august september october november december offense defense special " +
   // Roster-status vocabulary: these describe a player rather than name one.
   "current former veteran rookie free agent reserve waived released activated healthy " +
   "suspended limited retired undrafted").split(" ")
);

// Abbreviations the manifest does not carry. Providers disagree about a
// handful of clubs, and a team hint is worthless if ARI and ARZ read as two
// different franchises.
const TEAM_ALIASES = {
  ARI: "ARZ", AZ: "ARZ", WSH: "WAS", WFT: "WAS", JAC: "JAX", LA: "LAR", SFO: "SF",
  GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", NOS: "NO", TAM: "TB", LVR: "LV",
  OAK: "LV", SD: "LAC", SDG: "LAC", STL: "LAR", CLV: "CLE", BLT: "BAL", HST: "HOU",
};

const KIND_LABELS = {
  image: "IMG", video: "VID", vtt: "VTT", srt: "SRT", html: "WEB", json: "JSON",
  csv: "CSV", text: "TXT", binary: "BIN", paste: "PASTE", url: "URL", curated: "FAV",
};

const index = { players: [], byKey: new Map(), byLast: new Map(), teams: new Map(), phrases: new Set() };

function buildIndex({ players = [], teams = [] }) {
  index.players = players
    .filter((player) => player.gsis_id && player.name)
    .map((player) => ({ ...player, key: nameKey(player.name) }));

  index.byKey = new Map(index.players.map((player) => [player.key, player]));
  index.byLast = new Map();
  for (const player of index.players) {
    const last = lastName(player.name);
    index.byLast.set(last, [...(index.byLast.get(last) ?? []), player]);
  }

  index.teams = new Map();
  for (const team of teams) {
    if (team.team_id) index.teams.set(team.team_id.toUpperCase(), team.team_id);
  }
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (index.teams.has(canonical)) index.teams.set(alias, canonical);
  }

  // Club names are blocked as whole phrases rather than as tokens: blocking
  // "Green" outright would also lose A.J. Green.
  index.phrases = new Set();
  for (const team of teams) {
    const words = String(team.name ?? "").split(" ").filter(Boolean);
    if (!words.length) continue;
    // Every run of words inside a club name, not just the whole phrase: a
    // tokeniser that loses the first word must not leave "City Chiefs" behind.
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const key = nameKey(words.slice(start, end).join(" "));
        if (key) index.phrases.add(key);
      }
    }
  }
}

// --------------------------------------------------------------- resolve ---
// An exact index hit is an identity. Anything short of that is a question --
// for the analyst if there is a plausible candidate, for the upstream resolver
// if there is not.
function resolveName(name) {
  const key = nameKey(name);
  const exact = index.byKey.get(key);
  if (exact) return { status: "resolved", match: exact, candidates: [] };

  const tokens = nameParts(name);
  const byLast = index.byLast.get(lastName(name)) ?? [];
  if (tokens.length === 1 && byLast.length) return { status: "review", match: null, candidates: byLast };

  const tolerance = Math.max(1, Math.floor(key.length / 9));
  const near = index.players.filter((player) => editDistance(player.key, key) <= tolerance);
  if (near.length) return { status: "review", match: null, candidates: near };

  // Same surname alone proves nothing -- Marquise Brown is not A.J. Brown --
  // so a shared first initial is the minimum before offering a candidate.
  const initial = firstName(name).charAt(0);
  const sameInitial = byLast.filter((player) => firstName(player.name).charAt(0) === initial);
  if (sameInitial.length) return { status: "review", match: null, candidates: sameInitial };

  return { status: "pending", match: null, candidates: [] };
}

// --------------------------------------------------------------- extract ---
const tokenize = (line) => line.split(/[\s/\\\t"\u201c\u201d:{}[\]()<>=]+/).filter(Boolean);
const cleanToken = (token) => token.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z.'\u2019-]+$/, "");

function isNameToken(token) {
  const cleaned = cleanToken(token);
  if (cleaned.length < 2) return false;
  if (!/^[A-Z][A-Za-z.'\u2019-]*$/.test(cleaned)) return false;
  const flat = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  return Boolean(flat) && !POSITIONS.has(flat) && !index.teams.has(flat) && !STOP.has(flat.toLowerCase());
}

// Rosters are often shouted. Restore sentence case so the captured name reads
// like a name, without touching initials or generational suffixes.
function fixCase(name) {
  if (/[a-z]/.test(name)) return name;
  return name.split(" ").map((token) => {
    const bare = token.replace(/[^A-Za-z]/g, "");
    if (/^(II|III|IV|V)$/.test(bare)) return bare;
    if (/^(JR|SR)$/.test(bare)) return `${bare[0]}${bare.slice(1).toLowerCase()}.`;
    if (/^([A-Z]\.){1,3}$/.test(token)) return token;
    return token.toLowerCase().replace(/(^|[\s'\u2019-])([a-z])/g, (_, lead, char) => lead + char.toUpperCase());
  }).join(" ");
}

const isIndexed = (name) => index.byKey.has(nameKey(fixCase(name)));

function runsFromSegment(segment, found) {
  const runs = [];
  let run = [];
  for (const token of tokenize(segment)) {
    if (isNameToken(token)) run.push(cleanToken(token));
    else {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  for (const tokens of runs) {
    if (tokens.length < 2) continue;
    if (tokens.length <= 4) {
      const attempts = [tokens.join(" "), tokens.slice(0, 2).join(" "), tokens.slice(-2).join(" "), tokens.slice(0, 3).join(" ")];
      found.push(attempts.find(isIndexed) ?? tokens.join(" "));
    } else {
      // A long unbroken run is prose, not a roster row. Lift only pairs the
      // index already knows rather than inventing names out of a sentence.
      for (let i = 0; i < tokens.length - 1; i++) {
        const pair = tokens.slice(i, i + 2).join(" ");
        if (isIndexed(pair)) found.push(pair);
      }
    }
  }
}

function namesFromLine(line) {
  // List punctuation splits first: "A.J. Brown, Ja'Marr Chase" is three cells,
  // not one seven-token run.
  const found = [];
  for (const segment of line.split(/[,;|\u2022\u00b7]+/)) runsFromSegment(segment, found);
  return found.map(fixCase).filter((name) => !index.phrases.has(nameKey(name)));
}

function hintsFromLine(line) {
  let position = null;
  let team = null;
  for (const token of tokenize(line)) {
    const flat = token.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (flat.length < 2) continue;
    if (!position && POSITIONS.has(flat)) position = flat;
    if (!team && index.teams.has(flat)) team = index.teams.get(flat);
  }
  return { position, team };
}

// ---------------------------------------------------------- format readers ---
function cueLines(text) {
  return text.split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes("-->")) return false;
      return !/^WEBVTT/i.test(trimmed) && !/^(NOTE|STYLE|REGION)\b/i.test(trimmed) && !/^\d+$/.test(trimmed);
    })
    .map((line) => line.replace(/<[^>]*>/g, "").replace(/^[A-Z][A-Z .'\u2019-]{0,24}:\s*/, "").trim());
}

function htmlLines(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
  const seen = new Set();
  for (const node of doc.querySelectorAll("li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,p,a,figcaption,caption")) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 220) seen.add(text);
  }
  if (seen.size) return [...seen];
  return (doc.body?.textContent ?? "").split(/\r?\n/);
}

const positionCode = (value) => {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return POSITIONS.has(code) ? code : null;
};
const teamCode = (value) => (typeof value === "string" ? index.teams.get(value.trim().toUpperCase()) ?? null : null);

// The team a document is about, named once in its header.
function documentTeam(data) {
  const team = typeof data.team === "string" ? data.team : data.team?.abbr ?? data.team?.team_id;
  return teamCode(data.team_id) ?? teamCode(data.team_abbr) ?? teamCode(data.abbr) ?? teamCode(team);
}

// A structured source carries context a flat line cannot: the position a player
// is filed under, the provider the file came from, the team it is about. That
// context is worth keeping -- with one caveat the reader encodes. A position
// comes from the section a player sits in and is about the player. A team named
// in a document header is about the *document*, and rosters go stale: a file
// cannot know a player has moved since it was written. So the team travels as a
// hint marked with where it came from, and never as an observation of a player.
function readJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const fileTeam = documentTeam(data);
  const records = [];
  const walk = (node, section) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, section);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "string" || !/name|player|full/i.test(key)) continue;
      const ownTeam = teamCode(node.team_id ?? node.team ?? node.team_abbr);
      records.push({
        text: value,
        hints: {
          position: positionCode(node.position ?? node.pos) ?? section,
          team: ownTeam ?? fileTeam,
          teamBasis: ownTeam ? "observed" : fileTeam ? "document" : null,
        },
      });
    }
    // "positions": { "RB": [...] } -- the key is the position.
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") walk(value, positionCode(key) ?? section);
    }
  };
  walk(data, null);

  const declared = {
    provider: typeof data.source?.provider === "string" ? data.source.provider : null,
    capture_status: typeof data.capture_status === "string" ? data.capture_status : null,
    observed_at: [data.source_observation_date, data.source_checked_at].find((v) => typeof v === "string") ?? null,
  };
  return { records, declared: Object.values(declared).some(Boolean) ? declared : null };
}

function csvLines(text) {
  const rows = text.split(/\r?\n/).filter((row) => row.trim());
  if (!rows.length) return rows;
  const probe = rows[0];
  const delimiter = probe.split("\t").length > probe.split(",").length ? "\t"
    : probe.split(";").length > probe.split(",").length ? ";" : ",";
  const cells = rows.map((row) => row.split(delimiter).map((cell) => cell.replace(/^"|"$/g, "").trim()));
  const header = cells[0].map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ""));
  const nameColumn = header.findIndex((cell) => ["name", "player", "playername", "fullname"].includes(cell));
  if (nameColumn < 0) return cells.map((row) => row.join(" "));
  return cells.slice(1).map((row) => {
    const codes = row.filter((cell, i) => i !== nameColumn && /^[A-Za-z]{2,4}$/.test(cell));
    return [row[nameColumn] ?? "", ...codes].join(" ");
  });
}

function linesFor(text, kind) {
  const lines = kind === "html" ? htmlLines(text)
    : kind === "vtt" || kind === "srt" ? cueLines(text)
    : kind === "csv" ? csvLines(text)
    : text.split(/\r?\n/);
  return lines.map((line) => String(line).trim()).filter(Boolean);
}

// Records carry their structural context; flat lines have none and fall back to
// whatever the line itself says. A file that claims to be JSON but will not
// parse is still read as text rather than rejected.
function readSource(text, kind) {
  if (kind === "json") {
    const parsed = readJson(text);
    if (parsed) return parsed;
  }
  return { records: linesFor(text, kind).map((line) => ({ text: line, hints: null })), declared: null };
}

// What the line says wins: it is about this player, where a document header is
// only about the file.
function mergeHints(line, structural) {
  if (!structural) return { position: line.position, team: line.team, teamBasis: line.team ? "observed" : null };
  return {
    position: line.position ?? structural.position ?? null,
    team: line.team ?? structural.team ?? null,
    teamBasis: line.team ? "observed" : structural.teamBasis,
  };
}

function kindOf(file) {
  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  const type = file.type ?? "";
  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "tif", "tiff"].includes(extension)) return "image";
  if (type.startsWith("video/") || ["mp4", "mov", "webm", "m4v", "avi", "mkv"].includes(extension)) return "video";
  if (extension === "vtt") return "vtt";
  if (extension === "srt") return "srt";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "json") return "json";
  if (extension === "csv" || extension === "tsv") return "csv";
  if (["txt", "md", "markdown", "text", "log"].includes(extension)) return "text";
  return type.startsWith("text/") ? "text" : "binary";
}

// ----------------------------------------------------------------- state ---
const state = { sources: [], rows: [], filter: "all", rowSeq: 0, sourceSeq: 0 };

const els = {};
let dragDepth = 0;

function addSource(source) {
  const entry = { id: `src-${++state.sourceSeq}`, extracted: 0, thumb: null, note: null, ...source };
  state.sources.push(entry);
  return entry;
}

function removeSource(id) {
  state.sources = state.sources.filter((source) => source.id !== id);
  // A candidate only exists because a source produced it; when the last source
  // backing it goes, so does the candidate.
  state.rows = state.rows.filter((row) => {
    row.sourceIds = row.sourceIds.filter((sourceId) => sourceId !== id);
    return row.sourceIds.length > 0;
  });
  render();
}

function addCandidate(name, hints, source) {
  const key = nameKey(name);
  if (key.length < 3) return false;

  const existing = state.rows.find((row) => row.key === key);
  if (existing) {
    existing.occurrences += 1;
    if (source && !existing.sourceIds.includes(source.id)) existing.sourceIds.push(source.id);
    existing.hints.position ??= hints.position ?? null;
    // A team seen beside the player outranks one inherited from a file header.
    if (hints.team && (!existing.hints.team || (hints.teamBasis === "observed" && existing.hints.teamBasis === "document"))) {
      existing.hints.team = hints.team;
      existing.hints.teamBasis = hints.teamBasis ?? null;
    }
    return false;
  }

  state.rows.push({
    id: `row-${++state.rowSeq}`,
    captured: name,
    key,
    occurrences: 1,
    sourceIds: source ? [source.id] : [],
    hints: { position: hints.position ?? null, team: hints.team ?? null, teamBasis: hints.teamBasis ?? null },
    confirmed: false,
    ...resolveName(name),
  });
  return true;
}

function ingestText(text, source) {
  const { records, declared } = readSource(text, source.kind);
  if (declared) source.declared = declared;

  let added = 0;
  const found = [];
  for (const record of records) {
    const names = namesFromLine(record.text);
    if (!names.length) continue;
    // Line hints only bind when the line names one player; on a comma list there
    // is no telling which name the trailing "WR MIN" belongs to. Structural
    // hints are safe either way -- they came from the shape of the document.
    const inline = names.length === 1 ? hintsFromLine(record.text) : { position: null, team: null };
    const hints = mergeHints(inline, record.hints);
    for (const name of names) {
      if (addCandidate(name, hints, source)) added += 1;
      found.push(name);
    }
  }
  source.extracted += added;
  return { added, found };
}

function announce(message) {
  els.live.textContent = message;
}

function handleFiles(files) {
  for (const file of [...files]) {
    const kind = kindOf(file);

    if (kind === "image" || kind === "video" || kind === "binary") {
      const note = kind === "image" ? "queued for upstream OCR"
        : kind === "video" ? "queued for upstream transcription"
        : "unreadable in the browser";
      const source = addSource({ kind, label: file.name, bytes: file.size, mode: "deferred_upstream", note });
      if (kind === "image" && file.size < 8 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = () => {
          source.thumb = reader.result;
          render();
        };
        reader.readAsDataURL(file);
      }
      render();
      announce(`${file.name} staged for the upstream pipeline.`);
      continue;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const source = addSource({ kind, label: file.name, bytes: file.size, mode: "in_browser" });
      const { added } = ingestText(String(reader.result ?? ""), source);
      render();
      announce(`${file.name}: ${added} new name${added === 1 ? "" : "s"} extracted.`);
    };
    reader.onerror = () => {
      addSource({ kind: "binary", label: file.name, bytes: file.size, mode: "deferred_upstream", note: "could not be read here" });
      render();
    };
    reader.readAsText(file);
  }
}

// ---------------------------------------------------------------- render ---
function counts() {
  const tally = { total: state.rows.length, resolved: 0, review: 0, pending: 0 };
  for (const row of state.rows) tally[row.status] += 1;
  return tally;
}

function formatBytes(value) {
  if (value == null) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function statusTag(row) {
  if (row.status === "resolved") {
    return `<span class="intake-tag here">${row.confirmed ? "Confirmed" : "Index match"}</span>`;
  }
  if (row.status === "review") return '<span class="intake-tag review">Needs review</span>';
  return '<span class="intake-tag upstream">Upstream</span>';
}

function renderRows() {
  const visible = state.rows.filter((row) => state.filter === "all" || row.status === state.filter);
  els.table.hidden = state.rows.length === 0;
  els.empty.hidden = state.rows.length !== 0;

  if (!visible.length && state.rows.length) {
    els.tbody.innerHTML = '<tr><td colspan="7" class="intake-none">No candidates in this view.</td></tr>';
    return;
  }

  els.tbody.innerHTML = visible.map((row) => {
    const match = row.match;
    const labels = row.sourceIds.map((id) => state.sources.find((source) => source.id === id)?.label ?? id);
    const sourceText = labels.length ? labels[0] + (labels.length > 1 ? ` +${labels.length - 1}` : "") : "\u2014";

    let resolution = statusTag(row);
    if (row.status === "review") {
      const options = row.candidates.map((candidate) =>
        `<option value="${escapeHtml(candidate.gsis_id)}">${escapeHtml(candidate.name)} \u00b7 ${escapeHtml(candidate.position ?? "")} ${escapeHtml(candidate.team_id ?? "")}</option>`
      ).join("");
      resolution += `<div class="intake-pick">
        <select class="search-input" data-action="pick" data-row="${row.id}" aria-label="Choose identity for ${escapeHtml(row.captured)}">
          <option value="">Choose identity\u2026</option>${options}
          <option value="__upstream">Not in index \u2014 send upstream</option>
        </select></div>`;
    } else if (row.status === "pending") {
      resolution += '<div class="intake-sub">resolution request, no fact asserted</div>';
    } else if (match) {
      resolution += `<div class="intake-sub">${escapeHtml((match.capture_status ?? "unknown").replace(/_/g, " "))} \u00b7 ${escapeHtml(match.captured_at ?? "no capture date")}</div>`;
    }

    const hintCell = (value, hint, label = "hint", title = "") => value
      ? `<span class="intake-slot">${escapeHtml(value)}</span>`
      : hint
        ? `<span class="intake-slot">${escapeHtml(hint)}</span><div class="intake-sub"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</div>`
        : '<span class="intake-slot">\u2014</span>';
    const fromFile = row.hints.teamBasis === "document";

    return `<tr>
      <td>
        <div class="intake-name">${escapeHtml(row.captured)}</div>
        ${match && match.name !== row.captured ? `<div class="intake-sub">canonical: ${escapeHtml(match.name)}</div>` : ""}
        ${row.occurrences > 1 ? `<div class="intake-sub">${row.occurrences} occurrences</div>` : ""}
      </td>
      <td><span class="intake-gsis${match ? "" : " none"}">${match ? escapeHtml(match.gsis_id) : "\u2014"}</span></td>
      <td>${hintCell(match?.position, row.hints.position)}</td>
      <td>${hintCell(match?.team_id, row.hints.team, fromFile ? "file hint" : "hint",
        fromFile ? "Taken from the file header, not from this player's row. Rosters go stale \u2014 verify before trusting it." : "")}</td>
      <td>${resolution}</td>
      <td><span class="intake-sub" title="${escapeHtml(labels.join(", "))}">${escapeHtml(sourceText)}</span></td>
      <td><button type="button" class="intake-icon" data-action="drop" data-row="${row.id}" aria-label="Remove ${escapeHtml(row.captured)}">\u2715</button></td>
    </tr>`;
  }).join("");
}

function renderSources() {
  els.sourceCount.textContent = state.sources.length ? `${state.sources.length} staged` : "none";
  if (!state.sources.length) {
    els.sourceList.innerHTML = '<p class="intake-hint">Nothing staged yet.</p>';
    return;
  }

  els.sourceList.innerHTML = state.sources.map((source) => {
    const readHere = source.mode === "in_browser";
    const meta = [
      formatBytes(source.bytes),
      readHere ? `${source.extracted} name${source.extracted === 1 ? "" : "s"}` : source.note,
      source.declared?.provider,
      source.declared?.capture_status,
    ].filter(Boolean).join(" \u00b7 ");
    const badge = source.thumb
      ? `<img class="intake-thumb" src="${escapeHtml(source.thumb)}" alt="">`
      : `<span class="intake-kind">${escapeHtml(KIND_LABELS[source.kind] ?? "SRC")}</span>`;

    return `<div class="intake-source">
      ${badge}
      <div class="intake-source-body">
        <div class="intake-source-label" title="${escapeHtml(source.label)}">${escapeHtml(source.label)}</div>
        <div class="intake-source-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="intake-source-end">
        <span class="intake-tag ${readHere ? "here" : "upstream"}">${readHere ? "read here" : "upstream"}</span>
        <button type="button" class="intake-icon" data-action="drop-source" data-source="${source.id}" aria-label="Remove source ${escapeHtml(source.label)}">\u2715</button>
      </div>
    </div>`;
  }).join("");
}

// The payload is the whole point of the canvas: what the downstream Gameplan
// app is handed. A record without a GSIS id is published as a request, never
// as a fact.
function buildPayload() {
  const tally = counts();
  return {
    schema_version: "pro-scout-ui.intake-batch.v1",
    generated_by: "pro-scout-ui/intake-canvas",
    target_repo: "Jimmy-Judge-Enterprises/pro-scout",
    season: 2026,
    contract_version: "2.0",
    counts: {
      candidates: tally.total,
      contract_ready: tally.resolved,
      needs_review: tally.review,
      pending_upstream: tally.pending,
    },
    sources: state.sources.map((source) => ({
      source_id: source.id,
      kind: source.kind,
      label: source.label,
      extraction: source.mode,
      ...(source.bytes == null ? {} : { bytes: source.bytes }),
      ...(source.note ? { deferred_reason: source.note } : {}),
      ...(source.declared ? { declared: source.declared } : {}),
      names_extracted: source.mode === "in_browser" ? source.extracted : null,
    })),
    records: state.rows.map((row) => {
      const match = row.match;
      return {
        name_as_captured: row.captured,
        gsis_id: match?.gsis_id ?? null,
        name: match?.name ?? row.captured,
        name_resolved: Boolean(match),
        position: match?.position ?? null,
        team_id: match?.team_id ?? null,
        resolution: match ? (row.confirmed ? "analyst_confirmed" : "nflverse_index") : "pending_upstream",
        record_uri: match ? `pro-scout:players/${match.gsis_id}.json` : null,
        provenance: { source_ids: [...row.sourceIds], occurrences: row.occurrences },
        ...(match ? {} : {
          hints: {
            team_id: row.hints.team,
            team_id_basis: row.hints.teamBasis,
            position: row.hints.position,
          },
          status: row.status === "review" ? "awaiting_analyst_review" : "awaiting_identity_resolution",
        }),
      };
    }),
  };
}

function renderPayload() {
  const tally = counts();
  els.payload.textContent = JSON.stringify(buildPayload(), null, 2);
  els.payloadNote.innerHTML =
    `<strong>${tally.resolved} of ${tally.total}</strong> record${tally.total === 1 ? "" : "s"} carry a GSIS id and are ` +
    "contract-compliant for the downstream Gameplan app. The rest leave this canvas as resolution requests \u2014 " +
    "a name and its hints, never an asserted fact.";
  const empty = !state.rows.length && !state.sources.length;
  els.copyJson.disabled = empty;
  els.saveJson.disabled = empty;
}

function renderMeters() {
  const tally = counts();
  const max = Math.max(tally.total, 1);
  for (const [key, value] of Object.entries(tally)) {
    els[`tile-${key}`].textContent = value;
    els[`meter-${key}`].style.width = key === "total" ? (value ? "100%" : "0") : `${(100 * value) / max}%`;
    if (key !== "total") els[`filter-${key}`].textContent = value;
  }
  els["filter-all"].textContent = tally.total;

  els.countSources.textContent = state.sources.length;
  els.countCandidates.textContent = tally.total;
  els.countResolved.textContent = tally.resolved;
  els.countContract.textContent = tally.resolved;
  els.stages[0].classList.toggle("is-live", state.sources.length > 0);
  els.stages[1].classList.toggle("is-live", tally.total > 0);
  els.stages[2].classList.toggle("is-live", tally.resolved + tally.review > 0);
  els.stages[3].classList.toggle("is-live", tally.resolved > 0);
}

function render() {
  renderMeters();
  renderSources();
  renderRows();
  renderPayload();
}

// What each extracted name turns into on its way out of the paste box. The
// word is the row's actual fate, so the animation reports rather than decorates.
const MUTATIONS = { resolved: "INGESTED", review: "REVIEW", pending: "QUEUED" };

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

// Matches the name as it was actually typed: any case, either apostrophe, and
// with initials that may or may not carry their periods.
const namePattern = (name) => name
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  .replace(/\\\./g, "\\.?")
  .replace(/['\u2019]/g, "['\u2019]")
  .replace(/\s+/g, "\\s+");

function echoMarkup(text, found) {
  const spans = [];
  const seen = new Set();
  for (const name of found) {
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const word = MUTATIONS[state.rows.find((row) => row.key === key)?.status] ?? "QUEUED";
    for (const hit of text.matchAll(new RegExp(namePattern(name), "gi"))) {
      spans.push({ start: hit.index, end: hit.index + hit[0].length, word });
    }
  }

  // Markup is assembled from slices of the raw text so escaping happens once,
  // after the offsets are settled.
  const ordered = spans.sort((a, b) => a.start - b.start)
    .filter((span, i, all) => i === 0 || span.start >= all[i - 1].end);

  // Names lifted out of markup or JSON never appear verbatim in what was
  // pasted; the whole block resolves as one instead.
  if (!ordered.length) {
    return `<span class="intake-echo-name" data-word="${found.length} INGESTED">${escapeHtml(text)}</span>`;
  }

  let markup = "";
  let cursor = 0;
  for (const span of ordered) {
    markup += escapeHtml(text.slice(cursor, span.start));
    markup += `<span class="intake-echo-name" data-word="${span.word}">${escapeHtml(text.slice(span.start, span.end))}</span>`;
    cursor = span.end;
  }
  return markup + escapeHtml(text.slice(cursor));
}

// The box clears on extract. Rather than blanking, the text it held is echoed
// back and each recognised name stipples apart and reforms as its intake state,
// so the analyst can see what was taken before the box empties.
function dissolvePaste(text, found) {
  els.paste.value = "";
  els.paste.closest(".intake-paste-wrap").querySelector(".intake-echo")?.remove();
  if (reducedMotion?.matches) return;

  const echo = document.createElement("div");
  echo.className = "intake-echo";
  echo.setAttribute("aria-hidden", "true");
  echo.innerHTML = echoMarkup(text, found);
  els.paste.closest(".intake-paste-wrap").append(echo);

  const names = [...echo.querySelectorAll(".intake-echo-name")];
  requestAnimationFrame(() => echo.classList.add("is-stippling"));
  setTimeout(() => {
    for (const span of names) {
      span.textContent = span.dataset.word;
      span.classList.add("is-mutated");
    }
  }, 460);
  setTimeout(() => echo.classList.add("is-gone"), 1120);
  setTimeout(() => echo.remove(), 1560);
}

// ------------------------------------------------------------------ wire ---
function extractFromPaste() {
  const text = els.paste.value.trim();
  if (!text) {
    els.paste.focus();
    return;
  }
  const looksLikeMarkup = /<\/?(ul|ol|li|table|tr|td|div|span|p|a)\b/i.test(text);
  const looksLikeCues = text.includes("-->") && /\d\d:\d\d/.test(text);
  // A pasted document deserves the same reader a dropped file would get.
  const looksLikeJson = /^[[{]/.test(text.trim()) && Boolean(readJson(text));
  const kind = looksLikeJson ? "json" : looksLikeCues ? "vtt" : looksLikeMarkup ? "html" : "paste";
  const label = { json: "Pasted JSON", html: "Pasted page markup", vtt: "Pasted transcript" }[kind] ?? "Pasted text";
  const source = addSource({ kind, label, bytes: text.length, mode: "in_browser" });
  const { added, found } = ingestText(text, source);

  // Nothing recognised: keep both the text and the box, and say so. Dropping a
  // source that yielded no names keeps repeated attempts out of the ledger.
  if (!found.length) {
    state.sources = state.sources.filter((entry) => entry.id !== source.id);
    render();
    announce("No player names found in that text. It has been left in the box.");
    return;
  }

  render();
  announce(`${added} new name${added === 1 ? "" : "s"} extracted from the pasted text.`);
  dissolvePaste(text, found);
}

function renderFavorites() {
  // Derived from the manifest rather than hand-listed, so the shortcuts stay
  // true as the manifest grows.
  const groups = [{ label: "Full manifest", players: index.players }];
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const players = index.players.filter((player) => player.position === position);
    if (players.length) groups.push({ label: position, players });
  }
  els.favorites.innerHTML = groups.map((group, i) =>
    `<button type="button" class="intake-chip" data-favorite="${i}">${escapeHtml(group.label)}<span class="intake-n">${group.players.length}</span></button>`
  ).join("");
  return groups;
}

function copyPayload() {
  const text = JSON.stringify(buildPayload(), null, 2);
  navigator.clipboard?.writeText(text).then(
    () => announce("Payload copied to the clipboard."),
    () => announce("Copy was blocked. Select the payload and copy it manually.")
  );
}

function downloadPayload() {
  const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pro-scout-intake-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const isActive = () => !els.panel.hidden;

export function initIntake(manifests) {
  buildIndex(manifests);

  Object.assign(els, {
    panel: document.querySelector("#intake-panel"),
    dropzone: document.querySelector("#intake-dropzone"),
    picker: document.querySelector("#intake-filepicker"),
    paste: document.querySelector("#intake-paste"),
    url: document.querySelector("#intake-url"),
    favorites: document.querySelector("#intake-favorites"),
    sourceList: document.querySelector("#intake-sources"),
    sourceCount: document.querySelector("#intake-source-count"),
    table: document.querySelector("#intake-table"),
    tbody: document.querySelector("#intake-tbody"),
    empty: document.querySelector("#intake-empty"),
    filters: document.querySelector("#intake-filters"),
    payload: document.querySelector("#intake-payload"),
    payloadNote: document.querySelector("#intake-payload-note"),
    copyJson: document.querySelector("#intake-copy"),
    saveJson: document.querySelector("#intake-save"),
    veil: document.querySelector("#intake-veil"),
    live: document.querySelector("#intake-live"),
    countSources: document.querySelector("#intake-count-sources"),
    countCandidates: document.querySelector("#intake-count-candidates"),
    countResolved: document.querySelector("#intake-count-resolved"),
    countContract: document.querySelector("#intake-count-contract"),
    stages: [...document.querySelectorAll("#intake-pipeline .intake-stage")],
  });
  for (const key of ["total", "resolved", "review", "pending"]) {
    els[`tile-${key}`] = document.querySelector(`#intake-tile-${key}`);
    els[`meter-${key}`] = document.querySelector(`#intake-meter-${key}`);
    els[`filter-${key}`] = document.querySelector(`#intake-filter-${key}`);
  }
  els["filter-all"] = document.querySelector("#intake-filter-all");

  const favorites = renderFavorites();

  els.dropzone.addEventListener("click", () => els.picker.click());
  els.picker.addEventListener("change", () => {
    handleFiles(els.picker.files);
    els.picker.value = "";
  });

  document.querySelector("#intake-extract").addEventListener("click", extractFromPaste);
  document.querySelector("#intake-clear-paste").addEventListener("click", () => {
    els.paste.value = "";
    els.paste.focus();
  });

  document.querySelector("#intake-stage-url").addEventListener("click", () => {
    const raw = els.url.value.trim();
    if (!raw) {
      els.url.focus();
      return;
    }
    let label = raw;
    try {
      const parsed = new URL(raw);
      label = parsed.hostname.replace(/^www\./, "") + parsed.pathname;
    } catch {
      // Not a parseable URL; stage it verbatim and let the fetcher judge it.
    }
    addSource({ kind: "url", label, bytes: null, mode: "deferred_upstream", note: "queued for upstream fetch", href: raw });
    els.url.value = "";
    render();
    announce("URL staged for the upstream fetcher.");
  });

  els.favorites.addEventListener("click", (event) => {
    const button = event.target.closest("[data-favorite]");
    if (!button) return;
    const group = favorites[Number(button.dataset.favorite)];
    const source = addSource({ kind: "curated", label: `${group.label} (curated)`, bytes: null, mode: "in_browser" });
    let added = 0;
    for (const player of group.players) {
      if (addCandidate(player.name, { position: player.position, team: player.team_id }, source)) added += 1;
    }
    source.extracted += added;
    render();
    announce(`${group.label}: ${added} name${added === 1 ? "" : "s"} loaded.`);
  });

  els.sourceList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='drop-source']");
    if (button) removeSource(button.dataset.source);
  });

  els.tbody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='drop']");
    if (!button) return;
    state.rows = state.rows.filter((row) => row.id !== button.dataset.row);
    render();
  });

  els.tbody.addEventListener("change", (event) => {
    const select = event.target.closest("[data-action='pick']");
    if (!select || !select.value) return;
    const row = state.rows.find((candidate) => candidate.id === select.dataset.row);
    if (!row) return;
    if (select.value === "__upstream") {
      Object.assign(row, { status: "pending", match: null, candidates: [], confirmed: false });
    } else {
      const picked = index.players.find((player) => player.gsis_id === select.value);
      if (!picked) return;
      Object.assign(row, { status: "resolved", match: picked, confirmed: true });
    }
    render();
  });

  els.filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const chip of els.filters.querySelectorAll("[data-filter]")) {
      chip.classList.toggle("is-on", chip === button);
    }
    renderRows();
  });

  document.querySelector("#intake-clear-batch").addEventListener("click", () => {
    state.rows = [];
    state.sources = [];
    render();
    announce("Batch cleared.");
  });

  els.copyJson.addEventListener("click", copyPayload);
  els.saveJson.addEventListener("click", downloadPayload);

  // Dropping anywhere on the canvas works, not just on the drop target -- but
  // only while the intake view is the one on screen.
  const carriesData = (event) => {
    const types = event.dataTransfer?.types;
    return Boolean(types) && ([...types].includes("Files") || [...types].includes("text/plain"));
  };
  window.addEventListener("dragenter", (event) => {
    if (!isActive() || !carriesData(event)) return;
    event.preventDefault();
    dragDepth += 1;
    els.veil.classList.add("is-on");
  });
  window.addEventListener("dragover", (event) => {
    if (isActive() && carriesData(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.veil.classList.remove("is-on");
  });
  window.addEventListener("drop", (event) => {
    if (!isActive() || !event.dataTransfer) return;
    event.preventDefault();
    dragDepth = 0;
    els.veil.classList.remove("is-on");
    if (event.dataTransfer.files?.length) {
      handleFiles(event.dataTransfer.files);
      return;
    }
    const text = event.dataTransfer.getData("text/plain");
    if (text?.trim()) {
      els.paste.value = els.paste.value ? `${els.paste.value}\n${text}` : text;
      extractFromPaste();
    }
  });

  document.addEventListener("paste", (event) => {
    if (!isActive() || !event.clipboardData) return;
    const target = event.target;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    if (event.clipboardData.files?.length) {
      event.preventDefault();
      handleFiles(event.clipboardData.files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text?.trim()) {
      event.preventDefault();
      els.paste.value = els.paste.value ? `${els.paste.value}\n${text}` : text;
      extractFromPaste();
    }
  });

  render();
}
