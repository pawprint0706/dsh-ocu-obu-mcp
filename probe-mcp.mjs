/**
 * Dependency-free stdio MCP smoke test.
 *
 * Confirms a server speaks MCP — `initialize` plus `tools/list` — and prints its
 * identity and tool catalog. Use it after upgrading either npm package to check
 * the server itself before suspecting the DSH profile.
 *
 * Usage:
 *   node probe-mcp.mjs <command> [args...]
 *
 * Examples (Windows):
 *   node probe-mcp.mjs "$env:APPDATA\npm\node_modules\open-browser-use\native\windows-amd64\open-browser-use.exe" mcp
 *   node probe-mcp.mjs "$env:APPDATA\npm\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe" mcp
 *
 * Examples (macOS, Apple Silicon):
 *   node probe-mcp.mjs "$(npm root -g)/open-browser-use/native/darwin-arm64/open-browser-use" mcp
 *   node probe-mcp.mjs "$(npm root -g)/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse" mcp
 */

import { probeStdioMcp } from "./scripts/lib/mcp-probe.mjs";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("usage: node probe-mcp.mjs <command> [args...]");
  process.exit(2);
}

try {
  const result = await probeStdioMcp(command, args);
  console.log(
    JSON.stringify(
      {
        ok: true,
        server: result.serverInfo,
        protocolVersion: result.protocolVersion,
        toolCount: result.tools.length,
        tools: result.tools,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
