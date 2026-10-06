# dsh-ocu-obu-mcp

Register [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use)
(`ocu`, desktop UI automation) and
[Open Browser Use](https://github.com/iFurySt/open-browser-use) (`obu`, real
Chrome automation) as stdio MCP servers in a DeepSeek Harness (DSH) profile — on
macOS, Linux, and Windows.

DSH's generic MCP client is the only integration point used. No first-class
computer-use provider slot is taken, so the tools show up as
`mcp__ocu__<tool>` and `mcp__obu__<tool>` alongside whatever else the profile
already loads.

> **Verification status.** Windows is verified end to end: installer, live tool
> calls from DSH, the turn-boundary hook, and a byte-exact install/uninstall
> round trip. On macOS the platform path mapping is validated against the real
> package contents, but **no macOS binary has been executed** — see
> [docs/macos-verification.md](docs/macos-verification.md) before trusting it on a
> Mac.

## Requirements

- Node.js 18 or newer (both npm packages require it; the installer uses it too).
- The two packages, installed globally so their bundled native binaries exist:

  ```sh
  npm install -g open-computer-use open-browser-use
  ```

- DSH already initialised at least once, so `~/.dsh/profiles/<name>/` exists.
- macOS: macOS 14.0 or later for the Open Computer Use runtime, plus
  Accessibility and Screen Recording permissions (granted once, below).
- Windows/Linux: a signed-in desktop session. Neither runtime works as a
  service or on a locked screen.

## Quick start

```sh
git clone <this repo> dsh-ocu-obu-mcp
cd dsh-ocu-obu-mcp
node scripts/install.mjs --dry-run   # print every planned change first
node scripts/install.mjs
```

The installer:

1. finds the npm global root (`npm root -g`, or `--npm-root`), and restores the
   executable bit on the binaries if a checkout or copy lost it;
2. **probes both servers over stdio** (`initialize` + `tools/list`) and refuses to
   continue unless each one identifies itself as the expected server — so a bad
   patch is never written;
3. tests each turn-boundary hook command and registers only the ones that work
   (below);
4. backs up the profile patch, then writes one managed block into
   `~/.dsh/profiles/<profile>/cordis.patch.yml`;
5. writes the hook config (unless `--no-turn-ended-hooks`);
6. copies the Open Computer Use skill into `~/.dsh/skills/`, which DSH scans as a
   user skill root.

It is idempotent: re-running after an `npm update -g` rewrites just that block
and touches nothing else. `--dry-run` prints the exact block and hook config it
would write, and writes nothing — though like a real run it still probes the
servers and hook commands, since their results decide what would be written.

Then confirm in DSH: ask for something that needs `mcp__obu__ping`, or call
`mcp__ocu__list_apps`. DSH reloads the profile when the patch changes; profiles
other than the running one may need a restart.

## What gets written

`serverName` is `ocu` / `obu`, matching the upstream convention, and each row
spawns the **bundled native executable by absolute path** rather than the npm
PATH shim — a GUI or background DSH launch need not inherit the installer's
`PATH`, and Node cannot spawn a `.cmd` shim without a shell.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| ocu executable | `dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse` | `dist/linux/<arch>/open-computer-use` | `dist/windows/<arch>/open-computer-use.exe` |
| obu executable | `native/darwin-<arch>/open-browser-use` | `native/linux-<arch>/open-browser-use` | `native/windows-<arch>/open-browser-use.exe` |
| `<arch>` | `arm64` on Apple Silicon, `amd64` on Intel | `amd64` / `arm64` | `amd64` / `arm64` |

`ocu` keeps `failOnStartupError: true` (its bundled executable is always
present), while `obu` leaves the default `false`: the obu MCP server starts
without Chrome, and a missing browser must not reject profile activation.

Whether a turn-boundary hook is registered is **not** decided by platform — see
below.

## Turn-boundary hooks

