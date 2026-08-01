// Checks the extension is internally consistent before it gets loaded or
// zipped: manifest parses, versions agree, every referenced file exists, and
// every script actually parses. No dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function fail(message) {
  problems.push(message);
}

function readJson(relative) {
  try {
    return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
  } catch (err) {
    fail(`${relative} is not valid JSON: ${err.message}`);
    return null;
  }
}

function requireFile(relative, why) {
  if (!relative) return;
  if (!existsSync(path.join(root, relative))) fail(`${why} points at a missing file: ${relative}`);
}

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');

if (manifest) {
  if (manifest.manifest_version !== 3) fail(`expected manifest_version 3, got ${manifest.manifest_version}`);

  for (const key of ['name', 'version', 'description', 'action', 'icons']) {
    if (!manifest[key]) fail(`manifest is missing "${key}"`);
  }

  if (pkg && manifest.version !== pkg.version) {
    fail(`manifest version ${manifest.version} does not match package.json version ${pkg.version}`);
  }

  requireFile(manifest.action?.default_popup, 'action.default_popup');
  requireFile(manifest.background?.service_worker, 'background.service_worker');

  for (const [size, file] of Object.entries(manifest.icons || {})) {
    requireFile(file, `icons.${size}`);
  }
  for (const [size, file] of Object.entries(manifest.action?.default_icon || {})) {
    requireFile(file, `action.default_icon.${size}`);
  }

  if (manifest.background && manifest.background.type !== 'module') {
    fail('background.type must be "module" because the worker uses imports');
  }
}

// The popup loads its entry point by path; catch renames of it too.
const popupPath = manifest?.action?.default_popup;
if (popupPath && existsSync(path.join(root, popupPath))) {
  const html = readFileSync(path.join(root, popupPath), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    requireFile(src, `${popupPath} script src`);
  }
}

const scripts = ['background.js', 'popup.js', 'lib/usage.js', 'lib/theme.js'];
for (const script of scripts) {
  if (!existsSync(path.join(root, script))) {
    fail(`expected script is missing: ${script}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', path.join(root, script)], { stdio: 'pipe' });
  } catch (err) {
    fail(`${script} failed to parse:\n${err.stderr?.toString().trim() || err.message}`);
  }
}

// A named import that does not exist only shows up at runtime, as a worker
// that silently fails to start. Resolve them here instead.
for (const script of ['background.js', 'popup.js']) {
  const file = path.join(root, script);
  if (!existsSync(file)) continue;

  const source = readFileSync(file, 'utf8');
  for (const [, names, from] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const target = path.join(root, path.dirname(script), from);
    if (!existsSync(target)) {
      fail(`${script} imports from a missing module: ${from}`);
      continue;
    }

    let module;
    try {
      module = await import(pathToFileURL(target).href);
    } catch (err) {
      fail(`${script} could not load ${from}: ${err.message}`);
      continue;
    }

    const wanted = names
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const missing = wanted.filter((name) => !(name in module));
    if (missing.length) fail(`${script} imports missing from ${from}: ${missing.join(', ')}`);
  }
}

if (problems.length) {
  console.error(`validate: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`validate: ok (${manifest.name} v${manifest.version})`);
