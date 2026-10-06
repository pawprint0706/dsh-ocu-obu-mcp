# DSH + Open Computer Use / Open Browser Use

Both upstream MCP servers are registered in the DSH `desktop` profile and were
verified live in a running DSH session (no app restart required — the cordis
loader watches the profile patch).

| Upstream | npm package | Tools in DSH | Verified |
| --- | --- | --- | --- |
| [open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) | `open-computer-use@0.3.6` (CLI `ocu`) | `mcp__ocu__*` (9 tools) | `list_apps` returned the live desktop app list |
| [open-browser-use](https://github.com/iFurySt/open-browser-use) | `open-browser-use@0.1.42` (CLI `obu`) | `mcp__obu__*` (19 tools) | `ping` -> `pong`, then `open_tab` / `wait_load` / `page_info` on example.com, tab finalized |

## Where the configuration lives

`~/.dsh/profiles/desktop/cordis.patch.yml` — the `# >>> ocu / obu MCP servers`
block, appended after the existing `dsh-web-search` managed block.

Both rows use `@deepseek-ai/dsh-mcp-client` with `transport: stdio`, and point at
the **absolute path of the bundled native executable** rather than the npm PATH
shim, because:

- a GUI/background launch does not necessarily inherit the installer's `PATH`;
- Node cannot spawn a `.cmd` shim directly without a shell.

| Server | Command | Key settings |
| --- | --- | --- |
| `ocu` | `%APPDATA%\npm\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe` (`mcp`) | `toolCallTimeoutMs: 300000`, `failOnStartupError: true` |
| `obu` | `%APPDATA%\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe` (`mcp`) | `toolCallTimeoutMs: 180000`, `failOnStartupError` default (`false`) |

A timestamped backup of the patch file from before this change sits next to it as
`cordis.patch.yml.bak-<timestamp>`.

## Windows-specific decisions

1. **No OCU `Stop` hook.** Upstream `scripts/install-dsh-mcp.sh` also registers a
   turn-boundary hook running `<exe> turn-ended`, to hide OCU's software cursor.
   The Windows build exposes no `turn-ended` subcommand — only
   `mcp`, `doctor`, `list-apps`, `snapshot`, `call`, `help`, `version` — so the
   hook fails on every turn end here. It was deliberately omitted instead of
   carried over broken.
2. **No OBU `Stop` hook.** `obu turn-ended` exists on Windows, but its CLI
   defaults to session id `obu-cli`, which is not the session the MCP server
   uses, so a hook would target the wrong tab group. Browser cleanup is done
   through the `finalize_tabs` and `turn_ended` MCP tools instead.
3. `failOnStartupError` is left at its default for OBU: the MCP server starts
   fine without Chrome, and a missing browser must not reject profile
   activation. OCU keeps upstream's `true`, since its bundled executable is
   always present.
4. Both runtimes need a **signed-in desktop session** (UI Automation for OCU,
   the Chrome extension for OBU); neither works as a service or on a lock screen.

Re-running the upstream OCU installer will refuse to edit the patch, because
`mcp-open-computer-use` already exists outside its managed block. Delete those
rows first if you want the installer to take over the file.

## The OCU skill

`skills/open-computer-use/` from the npm package was copied to
`~/.dsh/skills/open-computer-use` (a DSH user skill root, discovery rank 400), so
sessions get usage, installation, and troubleshooting guidance for the
`mcp__ocu__*` tools. It appeared in the live skill catalog immediately.

## probe-mcp.mjs

A dependency-free stdio MCP smoke test — it speaks `initialize` + `tools/list`
and prints the server identity and tool catalog, without needing DSH:

```powershell
node probe-mcp.mjs "$env:APPDATA\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe" mcp
node probe-mcp.mjs "$env:APPDATA\npm\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe" mcp
```

Use it after upgrading either package to confirm the server still speaks MCP
before blaming the DSH profile.
