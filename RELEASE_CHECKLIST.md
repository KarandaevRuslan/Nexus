# GitHub release checklist

This repository uses GitHub Releases to distribute the **built CommonJS library as an npm `.tgz` archive**, while keeping `private: true` to prevent accidental publication to npm.

## One-time repository review

1. Confirm the copyright attribution in `LICENSE.md` and that the contributors have the right to release the code under MIT.
2. Review source files, history, and commits for secrets, private device identifiers, proprietary third-party code, and unverified target-specific Frida offsets. Publishing a new `.gitignore` does **not** erase already committed data or Git history.
3. Review all tracked media and generated reports before the first public push. **`.gitignore` only hides untracked files.** To untrack already committed files while keeping local copies, use `git rm --cached <path>`; to clean previously committed sensitive data from history, use a dedicated history-rewrite process before publishing.
4. Do not upload `graphs/`, `docs/verification/`, `docs/history/` and other development reports merely because they arrived in an agent-generated archive. The `.gitignore` suppresses new additions by default. Preserve only explicitly reviewed assets with `git add -f <path>`.
5. Confirm the intended repository visibility, owner, release notes, and which source modules are meant to be public.

## Cut a release

```bash
npm ci
npm run test:all
npm run check:release
npm pack --ignore-scripts
```

Inspect the package archive: it should contain `dist/src/` plus `package.json`, `README.md`, `ARCHITECTURE.md`, and `LICENSE.md`, and **no** sample Frida agent, screenshots, fixtures, or test artifacts.

Update `package.json` and `package-lock.json` together for a new release number, update `CHANGELOG.md`, and commit changes. Push the repository and an **annotated version tag** matching the package version (for example `v0.1.18`):

```bash
git tag -a v0.1.18 -m 'Nexus v0.1.18'
git push origin main
git push origin v0.1.18
```

The tag-triggered workflow repeats the test suite and package file check, then creates a GitHub Release and attaches the `.tgz` archive. It never invokes `npm publish`. Keep branch protection and require the CI check before merging changes.

## After release

Install the attached `.tgz` into a separate consumer project and test `require('nexus-prototype/core')`, `require('nexus-prototype/frida')`, and the TypeScript declarations. Do not describe real Frida integration as validated until the manual device tests in `scripts/e2e/README.md` have actually run.
