#!/usr/bin/env node
'use strict';
/**
 * Pack the public Nexus distribution and install those exact files into the two
 * example consumers. This intentionally does NOT symlink ../src or the repo root.
 * No external npm registry access is required for the consumer smoke tests.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnNpmSync } = require('./run-npm.cjs');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const file = `nexus-${pkg.version}.tgz`;
const tarball = path.join(root, file);
const examples = ['c-ast', 'dining-philosophers'];

function run(command, args, cwd) {
  const options = { cwd, stdio: 'inherit', shell: false };
  const result = command === 'npm'
    ? spawnNpmSync(args, options)
    : spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

for (const name of examples) {
  // Guard against examples accidentally bypassing the distributable API.
  const sources = [path.join(root, name, 'nexus')];
  let imported = false;
  while (sources.length) {
    const dir = sources.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) sources.push(filename);
      else if (filename.endsWith('.ts')) {
        const code = fs.readFileSync(filename, 'utf8');
        if (/from\s*['"](?:\.\.\/)+src\//.test(code)) {
          throw new Error(`${filename} imports Nexus source directly; use nexus/core`);
        }
        if (/from\s*['"]nexus\/core['"]/.test(code)) imported = true;
      }
    }
  }
  if (!imported) throw new Error(`${name} never imports nexus/core`);
  const consumer = require(path.join(root, name, 'package.json'));
  const expected = `file:../${file}`;
  if (consumer.dependencies?.nexus !== expected) {
    throw new Error(`${name} must depend on ${expected}, got ${consumer.dependencies?.nexus}`);
  }
}

// Always pack the current build so stale tarballs cannot mask API regressions.
run('npm', ['pack', '--ignore-scripts', '--pack-destination', root], root);
if (!fs.existsSync(tarball)) throw new Error(`Missing tarball: ${tarball}`);

for (const name of examples) {
  const target = path.join(root, name, 'node_modules', 'nexus');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  // npm's package tarballs contain a single top-level package/ directory.
  run('tar', ['-xzf', tarball, '--strip-components=1', '-C', target], root);
  const packed = require(path.join(target, 'package.json'));
  if (packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error(`Wrong package unpacked at ${name}: ${packed.name}@${packed.version}`);
  }
  // The subprojects resolve this by its published name, never ../src/core.
  require.resolve('nexus/core', { paths: [path.join(root, name)] });
  console.log(`Prepared ${name} against packed ${packed.name}@${packed.version}`);
}
