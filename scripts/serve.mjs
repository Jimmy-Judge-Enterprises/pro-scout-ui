#!/usr/bin/env node
/**
 * Serve this site over http so it can be looked at before it is published.
 *
 * WHY THIS EXISTS
 *   index.html fetches ./data/*.json with relative paths, and fetch() is blocked
 *   under file:// by browser CORS, so the page cannot be opened from disk.
 *
 *   The README already pointed at `python3 -m http.server`, and that works: it
 *   contains itself to the working directory and maps .mjs to text/javascript, so
 *   the modules load. This does not replace a broken thing. What it adds is
 *   narrower than that:
 *
 *     - It runs on node, like every other script here. The repository has no
 *       package.json and no Python anywhere else in it.
 *     - It serves the page under the same Content-Security-Policy the deployed
 *       site should hold. http.server sends none, so a violation -- an inline
 *       script added later, a stylesheet pulled from a CDN -- loads fine locally
 *       and breaks once published. That is the one difference that changes what
 *       you see.
 *     - no-store, so a reload after an edit shows the edit rather than a 304.
 *     - Its containment is asserted by test/serve.test.mjs rather than assumed.
 *
 *   node scripts/serve.mjs        then open http://127.0.0.1:8788
 *   PORT=9000 node scripts/serve.mjs
 *
 * WHY IT IS DELIBERATELY BORING
 *   No dependencies. This repository has no package.json and every script in it
 *   runs on bare node; a preview server is a poor reason to make one necessary.
 *
 * WHY THE PATH HANDLING IS STRICT
 *   This repository is PUBLIC and the private Gameplan checkout sits beside it on
 *   disk. A static server that follows ../.. out of its root serves the neighbour,
 *   which holds owner identity, franchise state and the valuations the league
 *   competes on. Every request is resolved and checked to be inside the root,
 *   symlinks included, before anything is read.
 *
 *   None of that protects a machine on a hostile network, and it is not meant to.
 *   This binds to loopback and is a development tool.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 8788;

// An allowlist rather than a denylist: a new file type should be a deliberate
// addition, not something that starts being served because nobody thought about
// it. .mjs is here because the modules the page imports carry that extension and
// a browser will refuse a module served as anything but JavaScript.
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

/**
 * Resolve a request path to a file inside `root`, or null.
 *
 * Returns null rather than throwing, so the caller answers 404 and tells a
 * caller nothing about what exists outside the root.
 */
export function resolveWithinRoot(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestPath).split('?')[0].split('#')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Refuse backslashes outright rather than letting the platform decide. On
  // Windows a backslash is a separator and ..\..\ escapes the root; on Linux the
  // same string is an ordinary filename and resolves harmlessly inside it. The
  // sibling repository found this the hard way: a test written on Windows passed
  // there and failed in CI, because identical input meant different things. No
  // file here has a backslash in its name, so refusing is free.
  if (decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

/**
 * The same containment question asked of the real file.
 *
 * Checked separately from the string test above: a symlink pointing out of the
 * repository passes the textual check and still reads a file outside it.
 */
export async function realPathInsideRoot(candidate, root = ROOT) {
  const real = await fs.realpath(candidate);
  const rootReal = await fs.realpath(root);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return real === rootReal || real.startsWith(rootWithSep) ? real : null;
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end('method not allowed\n');
  }

  const requested = req.url === '/' ? '/index.html' : req.url;
  const candidate = resolveWithinRoot(ROOT, requested);
  if (candidate === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found\n');
  }

  const contentType = CONTENT_TYPES.get(path.extname(candidate).toLowerCase());
  if (!contentType) {
    res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('unsupported file type\n');
  }

  let real;
  try {
    real = await realPathInsideRoot(candidate);
  } catch {
    real = null;
  }
  if (real === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found\n');
  }

  let body;
  try {
    const stats = await fs.stat(real);
    if (!stats.isFile()) throw new Error('not a file'); // no directory listings
    body = await fs.readFile(real);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found\n');
  }

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    // no-store, so a reload after an edit shows the edit. A preview server that
    // caches is a preview server people stop trusting.
    'cache-control': 'no-store',
    // The page loads only its own files and reaches no network. Serving it under
    // the policy it should hold in production means a violation shows up here
    // rather than after it is public.
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    'x-content-type-options': 'nosniff',
  });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error\n');
    });
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  // Loopback only. This serves a repository directory from a development machine
  // and has no business accepting a connection from anywhere else.
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`pro-scout-ui: http://127.0.0.1:${port}/`);
    console.log(`serving ${ROOT}`);
  });
}
