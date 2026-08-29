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
import { buildBundle, buildRequestsDocument, intakeIssueUrl, sourceIdFor } from "./contract.js";
import { identityAliases } from "./team-aliases.mjs";

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

// Alternate club codes live in team-aliases.mjs, which is also what the Teams
// search uses. Only the token-safe layer reaches here: a nickname would be
// matched against single words and would decide "Dallas" is a club rather than
// half of Dallas Goedert's name.

const KIND_LABELS = {
  image: "IMG", video: "VID", vtt: "VTT", srt: "SRT", html: "WEB", json: "JSON",
  csv: "CSV", text: "TXT", binary: "BIN", paste: "PASTE", url: "URL", curated: "FAV",
};

const index = { players: [], byKey: new Map(), byLast: new Map(), teams: new Map(), softTeams: new Set(), phrases: new Set() };

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
  for (const [alias, canonical] of Object.entries(identityAliases())) {
    if (index.teams.has(canonical)) index.teams.set(alias, canonical);
  }

  // A club code that is also somebody's given name cannot simply be struck out
  // of a line. KC Concepcion is a real receiver whose first name is a real team
  // id, and treating it as a club broke the name run and dropped him with no
  // error. Which codes collide is read from the manifest rather than listed
  // here, so a future signing fixes itself.
  index.softTeams = new Set();
  const nameTokens = new Set();
  for (const player of index.players) {
    for (const token of String(player.name).split(/\s+/)) {
      const flat = token.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (flat) nameTokens.add(flat);
    }
  }
  for (const code of index.teams.keys()) if (nameTokens.has(code)) index.softTeams.add(code);

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

// ------------------------------------------------------------ clarifying ---
// The canvas asks for a hint when it cannot tell two candidates apart, and
// accepts one for a name it could not place at all. What it does with the
// answer is bounded by the intake contract: a hint discriminates between
// candidates the index already holds, it never conjures a match, and a hint
// that contradicts the canonical index stops the row rather than overriding it.

// What actually separates a retained candidate set, so the prompt can ask for
// the detail that would settle it rather than for hints in general.
function discriminators(candidates) {
  const fields = [];
  if (new Set(candidates.map((entry) => entry.position)).size > 1) fields.push("position");
  if (new Set(candidates.map((entry) => entry.team_id)).size > 1) fields.push("team");
  return fields;
}

const matchesHint = (value, hint) => !hint || !value || value.toUpperCase() === hint.toUpperCase();

function normaliseTeam(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw ? index.teams.get(raw) ?? raw : null;
}
function normalisePosition(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw || null;
}

// A hint against a proven identity is checked, not applied. The index is the
// authority; disagreement is a reason to stop and look, which is why the row
// keeps its candidate rather than quietly adopting the hint.
function conflictWith(match, hints) {
  if (!match) return null;
  const clashes = [];
  if (hints.team && match.team_id && hints.team.toUpperCase() !== match.team_id.toUpperCase()) {
    clashes.push(`team ${hints.team} against ${match.team_id}`);
  }
  if (hints.position && match.position && hints.position.toUpperCase() !== match.position.toUpperCase()) {
    clashes.push(`position ${hints.position} against ${match.position}`);
  }
  return clashes.length ? { name: match.name, gsis_id: match.gsis_id, clashes } : null;
}

