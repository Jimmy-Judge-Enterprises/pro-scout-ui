// Bare-node test of the preview server:
//   node test/serve.test.mjs
//
// Most of this is about containment. This repository is public and the private
// Gameplan checkout sits beside it on disk, so a server that follows ../.. out of
// its root serves the neighbour. The sibling repository's server had two bugs
// worth not repeating, and both are pinned here by name:
//
//   Backslash traversal. ..\..\ escapes the root on Windows and is an ordinary
//   filename on Linux. A test written on one platform passed there and failed in
//   CI on the other, because identical input meant different things. Backslashes
//   are refused outright and the assertion below does not depend on the platform
//   it runs on.
//
//   A check that inspected nothing. That server's scan swallowed read errors and
//   still reported OK, and its test used require() inside an ES module, so the
//   test passed having examined nothing at all. Every assertion here goes through
//   a real HTTP request against a real listening server.

import assert from "node:assert/strict";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

import { createServer, realPathInsideRoot, resolveWithinRoot } from "../scripts/serve.mjs";

// The REAL repository root, not a notional one. An invented root like "/repo"
// tests nothing on Windows, where path.resolve prefixes a drive letter and every
// comparison against the fake string fails for reasons that have nothing to do
// with containment. Resolving against the actual root also means the escape
// attempts below name the actual neighbour they must not reach.
const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// --- the string-level containment check ---------------------------------------------
const escapes = [
  "/../gameplan/config/source_authority.json",
  "/..%2f..%2fgameplan%2fREADME.md",
  "/data/../../pro-scout/players/00-0038977.json",
  "/%2e%2e/%2e%2e/etc/passwd",
  // Backslash forms. On Windows these separate directories; on Linux they are
  // filename characters. Refused either way, so this test means the same thing
  // wherever it runs.
  "/..\\..\\gameplan\\README.md",
  "/data\\..\\..\\gameplan",
  "/%2e%2e%5c%2e%2e%5cgameplan",
  // A NUL truncates the path in some filesystem APIs.
  "/index.html\0.png",
  // Malformed percent-encoding must not throw out of the resolver.
  "/%zz",
];
for (const attempt of escapes) {
  assert.equal(
    resolveWithinRoot(ROOT, attempt), null,
    `escaped the root: ${JSON.stringify(attempt)}`,
  );
}

const allowed = ["/", "/index.html", "/src/app.js", "/data/team-manifest.json", "/styles.css"];
for (const attempt of allowed) {
  const out = resolveWithinRoot(ROOT, attempt);
  assert.ok(out !== null, `refused a legitimate path: ${attempt}`);
  assert.ok(out.startsWith(ROOT), `${attempt} resolved outside the root: ${out}`);
}

// The backslash rule, pinned so it means the same thing on both platforms.
//
// The traversal cases above do NOT pin it. On Windows "..\..\gameplan" escapes
// the root and the containment check refuses it whether or not the backslash rule
// exists, so deleting that rule breaks nothing here and breaks CI on Linux -- the
// exact split this rule was written to prevent. A mutation test caught the gap.
//
// These paths would resolve INSIDE the root on both platforms, so containment has
// no opinion about them. Only the backslash rule can refuse them, which makes the
// assertion independent of where it runs.
for (const benign of ["/src\\app.js", "/data\\team-manifest.json", "/a\\b"]) {
  assert.equal(
    resolveWithinRoot(ROOT, benign), null,
    `a backslash path must be refused outright, not left to the platform: ${benign}`,
  );
}

// The symlink guard, exercised directly rather than by creating a link.
//
// Creating one needs privileges on Windows, so the test would skip on the machine
// this is developed on and run only in CI -- a check that is absent exactly where
// it is being written. realPathInsideRoot is exported so the question can be asked
// of a real path instead.
{
  const outside = resolve(ROOT, "..");
  assert.equal(
    await realPathInsideRoot(outside, ROOT), null,
    "the parent directory resolved as inside the root; a symlink out would be followed",
  );
  const inside = join(ROOT, "index.html");
  assert.ok(
    await realPathInsideRoot(inside, ROOT),
    "a file plainly inside the root was refused",
  );
}

