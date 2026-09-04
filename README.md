# Pro-Scout UI

The reporting and intake surface for [pro-scout](https://github.com/Jimmy-Judge-Enterprises/pro-scout),
served as a static site from GitHub Pages at `pro-scout.io`.

The page holds no credentials and calls no API. It reads two manifests published
by the upstream repo, and every write leaves through a route a person
authenticates themselves: a downloaded file, or a prefilled GitHub issue.

## Views

- **Teams** and **Players** browse the manifests in `data/`, showing each record's
  capture status, provenance and freshness. Freshness is derived at render time,
  never baked in: a record with no capture date is "unavailable", not assumed fresh.
- **Capture** requests one player by name through the upstream `player-intake` issue form.
- **Intake** is the canvas — batches, rather than one player at a time.

## The intake canvas

Text, tables, transcripts and saved pages are read in the browser: roster columns,
comma lists, cue files, list markup and JSON, with position and team hints taken
from the same line or from the shape of the document. Images, video and URLs are
staged as sources and marked for the upstream pipeline, where OCR, transcription
and fetching actually run. Work the page cannot do, it does not fake.

Names resolve against the manifests the console already loads. An exact hit carries
its real GSIS id; a near miss becomes a question with candidates; anything unknown
leaves as a resolution request.

### What crosses the production boundary

`player_observation` requires a canonical `gsis_id`, so a name without one can never
travel in the observation feed. Two artifacts leave, and they are never mixed:

| | contents |
| --- | --- |
| `<batch_id>.manifest.json` + `<batch_id>.jsonl` | observations, resolved identities only |
| `<batch_id>.identity-requests.json` | searches for names with no proven identity |

The export gate refuses rather than fills. A capture that declares no provider has
no `source_id` registered with Gameplan. A capture that records when it was checked
but not when its source asserted anything has no `observed_at`, and padding a bare
date to midnight would claim a precision no source gave. A null depth is not
`depth_order: 1`; it is a different fact domain. Each refusal names the field and
the remedy, and a batch spanning two providers is refused outright because one
manifest describes one source.

### Hints

A hint discriminates between candidates the index already holds. It never
establishes identity, and one that contradicts the canonical index stops the row
rather than overriding it — the `gsis_id` is withdrawn and the disagreement travels
with the request.

Provenance follows every hint. A team named in a document header describes the
document, not the player, so it is marked `document` and never becomes an identity
fact — a chart can still list a player who has moved. A value typed into the canvas
is marked `analyst`: it reaches the request and the issue form, and nothing else.

### Batch memory

A batch survives a reload in the browser that made it. It is per viewer, never
shared and never a source. An identity is stored as its id and rehydrated from the
current index, so a match cannot outlive the manifest that proved it; a restored
batch says so rather than passing for a fresh read.

## Contracts

`contracts/gameplan/` holds Gameplan's provider contracts, vendored through
pro-scout; `contracts/pro-scout/team-aliases.json` is pro-scout's club-code alias
map; `src/vendor/jsonschema.js` is the validator upstream CI uses. They are
copies, not sources: upstream owns them and this repo never edits them.
`contracts/VENDORED.json` records the upstream commits and a SHA-256 per file.

The alias map is the only place the codes it declares enter this repo. The
module carries the relocations and provider spellings owned here and adopts the
rest at load, so a value cannot disagree with itself.

## Checks

No dependencies and no test framework, the same way pro-scout runs its own:

```sh
node scripts/verify-contracts.mjs   # vendored contracts are byte-identical
node test/contract.test.mjs         # the boundary rules built on them still hold
node test/team-aliases.test.mjs     # aliases point at teams the manifest carries
node test/player-table.test.mjs     # held and available partition one row shape
node test/team-analysis.test.mjs    # every finding derived, none of them a judgement
node test/table-sort.test.mjs       # sorting handles absent values
node test/anatomy-panel.test.mjs    # gauges computed from a real cohort, or not drawn
node test/serve.test.mjs            # the preview server stays inside its root
```

Both run in CI on every push. The tests fabricate no identities — every `gsis_id`
and name they use is read from this repo's own player manifest.

## Running locally

The page fetches its manifests and contracts by relative path, so `file://` will
not do — it needs to be served.

```sh
node scripts/serve.mjs        # http://127.0.0.1:8788
PORT=9000 node scripts/serve.mjs
```

Any static server works, `python3 -m http.server 8000` included. The reason to
prefer this one is that it serves the page under the same Content-Security-Policy
the published site should hold, so a violation — an inline script, a stylesheet
pulled from a CDN — shows up here instead of after it is public. It also sends
`no-store`, so a reload after an edit shows the edit, and it runs on node like
everything else here.

It binds to loopback and refuses anything resolving outside the repository,
symlinks included: the private Gameplan checkout sits beside this one on disk.
`test/serve.test.mjs` asserts that rather than trusting it.
