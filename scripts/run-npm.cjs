#!/usr/bin/env node
'use strict';
/**
 * Invoke npm through Node rather than spawning `npm` / `npm.cmd`.
 * On Windows, the npm executable is a .cmd wrapper; spawnSync('npm', ...)
 * with shell: false may fail with ENOENT even when `npm` works in PowerShell.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findNpmCli() {
  const nodeBin = path.dirname(process.execPath);
  const candidates = [
    // npm run automatically supplies this absolute path.
    process.env.npm_execpath,
    // Official Node.js Windows installation layout.
    path.join(nodeBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Typical Node.js Unix installations (nvm, official tarballs).
    path.resolve(nodeBin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(candidate =>
    typeof candidate === 'string' && /\.[cm]?js$/i.test(candidate) && fs.existsSync(candidate)
  );
  if (!cli) {
    throw new Error(
      'Could not locate npm-cli.js. Run this script via `npm run ...` ' +
      'or install Node.js with npm (npm_execpath is not available).'
    );
  }
  return cli;
}

function spawnNpmSync(args, options = {}) {
  return spawnSync(process.execPath, [findNpmCli(), ...args], {
    ...options,
    shell: false,
  });
}

module.exports = { spawnNpmSync };