// "....//" is NOT traversal here, and asserting that it is would be testing a
// defence this server does not use. It defeats sanitizers that strip "../"
// textually -- stripping turns "....//" into "../" -- but this resolves the path
// instead of editing it, so the segment is a directory literally named "....".
// It stays inside the root and 404s because no such directory exists.
{
  const dots = resolveWithinRoot(ROOT, "/....//gameplan");
  assert.ok(dots !== null && dots.startsWith(ROOT + sep),
    "a literal '....' segment should resolve inside the root, not escape");
}

// The query string and fragment are not part of the path.
assert.equal(resolveWithinRoot(ROOT, "/index.html?v=2"), resolveWithinRoot(ROOT, "/index.html"));
assert.equal(resolveWithinRoot(ROOT, "/index.html#top"), resolveWithinRoot(ROOT, "/index.html"));

// --- against a real listening server -------------------------------------------------

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** A request line written verbatim, so nothing normalizes it on the way out. */
function rawGet(path_) {
  return new Promise((resolveRaw, reject) => {
    const socket = connect(server.address().port, "127.0.0.1", () => {
      socket.write(`GET ${path_} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolveRaw(data));
    socket.on("error", reject);
  });
}

async function get(path_, options) {
  const response = await fetch(base + path_, options);
  return { status: response.status, type: response.headers.get("content-type"),
    csp: response.headers.get("content-security-policy"),
    cache: response.headers.get("cache-control"),
    body: await response.text() };
}

try {
  // Everything the page needs must actually arrive, with a type a browser accepts.
  const index = await get("/");
  assert.equal(index.status, 200, "the site root did not serve index.html");
  assert.match(index.type, /text\/html/);
  assert.ok(index.body.includes('src="./src/app.js"'), "index.html is not the real page");

  for (const [path_, pattern] of [
    ["/styles.css", /text\/css/],
    ["/src/app.js", /javascript/],
    // .mjs matters: a browser refuses a module served as anything but JavaScript,
    // and three of this page's modules carry that extension.
    ["/src/presence.mjs", /javascript/],
    ["/src/team-analysis.mjs", /javascript/],
    ["/data/team-manifest.json", /application\/json/],
    ["/data/player-manifest.json", /application\/json/],
  ]) {
    const response = await get(path_);
    assert.equal(response.status, 200, `${path_} returned ${response.status}`);
    assert.match(response.type, pattern, `${path_} served as ${response.type}`);
    assert.ok(response.body.length > 0, `${path_} served empty`);
  }

  // The manifests the page reads are the real ones, not a fixture.
  const teams = JSON.parse((await get("/data/team-manifest.json")).body);
  assert.equal(teams.teams.length, 32, "the served team manifest is not the repository's");

  // Traversal over the wire, sent RAW.
  //
  // fetch() normalizes the URL before it goes out -- "/../README.md" leaves as
  // "/README.md" -- so testing traversal through it tests the client's URL parser
  // and not this server. An attacker writes the request line himself, so these do
  // too, straight down a socket.
  for (const attempt of [
    "/../README.md",
    "/../../gameplan/README.md",
    "/data/../../pro-scout/README.md",
    "/..%2f..%2fgameplan%2fREADME.md",
    "/..\\..\\gameplan\\README.md",
  ]) {
    const raw = await rawGet(attempt);
    assert.ok(
      / (404|415) /.test(raw.split("\r\n")[0] + " "),
      `${attempt} answered: ${raw.split("\r\n")[0]}`,
    );
    for (const marker of ["Gameplan", "KCFFL", "OWNER-"]) {
      assert.ok(!raw.includes(marker), `${attempt} served content from outside the root`);
    }
  }

  // A file inside the root but not on the allowlist is refused by type, so a
  // stray private file dropped into the directory is not served by accident.
  assert.equal((await get("/README.md")).status, 415, "an unlisted extension was served");

  // No directory listings.
  assert.equal((await get("/src")).status, 415);
  assert.equal((await get("/src/")).status, 415);

  // Headers that must not regress.
  assert.match(index.csp ?? "", /default-src 'self'/, "the page is served without a CSP");
  assert.equal(index.cache, "no-store", "a preview server that caches stops being trusted");

  // Read-only.
  assert.equal((await get("/index.html", { method: "POST" })).status, 405);
  assert.equal((await get("/index.html", { method: "HEAD" })).status, 200);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("serve tests passed: containment holds, every asset the page needs is served");
