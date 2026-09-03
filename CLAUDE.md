# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Written by Claude Code, from a session that built the intake canvas and its
boundary gate. It records what cost time to learn, not what the README already
says — read `README.md` first for what the app is and what crosses the
production boundary.

## This repo is downstream of two others

Almost nothing under `data/` or `contracts/` is authored here, and treating
either as editable is the most expensive mistake available.

- **`data/*.json` are generated upstream.** Each carries
  `generated_by: pro-scout/scripts/build-ui-manifests.mjs`. Fix a wrong row in
  pro-scout and rebuild; a hand-edit here is overwritten on the next sync and
  hides the real defect in the meantime.
- **`contracts/` are vendored copies.** Gameplan's provider contracts arrive
  through pro-scout; `contracts/pro-scout/team-aliases.json` is pro-scout's club
  map; `src/vendor/jsonschema.js` is upstream's validator.
  `scripts/verify-contracts.mjs` recomputes a SHA-256 per file against
  `contracts/VENDORED.json` and fails on any drift. To change one, change it
  upstream, re-copy, and refresh the hashes — never edit in place.

The chain is **gameplan → pro-scout → pro-scout-ui**. A club code, a fact
domain, or a required field originates at the left and is copied rightward.

## Commands

No dependencies, no test framework, no build step. Node 22 in CI.

```sh
node scripts/serve.mjs              # http://127.0.0.1:8788 (PORT= to change)
node test/contract.test.mjs         # run one suite — each file is standalone
```

`.github/workflows/checks.yml` is the authoritative list; `README.md` spells out
what each check is for. Keep the two in step — a suite that exists but is not in
the workflow does not run.

Serving matters: the page fetches manifests and contracts by relative path, so
`file://` fails. Prefer `scripts/serve.mjs` over any static server — it applies
the deployed Content-Security-Policy, so an inline script or CDN stylesheet
fails locally instead of after publication.

## Where code is allowed to live

`src/intake.js` touches browser globals at module scope, so **importing it in
bare node throws `window is not defined`** — and `src/app.js` fails the same way
purely because it imports `intake.js`. Every other module under `src/` imports
cleanly, which is not an accident:

    node -e "import('./src/intake.js')"    # THROWS
    node -e "import('./src/contract.js')"  # ok — and so is every other sibling

That is the whole file layout. Each piece of logic a test needs —
`presence.mjs`, `table-sort.mjs`, `team-analysis.mjs`, `anatomy-panel.mjs`,
`team-aliases.mjs` — is a sibling module that `app.js` consumes and does nothing
further to. `src/contract.js` is the same idea for the canvas: pure, DOM-free,
and the entire boundary gate. `src/intake.js` is the DOM half.

New logic goes in a sibling module. Logic added inside `app.js` or `intake.js`
is logic that cannot be tested in CI.

## Two alias tables, deliberately

`src/team-aliases.mjs` splits the map because the two consumers match
differently, and merging them reintroduces a bug the tests pin:

- **`LOCAL_ALIASES`** (exposed as `identityAliases()`) is token-matched, so
  the extractor may use it.
- **`SEARCH_ALIASES`** (nicknames, city names) is whole-query only. `dallas`,
  `washington` and `kc` are also parts of real player names in the manifest, so
  a token-matched nickname eats the player. The test fails if one ever becomes
  token-matchable.

Which club codes collide with a real given name is **read from the manifest at
load**, never listed — so a future signing fixes itself. `KC Concepcion` is why.

The module declares only the relocations and provider spellings this repo owns
and adopts the rest from the vendored map at load. `test/team-aliases.test.mjs`
asserts the *absence* of vendored codes before adoption: if one resolves early,
it has been restated locally and the two can now disagree.

## Rules the code encodes

Breaking any of these silently produces output that looks fine and is wrong.

- **A hint discriminates; it never establishes identity.** A hint contradicting
  the canonical index withdraws the `gsis_id` and stops the row. It does not
  override.
- **Every hint carries a basis**: `observed` (the source stated it beside the
  player), `document` (a file header — describes the document, not the player)
  or `analyst` (typed here). **Only `observed` values may become facts.** A team
  from a header never becomes an identity fact: rosters go stale.
- **A normalisation must not destroy what it normalised.** A club code keeps the
  source's spelling beside it (`team_hint_as_written`) — a relocation spelling is
  what tells a downstream search the source is stale.
- **Absence is reported as absence.** Never echo a derived value into a field the
  source left empty; that makes an inference look like an observation.
- **The gate refuses rather than fills.** Each blocker names a field and a
  remedy: `gsis_invalid`, `source_unregistered`, `observed_at_unknown`,
  `observed_at_not_datetime`, `facts_invalid`, `observation_invalid`,
  `batch_spans_sources`, `manifest_invalid`.
- **A run of name tokens breaks on a club code, except when it doesn't.** An
  ordinary word or a colliding club code joins a name run only when a hard name
  token follows it (`SOFT_STOP` in `intake.js`). Adding a plain stopword drops
  real players — "Will Kacmarek" is why.

## No sample data, anywhere

This is a governance rule inherited from pro-scout, not a style preference:
observed facts, derived values and estimates must stay distinguishable, and
missing evidence must stay missing. Tests read every `gsis_id` and name from
`data/player-manifest.json` rather than inventing one. Do not add fixture
players, placeholder rows, or `e.g.` values in UI placeholders. A temp-dir
fixture that is deleted and never persisted is fine; anything reaching the repo
or a batch is not.

Also avoid Blobs and object URLs — `saveFile` builds a `data:` URI so nothing
binary is materialised and there is no handle to leak.

## When changing the canvas, verify in a browser

`test/contract.test.mjs` covers the boundary rules, but extraction, hint capture
and rendering only run in a page. Start `scripts/serve.mjs`, drive the real page
with Playwright, and read the row state out of
`localStorage['pro-scout-ui.intake-batch']` — that is how a bundler-dropped
import and a broken team search were both caught after the node suites were
green. (In the Claude Code web container, Chromium is pre-installed under
`/opt/pw-browsers`; do not run `playwright install`.)
