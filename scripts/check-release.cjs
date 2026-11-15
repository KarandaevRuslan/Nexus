#!/usr/bin/env node
'use strict';
/** Audit the npm tarball allowlist that GitHub Releases distribute. */
const { spawnNpmSync } = require('./run-npm.cjs');
const path = require('node:path');
const pkg = require('../package.json');

if (pkg.name !== 'nexus') {
  throw new Error('Expected package name nexus');
}
if (pkg.private !== true) {
  throw new Error('This release workflow is GitHub-only; package.json must remain private');
}
if (pkg.license !== 'MIT') {
  throw new Error('The declared package license must match LICENSE.md (MIT)');
}

const result = spawnNpmSync(['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
}

const packs = JSON.parse(result.stdout);
if (!Array.isArray(packs) || packs.length !== 1 || !Array.isArray(packs[0].files)) {
  throw new Error('Unexpected npm pack --json output');
}
const files = packs[0].files.map(item => item.path);
const allowedRoots = new Set(['package.json', 'README.md', 'LICENSE.md', 'ARCHITECTURE.md', 'assets/nexus-icon.png']);
const required = ['package.json', 'README.md', 'LICENSE.md', 'ARCHITECTURE.md',
  'assets/nexus-icon.png',
  'dist/src/index.js', 'dist/src/index.d.ts',
  'dist/src/core/index.js', 'dist/src/core/index.d.ts',
  'dist/src/frida/index.js', 'dist/src/frida/index.d.ts'];

const unexpected = files.filter(file => !allowedRoots.has(file) && !file.startsWith('dist/src/'));
const missing = required.filter(file => !files.includes(file));
if (unexpected.length || missing.length) {
  throw new Error([
    'Unsafe or incomplete release archive:',
    unexpected.length ? `Unexpected files: ${unexpected.join(', ')}` : '',
    missing.length ? `Missing files: ${missing.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
}
console.log(`PASS release package: ${files.length} whitelisted files; no test artifacts, agents, or unapproved images`);
