# macOS verification checklist

The macOS path in [scripts/install.mjs](../scripts/install.mjs) is written from
each package's own platform layout and from the upstream installer, but it has
**not been executed on real hardware**. Windows is the only platform verified so
far.

This page exists so the first Mac run produces a useful result rather than a
vague failure: work the steps in order, record what actually happened, then fix
the script or rewrite the affected section of the README with what was observed.

## Before you start

```sh
node --version                 # must be >= 18
sw_vers -productVersion        # Open Computer Use needs macOS 14.0+
npm install -g open-computer-use open-browser-use
npm root -g                    # note this: it differs per architecture and manager
```

Note which of these applies, because the resolved paths depend on it:

| Installer | Typical `npm root -g` |
| --- | --- |
| Homebrew, Apple Silicon | `/opt/homebrew/lib/node_modules` |
| Homebrew, Intel | `/usr/local/lib/node_modules` |
| nvm / fnm / volta | `~/.nvm/versions/node/<version>/lib/node_modules` |
| Standalone pkg | `/usr/local/lib/node_modules` |

## Step 1 — probe each server outside DSH

Do this before running the installer, so a package problem cannot be mistaken for
an installer problem:

```sh
node probe-mcp.mjs "$(npm root -g)/open-browser-use/native/darwin-arm64/open-browser-use" mcp
node probe-mcp.mjs "$(npm root -g)/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse" mcp
node scripts/check-platforms.mjs
```

`check-platforms.mjs` reads the installed packages directly and confirms that the
path the installer would use on macOS exists — the npm packages ship every
platform's binary, so this works even before you have a Mac. It does **not** prove
that a macOS binary runs.

| Check | Expected | Observed |
| --- | --- | --- |
| obu identity | `open-browser-use`, 19 tools | |
| ocu identity | `open-computer-use`, 9 tools | |
| Executable bit | both run without `chmod`; installer restores it if missing | |

Use `darwin-amd64` instead of `darwin-arm64` on Intel.

## Step 2 — dry run the installer

```sh
node scripts/install.mjs --dry-run
```

Confirm before anything is written:

- [ ] `platform` reports `macOS (darwin/arm64)` or `(darwin/x64)`
- [ ] `npm root` matches `npm root -g`
- [ ] `profile patch` points at the profile DSH actually loads
- [ ] both `probe ok` lines report the expected server names and 9 / 19 tools
- [ ] record the `hook ok` / `hook skipped` verdict line for each of the two
      candidates

The hook decision is read from each CLI's own command list, not from running the
command, so it does not depend on Chrome or on permissions being ready yet. The
expected output is:

```
hook ok       ocu turn-ended
hook ok       obu turn-ended
```

On Windows the same step prints
`hook skipped  ocu turn-ended: this build's help does not list it`, which is
correct there. **Expect `ocu turn-ended` to be listed on macOS** — the upstream
installer registers that hook — but note that the string `turn-ended` also occurs
inside the MCP notification name `notifications/turn-ended`, so its presence in
the Mach-O binary proves nothing either way.

A `hook note` line means the hook was registered but the command did not succeed
at that moment, which is expected before Chrome and the permissions are ready:

```
hook note     obu turn-ended is registered, but running it now reported: ...
```

If `ocu turn-ended` is reported as **skipped** on macOS, that is a finding: record
the reason line and fall back to `--no-turn-ended-hooks` until the cursor behavior
is understood.

To check by hand:

```sh
"$(npm root -g)/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse" --help   # must list turn-ended
"$(npm root -g)/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse" turn-ended
echo $?   # expect 0
```

## Step 3 — permissions and Chrome

```sh
OCU="$(npm root -g)/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse"
OBU="$(npm root -g)/open-browser-use/native/darwin-arm64/open-browser-use"
"$OCU" doctor
"$OBU" setup        # registers the native messaging host, opens the extension page
"$OBU" ping         # expect the extension id and version
```

| Check | Expected | Observed |
| --- | --- | --- |
| `doctor` before granting | reports missing Accessibility / Screen Recording | |
| After granting both | `doctor` reports both granted | |
| `setup` | native messaging host registered, extension page opens | |
| `ping` | extension id + version, matching `obu --version` | |

Grant permissions to **whichever process spawns the server**: a GUI-launched DSH
and a terminal-launched DSH can hold different grants.

## Step 4 — install and drive it from DSH

```sh
node scripts/install.mjs
```

Then, in DSH:

| Check | Expected | Observed |
| --- | --- | --- |
| `mcp__obu__ping` | `pong` | |
| `mcp__obu__open_tab` + `page_info` | reads a page, tab group named | |
| `mcp__ocu__list_apps` | lists running apps | |
| `mcp__ocu__get_app_state` on a real app | accessibility tree + screenshot | |
| `finalize_tabs` / `turn_ended` | session tabs closed | |
| End of turn | software cursor disappears (hooks active) | |

## Step 5 — re-run and uninstall

Both directions matter, because the block is regenerated in place:

- [ ] `node scripts/install.mjs` again prints `already current` for the patch,
      hooks, and skill, and creates no new backup
- [ ] `node scripts/install.mjs --uninstall` restores the patch byte-for-byte to
      its pre-install content and deletes `~/.dsh/ocu-obu-hooks.json`
- [ ] re-installing after that returns the identical block

## Known unknowns on macOS

These are the places the current implementation is most likely to need a change:

1. **`ocu turn-ended` semantics.** The installer will test whether it exits 0, but
   whether it actually hides the software cursor — its purpose on macOS — is only
   observable by watching the screen at the end of a turn.
2. **`.app` bundle as a stdio server.** DSH spawns
   `Contents/MacOS/OpenComputerUse mcp` directly. The upstream installer does the
   same, but no spawn through DSH has been observed on macOS.
3. **Executable bits.** npm usually preserves them for these prebuilt binaries;
   the installer repairs them if not. Confirm no `chmod` was needed.
4. **Gatekeeper.** A binary fetched by npm is normally not quarantined, but the
   `.app` bundle may be flagged on first run. Record any prompt verbatim.
5. **Permission attribution.** Whether the grant sticks to the `.app` bundle or to
   the spawning process determines whether DSH must be launched the same way
   every time.
6. **Intel vs Apple Silicon paths.** `darwin-amd64` vs `darwin-arm64` is selected
   from `process.arch`; confirm on both if possible.

## Recording results

Report the outcome as: which step failed, the exact command, the exact output,
and the macOS version plus `npm root -g`. That is enough to fix the script
without guessing — and then move the verified claims out of this file and into
the README's platform table.