function applyAnalystHints(row, { team, position, note }) {
  const nextTeam = normaliseTeam(team);
  const nextPosition = normalisePosition(position);
  if (nextTeam) {
    row.hints.team = nextTeam;
    row.hints.teamBasis = "analyst";
  }
  if (nextPosition) {
    row.hints.position = nextPosition;
    row.hints.positionBasis = "analyst";
  }
  row.analyst_note = String(note ?? "").trim() || null;
  row.conflict = null;

  const held = row.match ?? null;
  const clash = conflictWith(held, row.hints);
  if (clash) {
    // Stop, do not override: the identity goes back into question and the
    // canonical candidate stays on the row for the analyst to weigh.
    row.conflict = clash;
    row.status = "review";
    row.match = null;
    row.confirmed = false;
    row.candidates = held ? [held] : row.candidates;
    return `The hint disagrees with the canonical index for ${clash.name}: ${clash.clashes.join("; ")}. Identity is back in question.`;
  }

  if (row.status === "review" && row.candidates.length) {
    const surviving = row.candidates.filter((candidate) =>
      matchesHint(candidate.team_id, row.hints.team) && matchesHint(candidate.position, row.hints.position));
    if (surviving.length === 1) {
      Object.assign(row, { status: "resolved", match: surviving[0], confirmed: true, confirmedBy: "hint" });
      return `${surviving[0].name} discriminated by the hint.`;
    }
    if (surviving.length === 0) {
      row.conflict = { name: null, gsis_id: null, clashes: ["no retained candidate matches the hint"] };
      return "No retained candidate matches that hint, so none was chosen.";
    }
    row.candidates = surviving;
    return `${surviving.length} candidates still match. A ${discriminators(surviving).join(" or ") || "further"} hint would separate them.`;
  }

  // A name the index does not hold stays unresolved. Hints travel with the
  // request; they do not make a match where there was none.
  return "Hints recorded. They travel with the identity request.";
}

// --------------------------------------------------------------- extract ---
// Ordinary English words that are also given names. A blanket stop on "will"
// silently drops Will Kacmarek; no stop at all reads "Colts Will Start" as a
// player. They stop a run only when what follows is not itself a name.
const SOFT_STOP = new Set("will may march april june august camp free pick".split(" "));

const tokenize = (line) => line.split(/[\s/\\\t"\u201c\u201d:{}[\]()<>=]+/).filter(Boolean);
const cleanToken = (token) => token.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z.'\u2019-]+$/, "");

function nameTokenKind(token) {
  const cleaned = cleanToken(token);
  if (cleaned.length < 2) return "no";
  if (!/^[A-Z][A-Za-z.'\u2019-]*$/.test(cleaned)) return "no";
  const flat = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!flat || POSITIONS.has(flat)) return "no";
  // A colliding club code behaves like an ordinary word that is also a name:
  // it belongs to the run only when a real name follows it.
  if (index.teams.has(flat)) return index.softTeams.has(flat) ? "soft" : "no";
  const word = flat.toLowerCase();
  if (SOFT_STOP.has(word)) return "soft";
  return STOP.has(word) ? "no" : "yes";
}

// A soft stop earns its place in a run only when a real name follows it.
function isNameToken(token, next) {
  const kind = nameTokenKind(token);
  if (kind === "soft") return next !== undefined && nameTokenKind(next) === "yes";
  return kind === "yes";
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
  const tokens = tokenize(segment);
  let run = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isNameToken(tokens[i], tokens[i + 1])) run.push(cleanToken(tokens[i]));
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
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    const flat = tokens[i].replace(/[^A-Za-z]/g, "").toUpperCase();
    if (flat.length < 2) continue;
    // A token the scan reads as part of a name is not also a club hint, or
    // "KC Concepcion CLE" would report his club as KC.
    if (isNameToken(tokens[i], tokens[i + 1])) continue;
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

const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

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
        // Kept verbatim for the fact domains downstream; a null depth stays null.
        source_fields: {
          depth: Number.isInteger(node.depth) ? node.depth : null,
          role: str(node.role),
          status: str(node.status),
          source_basis: str(node.source_basis),
        },
      });
    }
    // "positions": { "RB": [...] } -- the key is the position.
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") walk(value, positionCode(key) ?? section);
    }
  };
  walk(data, null);

  // observed_at and checked_at are different clocks. When the source asserted
  // the information and when we looked are not interchangeable, and collapsing
  // them would manufacture an observation time the capture never gave.
  const declared = {
    provider: str(data.source?.provider),
    source_type: str(data.source?.type),
    url: str(data.source?.url),
    capture_status: str(data.capture_status),
    observed_at: str(data.source_observation_date),
    checked_at: str(data.source_checked_at),
    team: fileTeam,
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
  return {
    records: linesFor(text, kind).map((line) => ({ text: line, hints: null, source_fields: null })),
    declared: null,
  };
}

