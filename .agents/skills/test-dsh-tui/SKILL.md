---
name: test-dsh-tui
description: Use when testing or diagnosing any real terminal behavior in this repository's TUI, including startup, rendering, keyboard input, slash commands, autocomplete, dialogs, state retention, process continuity, or Profile plugin changes.
---

# Test the real DSH TUI

Test at the narrowest seam that proves the behavior, then use the packaged ConPTY harness when the claim depends on a live terminal, raw input, process identity, or assembled Profile.

## Safety boundary

Every live run uses a uniquely named `DSH_HOME` and a private DSH installation matching the version on PATH; the supplied runner enforces this and removes successful runs. Isolating only `DSH_HOME` is insufficient: DSH resolves bundle declarations from its installation before the profile, so a globally installed `omdsh` can otherwise shadow the tarball under test. Built-in fixtures perform no model request and write only inside that temporary root. The runner isolates DSH state, not the operating system: custom scenarios are trusted code and can access the repository, network, and parent process environment.

On PowerShell, name paths `$dshHome`; `$HOME` is a case-insensitive, read-only built-in. Every run installs tarballs into an isolated Profile. Source mode packs the current worktree; package mode accepts an existing `.tgz` and never treats a source directory as an installable package. A directory install becomes `link:`, which does not install bundle dependencies into the Profile root where Cordis resolves them.

## Choose the test seam

- Pure formatting, component behavior, key mapping, or state transition: add or run a focused `node:test` case.
- Real Loader composition without terminal input: use a Loader integration test such as `tests/reload.spec.ts`.
- Raw keyboard input, screen replacement, focus-sensitive flow, packaged exports, plugin discovery, or “same process” claims: use the ConPTY runner.
- Pixel/color appearance: combine the ConPTY screen snapshot with the relevant component width/theme tests. Text snapshots do not prove font rendering.

## Fast checks

From the repository root:

```powershell
pnpm run typecheck
pnpm exec node --disable-warning=ExperimentalWarning --test --experimental-transform-types "tests/<focused>.spec.ts"
```

Run `pnpm run check` before committing. Completion criterion: the focused behavior and every source-suite test pass.

## Live ConPTY tests

Choose the package under test explicitly:

- **Current source change** (default): omit `--tui-package`; the runner executes `pnpm pack` from `--project-root`.
- **Exact local/release artifact**: pass `--tui-package D:\path\yoke233-omdsh-x.y.z.tgz`; the runner skips source packing.
- **Composed local bundles**: repeat `--extra-bundle D:\path\plugin.tgz` for each bundle. They install after the TUI package into the same isolated Profile, which is the correct seam for integration.

The user's normal `tui` Profile is never reused or mutated. “Installed locally” and “source worktree” are separate inputs; compare them by running the same scenario once per package mode.

Run the packaged startup/help smoke scenario:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario smoke
```

Run the same autocomplete acceptance scenario against both package sources. The first command packs the current worktree; the second tests exactly the named archive:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario autocomplete
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs `
  --scenario autocomplete `
  --tui-package D:\packages\yoke233-omdsh-x.y.z.tgz
```

Autocomplete scenarios must call `tui.waitForSlashMenu()` after the welcome frame. Startup preset composition can replace the provider and cancel a menu request; a fixed sleep or the welcome text alone is not a readiness assertion. Completion criterion: both runs report `slashMenuReady`, the command-to-argument transition, the duplicate-hint assertion, and a stable DSH PID.

Run the network-free bang-shell scenario when leading-`!` parsing, platform shell execution, shell result cards, or model delivery changes:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario bang-shell
```

Completion criterion: the report records `shellCardRendered`, `resultVisibleToAgent`, `envelopeHidden`, and a stable DSH PID. Run it once from source and once against the exact tarball when changing packaged shell integration.

Run the supervisor-based reload acceptance scenario (starts the TUI under `scripts/omdsh.js`, asserts the dsh PID is REPLACED across `/reload` while the supervisor terminal process stays, changed installed plugin code takes effect, and the new generation resumes the same session):

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario reload-respawn
```

The `reload` and `reload-code` scenarios are retained only as historical fixtures of the abandoned in-process reload investigation (they assert a constant PID, the opposite of the shipped respawn contract). Do not treat them as current acceptance tests.

Run `--scenario settings-migration` after changing legacy settings import, native settings writes, or volatile TUI configuration. It checks the migrated prompt on the current screen, switches between `minimal` and `standard`, persists a theme change, and reads the migrated title model in `/settings` without replacing the DSH process.

Run the network-free, controlled-model scenario for running-turn input, immediate preview, and steer delivery:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario steer --keep-artifacts
```

The MJS runner builds and packs the current working tree, initializes an isolated `tui` Profile, starts real `dsh` in ConPTY, feeds input, and reconstructs the current terminal screen. With `--keep-artifacts`, it records raw output plus text/SVG/PNG snapshots and installs `sharp` for PNG conversion; `node-pty` and `@xterm/headless` live only in the temporary harness. Common key/token/secret environment variables are withheld from the TUI by default.

A successful JSON report is the acceptance artifact. For process-continuity scenarios, every observed DSH PID must be identical; a rendered success message alone is insufficient. Use `--allow-model-requests` only for an explicit real-model scenario that needs inherited credentials.

Use `--keep-artifacts` to generate and retain `pty-output.log`, `.txt`/`.svg`/`.png` screen snapshots, the packed package, and the isolated Profile:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario smoke --keep-artifacts
```