`dsh-mcp-client` never sends MCP's `notifications/turn-ended`, which is how both
runtimes normally clear their software cursor. The installer therefore maps DSH's
Stop point onto the CLIs through `@deepseek-ai/dsh-hooks-codex`, for example:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "\"<obu-path>\" turn-ended --session-id obu-mcp",
          "timeout": 15 }
      ] }
    ]
  }
}
```

**Registration is decided by what the build says it supports, not by whether the
command happens to succeed right now.** The installer reads each CLI's own command
list (`--help`) and registers a hook only when that build advertises `turn-ended`:

```
hook skipped  ocu turn-ended: this build's help does not list it
hook ok       obu turn-ended
hook note     obu turn-ended is registered, but running it now reported: socket not provided ...
```

The distinction between those two lines is the whole point. Whether a build *has*
`turn-ended` is static; whether running it *succeeds* is not — `obu turn-ended`
needs Chrome to be open, so deciding by execution would let a closed browser
silently delete a working hook from the config on the next re-run. A conditional
capability is reported as a `hook note` instead, and the hook stays registered.

Reading the command list is also the only reliable static check, because the
string `turn-ended` appears in *every* build — including the Windows Open Computer
Use binary that rejects the subcommand — as part of the MCP notification name
`notifications/turn-ended`. No platform list is hardcoded anywhere.

Two further details worth knowing:

- **The session id matters.** The obu MCP server owns the browser session
  `obu-mcp`; the CLI's own default is `obu-cli`. Passing the wrong one targets an
  empty tab group. Verified on Windows by opening a tab through MCP and listing
  both sessions — only `obu-mcp` saw it.
- **`turn-ended` is non-destructive.** Verified: it exits 0 and leaves session
  tabs open. Closing tabs remains an explicit `finalize_tabs` / `turn_ended` MCP
  call, so the hook cannot lose a tab the user still wants.

Use `--no-turn-ended-hooks` to skip the whole step.

## Platform setup after installing

**macOS**

```sh
"$(npm root -g)"/open-computer-use/dist/Open\ Computer\ Use.app/Contents/MacOS/OpenComputerUse doctor
"$(npm root -g)"/open-browser-use/native/darwin-arm64/open-browser-use setup
"$(npm root -g)"/open-browser-use/native/darwin-arm64/open-browser-use ping
```

`doctor` reports the Accessibility and Screen Recording state; grant both to
Open Computer Use once in System Settings → Privacy & Security.
`obu setup` registers the Chrome native messaging host and opens the extension
page — install the extension, restart Chrome if asked, then `ping` should report
the extension version.

**Windows**

```powershell
& "$env:APPDATA\npm\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe" doctor
& "$env:APPDATA\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe" setup
& "$env:APPDATA\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe" ping
```

**Linux** — needs a signed-in desktop session with AT-SPI2 / D-Bus for the
computer-use runtime; run `obu setup` the same way for the browser side.

## Options

| Option | Effect |
| --- | --- |
| `--profile <name>` | Patch this DSH profile. Default: `$DSH_PROFILE`, else the only profile present, else `desktop`, else `web`. |
| `--dsh-home <dir>` | Harness home. Default `$DSH_HOME` or `~/.dsh`. |
| `--npm-root <dir>` | npm global root, when `npm root -g` is unavailable or wrong. |
| `--ocu-command <path>` | Use a different Open Computer Use executable (for example a Homebrew or `.app` install). |
| `--obu-command <path>` | Same for Open Browser Use. |
| `--no-skill` | Do not copy the Open Computer Use skill. |
| `--force-skill` | Replace a local skill copy that differs from the package's. |
| `--no-turn-ended-hooks` | Register no turn-boundary hooks. |
| `--dry-run` | Print every planned change, write nothing. |
| `--uninstall` | Remove the managed block and hook config (the skill is left in place). |

`--uninstall` returns the patch to its exact pre-install content, which is
covered by a round-trip test.

## Troubleshooting

**The tools don't appear in DSH.** Check the block is in the patch DSH is
actually loading (`--dry-run` prints the resolved path), then look for an
activation error in the DSH log. A duplicate `serverName` is rejected by
`dsh-mcp-client`, which is why the installer refuses to add a second `ocu` or
`obu` row.

**A server stopped working after an upgrade.** Test it outside DSH:

```sh
node probe-mcp.mjs "$(npm root -g)/open-browser-use/native/darwin-arm64/open-browser-use" mcp
```

It prints the server identity and tool catalog. If that fails, the problem is the
package; if it succeeds, the problem is the profile or DSH.

**Every `obu` tool call fails with a socket error.** The message names it exactly:

```
socket not provided and active socket registry is unavailable; no connectable
socket found by scanning: ...\open-browser-use\active.json
```

This means Chrome is not running (or the extension is not loaded), not that the
registration is broken — the tools stay registered and start working again as soon
as Chrome is back. This is why the `obu` row leaves `failOnStartupError` at its
default: the MCP server starts without a browser, so a closed browser degrades the
tools instead of rejecting profile activation. Verify with the `obu ping` command
for your platform above; if it stays unreachable with Chrome open, `obu setup` was
not completed.

**macOS: the computer-use tools return nothing.** Grant Accessibility and Screen
Recording (System Settings → Privacy & Security), then re-run `doctor`. A
terminal-launched DSH and a GUI-launched DSH can hold different permission
grants, so grant to whichever process actually spawns the server.

## Repository layout

| Path | Purpose |
| --- | --- |
| `scripts/install.mjs` | Cross-platform installer; the single source of truth for the wiring. |
| `scripts/check-platforms.mjs` | Validates every platform's path mapping against the real package contents. |
| `scripts/lib/mcp-probe.mjs` | Dependency-free stdio MCP probe (initialize + tools/list). |
| `probe-mcp.mjs` | Thin CLI over the probe, for manual smoke tests. |
| `docs/macos-verification.md` | Checklist for first-run verification on a real Mac. |

## Relationship to the upstream installers

Open Computer Use ships `scripts/install-dsh-mcp.sh`, which handles macOS and
Linux. That script writes its own managed block and registers the invalid
Windows hook, and it cannot express the obu session-id fix. This installer
replaces it: same DSH MCP client, but platform-correct commands and hooks, and a
single block you can re-run safely.

If you run the upstream installer anyway, it will refuse to edit a patch that
already contains `mcp-open-computer-use` outside its own block. Run
`node scripts/install.mjs --uninstall` first if you want to hand the file back.