// What the line says wins: it is about this player, where a document header is
// only about the file.
function mergeHints(line, structural) {
  const position = line.position ?? structural?.position ?? null;
  return {
    position,
    // Everything a source states -- on the line or through the shape of the
    // document -- is observed. Only a person typing into the canvas is not.
    positionBasis: position ? "observed" : null,
    team: line.team ?? structural?.team ?? null,
    teamBasis: line.team ? "observed" : structural?.teamBasis ?? null,
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
// Extraction is a synchronous scan, so a large capture blocks the page while it
// runs -- roughly two thirds of a second per megabyte. A roster, depth chart or
// transcript is far below this; something this size is not one, and the page
// says so rather than freezing for ten seconds pretending otherwise.
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const state = {
  sources: [], rows: [], filter: "all", rowSeq: 0, sourceSeq: 0, editingRow: null,
  // Stamped once when a batch begins, so the manifest a preview shows is the
  // manifest an export writes.
  batchId: null, assembledAt: null,
  schemas: null, schemaError: null,
  bundle: null, restored: null,
};

const STORE_KEY = "pro-scout-ui.intake-batch";
const STORE_VERSION = 1;

// A per-viewer convenience, and nothing more: the batch someone is part-way
// through survives a reload of their own browser. It is never shared, never
// authoritative, and never a source. An identity is stored as its id and
// rehydrated from the current index, so a match cannot outlive the manifest
// that proved it -- if the index no longer holds it, the row goes back to
// being a question rather than carrying a claim nothing supports.
function saveBatch() {
  try {
    if (!state.rows.length && !state.sources.length) {
      localStorage.removeItem(STORE_KEY);
      return;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify({
      version: STORE_VERSION,
      batch_id: state.batchId,
      assembled_at: state.assembledAt,
      sources: state.sources,
      rows: state.rows.map((row) => ({
        ...row,
        match: row.match?.gsis_id ?? null,
        candidates: row.candidates.map((candidate) => candidate.gsis_id),
      })),
    }));
  } catch {
    // Storage blocked, unavailable or full. The batch is still on the page, so
    // only the convenience is lost and there is nothing to report.
  }
}

const ordinalOf = (id, prefix) => Number(String(id ?? "").replace(prefix, "")) || 0;

function restoreBatch() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  } catch {
    return;
  }
  if (!saved || saved.version !== STORE_VERSION) return;

  const byGsis = new Map(index.players.map((player) => [player.gsis_id, player]));
  state.batchId = saved.batch_id ?? null;
  state.assembledAt = saved.assembled_at ?? null;
  state.sources = Array.isArray(saved.sources) ? saved.sources : [];
  state.rows = (Array.isArray(saved.rows) ? saved.rows : []).map((row) => {
    const match = row.match ? byGsis.get(row.match) ?? null : null;
    const candidates = (row.candidates ?? []).map((id) => byGsis.get(id)).filter(Boolean);
    const withdrawn = row.match && !match;
    return {
      ...row,
      match,
      candidates,
      status: withdrawn ? (candidates.length ? "review" : "pending") : row.status,
      confirmed: withdrawn ? false : row.confirmed,
    };
  });
  // Sequences continue past the highest id seen, not past the count: a batch
  // that had rows removed would otherwise mint an id it already used.
  state.rowSeq = Math.max(0, ...state.rows.map((row) => ordinalOf(row.id, "row-")));
  state.sourceSeq = Math.max(0, ...state.sources.map((source) => ordinalOf(source.id, "src-")));
  if (state.rows.length || state.sources.length) {
    state.restored = { count: state.rows.length, at: state.assembledAt };
  }
}