Run an already-built TUI archive with another local bundle:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs `
  --scenario smoke `
  --tui-package D:\packages\yoke233-omdsh-0.5.2.tgz `
  --extra-bundle D:\packages\dsh-prime-agent-0.5.0.tgz `
  --keep-artifacts
```

The JSON report records `packageSource`, the exact `tuiPackage`, and `extraBundles`, so artifacts cannot be mistaken for source-mode results.

Failed runs are retained automatically and print their artifact directory.

## Launcher/Profile bootstrap

Changes to `scripts/omdsh.js` installation, update, or repair behavior need a launcher bootstrap acceptance run in addition to packaged ConPTY scenarios:

1. Use a fresh isolated `DSH_HOME`; set `DSH_DEBUG=1` so `omdsh` completes bootstrap without leaving a TUI running.
2. Assert the Profile records `@yoke233/omdsh` as `file:<DSH_HOME>/profile-packages/tui/<package>.tgz`, not `link:` or a temporary path.
3. Assert packages named directly by `cordis.patch.yml` resolve under `<DSH_HOME>/profiles/tui/node_modules`; the plugin's source-worktree `node_modules` is not evidence.
4. Start the actual launcher in ConPTY and wait for the welcome screen, then stop its process tree. For a reported failure in the user's real Profile, repeat this final startup against that Profile after the isolated run passes.

Completion criterion: the persistent tarball remains present, the assembled plugin tree reaches the welcome screen, and no bootstrap process remains.


## Custom scenarios

When a built-in scenario does not cover the behavior, read [references/scenario-api.md](references/scenario-api.md), copy [scenarios/template.mjs](scenarios/template.mjs), and pass its path:

```powershell
node .agents/skills/test-dsh-tui/scripts/run-live-test.mjs --scenario C:\path\to\scenario.mjs --keep-artifacts
```

A scenario must assert observable behavior rather than merely sleep and exit. Prefer current-screen assertions for dialogs and replaced views, incremental-output assertions for transient notices, marker files for command execution, and PID comparison for process continuity.

## Manual operation

When reproducing against an already running TUI:

1. Record the DSH process PID.
2. Perform the external setup, such as installing a package with `dsh plugin --profile tui add <tarball>`.
3. Return to the same terminal and submit the relevant keys or slash command.
4. Assert both the terminal result and a second observable effect where practical.
5. Record the PID again and verify continuity when the behavior promises in-process state.
6. Exit with Ctrl+C twice and confirm the process tree is gone.

A running model turn intentionally blocks `/reload`; wait for the turn to settle before retrying.

## Linux branch

On Linux with `dsh` and `script` available, the repository also carries an opt-in launcher smoke test:

```sh
DSH_E2E=1 pnpm exec node --disable-warning=ExperimentalWarning --test --experimental-transform-types tests/e2e-smoke.spec.ts
```

## Failure triage

- Failure before the welcome screen: inspect `pty-output.log` for the complete plugin-tree error.
- Correct raw output but wrong current screen: assert with `screenText()` and inspect the saved snapshot; stale scrollback is not current UI state.
- Input has no effect: use `submit()` for a line, `key()` for raw control sequences, and wait for the welcome screen before sending input.
- Packaged import failure: check `package.json` exports, `cordis.patch.yml`, and prepare-build entries rather than source-only resolution.
- `ERR_MODULE_NOT_FOUND` from the Profile root for a package named in `cordis.patch.yml`: inspect the `@yoke233/omdsh` spec in the Profile's `package.json`. A `link:` spec is a broken bootstrap result; reinstall from a persistent packed `.tgz` and verify the dependency exists in the Profile root.
- A failed scenario automatically prints the last 80 lines of `pty-output.log`; start there before opening the full artifact. Installation failures print their own command log immediately.
- A Profile reinstall fails on a missing `file:` tarball for another plugin: repair that stale direct dependency first. Package archives referenced by Profile `package.json` must remain at their recorded paths.
- A rebuilt tarball keeps the same version and file path: verify the installed `node_modules/<package>` contains the changed code. pnpm may reuse the prior file package; remove the bundle and add the persistent tarball again when verification shows stale contents.
- Autocomplete is absent immediately after the welcome frame: use `waitForSlashMenu()` so provider replacement during startup cannot strand the first request. Once ready, drive text with `key()` and assert the current screen.
- PID changes: treat the test as failed even if the final command succeeds.
- A Profile package is installed but absent after reload: inspect the temporary Profile's `package.json` and `dsh.profile.bundles`.

## Reporting

Report the scenario, exact command, source-test totals, terminal assertions, observed PIDs, artifact location when retained, and cleanup status. Distinguish a source test from a packaged live test.