const els = {};
let dragDepth = 0;

function addSource(source) {
  const entry = { id: `src-${++state.sourceSeq}`, extracted: 0, note: null, ...source };
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

function addCandidate(name, hints, source, fields = null) {
  const key = nameKey(name);
  if (key.length < 3) return false;

  const existing = state.rows.find((row) => row.key === key);
  if (existing) {
    existing.occurrences += 1;
    if (source && !existing.sourceIds.includes(source.id)) existing.sourceIds.push(source.id);
    if (hints.position && !existing.hints.position) {
      existing.hints.position = hints.position;
      existing.hints.positionBasis = hints.positionBasis ?? null;
    }
    existing.source_fields ??= fields;
    // A team seen beside the player outranks one inherited from a file header.
    if (hints.team && (!existing.hints.team || (hints.teamBasis === "observed" && existing.hints.teamBasis === "document"))) {
      existing.hints.team = hints.team;
      existing.hints.teamBasis = hints.teamBasis ?? null;
    }
    return false;
  }

  state.batchId ??= newId();
  state.assembledAt ??= new Date().toISOString();
  state.rows.push({
    id: `row-${++state.rowSeq}`,
    // Minted with the row and stable for its life, so reordering or removing
    // other rows never renumbers a request that has already left the canvas.
    request_id: newId(),
    captured: name,
    key,
    occurrences: 1,
    sourceIds: source ? [source.id] : [],
    hints: {
      position: hints.position ?? null,
      positionBasis: hints.positionBasis ?? null,
      team: hints.team ?? null,
      teamBasis: hints.teamBasis ?? null,
    },
    analyst_note: null,
    conflict: null,
    source_fields: fields,
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
    // Source fields describe one player, so they only attach when the line
    // named exactly one.
    const fields = names.length === 1 ? record.source_fields : null;
    for (const name of names) {
      if (addCandidate(name, hints, source, fields)) added += 1;
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
      // Staged, not read. The file is never decoded into the page: there is no
      // preview to render because nothing here can read it.
      addSource({ kind, label: file.name, bytes: file.size, mode: "deferred_upstream", note });
      render();
      announce(`${file.name} staged for the upstream pipeline.`);
      continue;
    }

    if (file.size > MAX_TEXT_BYTES) {
      addSource({
        kind, label: file.name, bytes: file.size, mode: "deferred_upstream",
        note: `too large to read here (over ${Math.round(MAX_TEXT_BYTES / 1048576)} MB)`,
      });
      render();
      announce(`${file.name} is too large to read in the browser and was staged for upstream.`);
      continue;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const source = addSource({ kind, label: file.name, bytes: file.size, mode: "in_browser", reading: true });
      render();
      // Yield past a frame so the reading state actually paints before the scan
      // blocks the thread; a zero delay can run before the browser has drawn
      // anything, and the card would appear only once the work was over -- the
      // moment it stops being useful. A timer rather than requestAnimationFrame,
      // which does not fire in a background tab and would strand the extraction.
      setTimeout(() => {
        const { added } = ingestText(String(reader.result ?? ""), source);
        source.reading = false;
        render();
        announce(`${file.name}: ${added} new name${added === 1 ? "" : "s"} extracted.`);
      }, 32);
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

const BASIS_LABELS = { document: "file hint", analyst: "your hint", observed: "hint" };
const BASIS_TITLES = {
  document: "Taken from the file header, not from this player's row. Rosters go stale \u2014 verify before trusting it.",
  analyst: "Supplied here to narrow the search. It discriminates between candidates; it never establishes identity.",
  observed: "Stated by the source beside this player.",
};

// The canvas asks for the detail that would actually settle the row, rather
// than asking for hints in general.
function hintPrompt(row) {
  const fields = row.candidates.length > 1 ? discriminators(row.candidates) : [];
  // Only say something a row-by-row reading needs. The generic case is already
  // stated once by the row's own status, and repeating it forty times is noise.
  const ask = fields.length
    ? `A ${fields.join(" or ")} hint separates these candidates.`
    : row.status === "review" ? "A hint would help confirm which identity this is." : "";
  return `<div class="intake-ask">
    ${ask ? `<span>${escapeHtml(ask)}</span>` : ""}
    <button type="button" class="intake-button intake-button-sm" data-action="hint" data-row="${row.id}">Add hints</button>
  </div>`;
}

// Prefilled only with what a person typed here before. Prefilling a source's
// own hint would relabel it as the analyst's the moment the form was applied.
function hintEditor(row) {
  const mine = (field) => (row.hints[`${field}Basis`] === "analyst" ? row.hints[field] ?? "" : "");
  return `<tr class="intake-hint-row"><td colspan="7">
    <form class="intake-hint-form" data-hint-form="${row.id}">
      <p class="intake-hint-lede">Clarifying details for <strong>${escapeHtml(row.captured)}</strong>. Hints
        discriminate between candidates the canonical index already holds \u2014 they never establish identity, and one
        that contradicts the index stops the row rather than overriding it.</p>
      <div class="intake-hint-fields">
        <label>Team<input name="team" class="search-input" autocomplete="off" value="${escapeHtml(mine("team"))}"></label>
        <label>Position<input name="position" class="search-input" autocomplete="off" value="${escapeHtml(mine("position"))}"></label>
        <label class="intake-hint-note">Note<input name="note" class="search-input" autocomplete="off" value="${escapeHtml(row.analyst_note ?? "")}"></label>
      </div>
      <div class="intake-hint-actions">
        <button type="submit" class="toggle-button is-active">Apply hints</button>
        <button type="button" class="intake-button" data-action="hint-cancel">Cancel</button>
      </div>
    </form>
  </td></tr>`;
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
    if (row.conflict) {
      const against = row.conflict.name ? ` for ${row.conflict.name}` : "";
      resolution += `<div class="intake-conflict">Hint disagrees with the canonical index${escapeHtml(against)}:
        ${escapeHtml(row.conflict.clashes.join("; "))}. Resolve it upstream rather than overriding it here.</div>`;
    }
    if (row.status === "review") {
      const options = row.candidates.map((candidate) =>
        `<option value="${escapeHtml(candidate.gsis_id)}">${escapeHtml(candidate.name)} \u00b7 ${escapeHtml(candidate.position ?? "")} ${escapeHtml(candidate.team_id ?? "")}</option>`
      ).join("");
      resolution += `<div class="intake-pick">
        <select class="search-input" data-action="pick" data-row="${row.id}" aria-label="Choose identity for ${escapeHtml(row.captured)}">
          <option value="">Choose identity\u2026</option>${options}
          <option value="__upstream">Not in index \u2014 send upstream</option>
        </select></div>`;
      resolution += hintPrompt(row);
    } else if (row.status === "pending") {
      resolution += '<div class="intake-sub">resolution request, no fact asserted</div>';
      resolution += hintPrompt(row);
    } else if (match) {
      resolution += `<div class="intake-sub">${escapeHtml((match.capture_status ?? "unknown").replace(/_/g, " "))} \u00b7 ${escapeHtml(match.captured_at ?? "no capture date")}</div>`;
    }

    const hintCell = (value, hint, basis) => value
      ? `<span class="intake-slot">${escapeHtml(value)}</span>`
      : hint
        ? `<span class="intake-slot">${escapeHtml(hint)}</span><div class="intake-sub" title="${escapeHtml(BASIS_TITLES[basis] ?? "")}">${escapeHtml(BASIS_LABELS[basis] ?? "hint")}</div>`
        : '<span class="intake-slot">\u2014</span>';

    return `<tr>
      <td>
        <div class="intake-name">${escapeHtml(row.captured)}</div>
        ${match && match.name !== row.captured ? `<div class="intake-sub">canonical: ${escapeHtml(match.name)}</div>` : ""}
        ${row.occurrences > 1 ? `<div class="intake-sub">${row.occurrences} occurrences</div>` : ""}
      </td>
      <td><span class="intake-gsis${match ? "" : " none"}">${match ? escapeHtml(match.gsis_id) : "\u2014"}</span></td>
      <td>${hintCell(match?.position, row.hints.position, row.hints.positionBasis)}</td>
      <td>${hintCell(match?.team_id, row.hints.team, row.hints.teamBasis)}</td>
      <td>${resolution}</td>
      <td><span class="intake-sub" title="${escapeHtml(labels.join(", "))}">${escapeHtml(sourceText)}</span></td>
      <td class="intake-row-actions">
        ${match ? `<button type="button" class="intake-icon" data-action="hint" data-row="${row.id}"
          title="Add what you know about ${escapeHtml(row.captured)}. A hint that contradicts the canonical index stops the row rather than overriding it.">\u270e</button>` : ""}
        ${match ? "" : `<a class="intake-icon" href="${escapeHtml(intakeIssueUrl({
          player_name: row.captured,
          team_hint: row.hints.teamBasis === "document" ? null : row.hints.team,
          position_hint: row.hints.position,
          request_id: row.request_id,
          notes: row.analyst_note,
        }))}" target="_blank" rel="noopener" title="Open an identity search request for ${escapeHtml(row.captured)}">\u2197</a>`}
        <button type="button" class="intake-icon" data-action="drop" data-row="${row.id}" aria-label="Remove ${escapeHtml(row.captured)}">\u2715</button>
      </td>
    </tr>${state.editingRow === row.id ? hintEditor(row) : ""}`;
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
      source.reading ? "reading\u2026" : readHere ? `${source.extracted} name${source.extracted === 1 ? "" : "s"}` : source.note,
      source.declared?.provider,
      source.declared?.capture_status,
    ].filter(Boolean).join(" \u00b7 ");
    const badge = `<span class="intake-kind">${escapeHtml(KIND_LABELS[source.kind] ?? "SRC")}</span>`;

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

// SHA-256 of the data file, when the runtime offers it. A page served without
// a secure context has no subtle crypto; the manifest contract permits a null
// hash, and reporting null is honest where inventing one would not be.
// Identifiers, not evidence. randomUUID needs a secure context; random bytes
// serve the same purpose where it is absent.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(text) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let bundleToken = 0;

async function renderBundle() {
  const token = ++bundleToken;
  const ready = Boolean(state.schemas);
  state.bundle = ready && state.rows.length
    ? await buildBundle({
        rows: state.rows,
        sources: state.sources,
        schemas: state.schemas,
        knownAt: state.assembledAt,
        batchId: state.batchId,
        digest,
      })
    : null;
  // A newer batch overtook this one while the digest was resolving.
  if (token !== bundleToken) return;

  const bundle = state.bundle;
  els.manifest.textContent = bundle?.manifest ? JSON.stringify(bundle.manifest, null, 2) : "";
  els.manifest.hidden = !bundle?.manifest;

  els.saveManifest.disabled = !bundle?.manifest;
  els.saveData.disabled = !bundle?.manifest;
  els.saveRequests.disabled = !bundle?.requests.length;

  els.countContract.textContent = bundle?.counts.observations ?? 0;
  els.stages[3].classList.toggle("is-live", Boolean(bundle?.counts.observations));
  els.bundleSummary.innerHTML = summaryMarkup(ready, bundle);
  els.blockers.innerHTML = bundle ? blockerMarkup(bundle.blockers) : "";
}

function summaryMarkup(ready, bundle) {
  if (!ready) {
    return `<p class="intake-hint">${escapeHtml(state.schemaError
      ?? "Loading the Gameplan contracts. Nothing can be exported until they are here to validate against.")}</p>`;
  }
  if (!bundle) return '<p class="intake-hint">Nothing staged.</p>';
  const { observations, requests, blocked } = bundle.counts;
  const parts = [
    `<strong>${observations}</strong> observation${observations === 1 ? "" : "s"}`,
    `<strong>${requests}</strong> identity request${requests === 1 ? "" : "s"}`,
  ];
  if (blocked) parts.push(`<strong>${blocked}</strong> blocked`);
  return `<p class="intake-hint">${parts.join(" \u00b7 ")}. Only a resolved identity with a registered source and a
    real observation clock crosses the boundary; everything else leaves as a search request.</p>`;
}

// Blockers are grouped by cause: forty rows failing the same contract rule are
// one problem with forty names, not forty problems.
function blockerMarkup(blockers) {
  if (!blockers.length) return "";
  const groups = new Map();
  for (const entry of blockers) {
    const group = groups.get(entry.code) ?? { ...entry, names: [] };
    if (entry.name) group.names.push(entry.name);
    groups.set(entry.code, group);
  }
  return [...groups.values()].map((group) => {
    const shown = group.names.slice(0, 6).join(", ");
    const rest = group.names.length > 6 ? ` and ${group.names.length - 6} more` : "";
    return `<div class="intake-blocker">
      <div class="intake-blocker-head">
        <span class="intake-tag review">${escapeHtml(group.field)}</span>
        <span class="intake-blocker-count">${group.names.length || 1}</span>
      </div>
      <p class="intake-blocker-message">${escapeHtml(group.message)}</p>
      <p class="intake-blocker-remedy">${escapeHtml(group.remedy)}</p>
      ${group.names.length ? `<p class="intake-blocker-names">${escapeHtml(shown + rest)}</p>` : ""}
    </div>`;
  }).join("");
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
  els.stages[0].classList.toggle("is-live", state.sources.length > 0);
  els.stages[1].classList.toggle("is-live", tally.total > 0);
  els.stages[2].classList.toggle("is-live", tally.resolved + tally.review > 0);
}

function clearBatch() {
  Object.assign(state, {
    rows: [], sources: [], batchId: null, assembledAt: null, editingRow: null, restored: null,
  });
  render();
  announce("Batch cleared.");
}

function renderRestored() {
  els.restored.hidden = !state.restored;
  if (!state.restored) return;
  const when = Date.parse(state.restored.at ?? "");
  const staged = Number.isNaN(when) ? "" : ` staged ${new Date(when).toLocaleString()}`;
  const { count } = state.restored;
  els.restored.innerHTML = `<span>Picked up where this browser left off: <strong>${count}</strong>
    candidate${count === 1 ? "" : "s"}${escapeHtml(staged)}. Nothing was re-read from any source.</span>
    <span class="intake-restored-actions">
      <button type="button" class="intake-button intake-button-sm" data-action="keep">Keep</button>
      <button type="button" class="intake-button intake-button-sm" data-action="discard">Discard</button>
    </span>`;
}

function render() {
  renderMeters();
  renderRestored();
  renderSources();
  renderRows();
  renderBundle();
  saveBatch();
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

// The single place a file is handed to the analyst. A data: URI keeps this
// free of Blob construction and object-URL lifecycle -- nothing binary is
// materialised, and there is no handle to leak.
function saveFile(filename, text, mime = "application/json") {
  const link = document.createElement("a");
  link.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  announce(`${filename} saved.`);
}

function exportManifest() {
  const bundle = state.bundle;
  if (!bundle?.manifest) return;
  saveFile(`${bundle.manifest.batch_id}.manifest.json`, `${JSON.stringify(bundle.manifest, null, 2)}\n`);
}

function exportData() {
  const bundle = state.bundle;
  if (!bundle?.manifest) return;
  saveFile(bundle.manifest.data_file, bundle.jsonl, "application/x-ndjson");
}

function exportRequests() {
  const bundle = state.bundle;
  if (!bundle?.requests.length) return;
  const document_ = buildRequestsDocument({
    requests: bundle.requests,
    batchId: state.batchId,
    knownAt: state.assembledAt,
  });
  saveFile(`${state.batchId}.identity-requests.json`, `${JSON.stringify(document_, null, 2)}\n`);
}

// The contracts are fetched rather than compiled in, so the page validates
// against the same vendored files the repo can audit against upstream.
async function loadSchemas() {
  const paths = {
    playerObservation: "./contracts/gameplan/player_observation.schema.json",
    batchManifest: "./contracts/gameplan/batch_manifest.schema.json",
    identityReferenceFacts: "./contracts/gameplan/facts/identity_reference.schema.json",
    depthChartFacts: "./contracts/gameplan/facts/depth_chart.schema.json",
  };
  try {
    const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path} responded ${response.status}`);
      return [key, await response.json()];
    }));
    state.schemas = Object.fromEntries(entries);
    state.schemaError = null;
  } catch (error) {
    state.schemas = null;
    state.schemaError = `The Gameplan contracts could not be loaded (${error.message}), so nothing can be validated or exported.`;
  }
  render();
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
    sourceList: document.querySelector("#intake-sources"),
    sourceCount: document.querySelector("#intake-source-count"),
    table: document.querySelector("#intake-table"),
    tbody: document.querySelector("#intake-tbody"),
    empty: document.querySelector("#intake-empty"),
    restored: document.querySelector("#intake-restored"),
    filters: document.querySelector("#intake-filters"),
    manifest: document.querySelector("#intake-manifest"),
    bundleSummary: document.querySelector("#intake-bundle-summary"),
    blockers: document.querySelector("#intake-blockers"),
    saveManifest: document.querySelector("#intake-save-manifest"),
    saveData: document.querySelector("#intake-save-data"),
    saveRequests: document.querySelector("#intake-save-requests"),
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

  restoreBatch();
  loadSchemas();

  els.restored.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "discard") clearBatch();
    else {
      state.restored = null;
      renderRestored();
    }
  });

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
    addSource({ kind: "url", label, bytes: null, mode: "deferred_upstream",
                note: "queued for upstream fetch", href: raw });
    els.url.value = "";
    render();
    announce("URL staged for the upstream fetcher.");
  });

  els.sourceList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='drop-source']");
    if (button) removeSource(button.dataset.source);
  });

  els.tbody.addEventListener("click", (event) => {
    const open = event.target.closest("[data-action='hint']");
    if (open) {
      state.editingRow = state.editingRow === open.dataset.row ? null : open.dataset.row;
      renderRows();
      els.tbody.querySelector(".intake-hint-form input")?.focus();
      return;
    }
    if (event.target.closest("[data-action='hint-cancel']")) {
      state.editingRow = null;
      renderRows();
      return;
    }
    const button = event.target.closest("[data-action='drop']");
    if (!button) return;
    state.rows = state.rows.filter((row) => row.id !== button.dataset.row);
    render();
  });

  els.tbody.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-hint-form]");
    if (!form) return;
    event.preventDefault();
    const row = state.rows.find((entry) => entry.id === form.dataset.hintForm);
    if (!row) return;
    const fields = new FormData(form);
    const outcome = applyAnalystHints(row, {
      team: fields.get("team"),
      position: fields.get("position"),
      note: fields.get("note"),
    });
    state.editingRow = null;
    render();
    announce(outcome);
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

  document.querySelector("#intake-clear-batch").addEventListener("click", clearBatch);

  els.saveManifest.addEventListener("click", exportManifest);
  els.saveData.addEventListener("click", exportData);
  els.saveRequests.addEventListener("click", exportRequests);

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
