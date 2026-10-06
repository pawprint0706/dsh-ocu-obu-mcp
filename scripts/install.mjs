#!/usr/bin/env node
/**
 * Register Open Computer Use (`ocu`) and Open Browser Use (`obu`) as stdio MCP
 * servers in a DeepSeek Harness (DSH) profile.
 *
 * Works on macOS, Linux, and Windows. It resolves the bundled native executable
 * inside each globally installed npm package, probes both servers over stdio,
 * then writes one managed block into the profile patch. The block is replaced in
 * place on re-run, so the script is idempotent and safe to re-execute after a
 * package upgrade.
 *
 * Usage:
 *   node scripts/install.mjs [options]
 *
 * Options:
 *   --profile <name>      DSH profile to patch (default: $DSH_PROFILE, else the
 *                         only profile present, else desktop, else web)
 *   --dsh-home <dir>      Harness home (default: $DSH_HOME or ~/.dsh)
 *   --npm-root <dir>      npm global root (default: `npm root -g`)
 *   --ocu-command <path>  Override the Open Computer Use executable
 *   --obu-command <path>  Override the Open Browser Use executable
 *   --no-skill            Do not copy the Open Computer Use skill
 *   --force-skill         Replace an existing skill directory that differs
 *   --no-turn-ended-hooks Do not register turn-boundary cursor hooks
 *   --dry-run             Print what would change, write nothing
 *   --uninstall           Remove the managed block and hook config
 *   -h, --help            Show this help
 *
 * The DSH MCP client is the only integration point used: no first-class
 * computer-use provider is registered, so the tools appear as
 * mcp__ocu__<tool> and mcp__obu__<tool>.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { probeStdioMcp } from "./lib/mcp-probe.mjs";

const BLOCK_BEGIN = "# >>> ocu-obu-dsh-mcp (managed by scripts/install.mjs)";
const BLOCK_END = "# <<< ocu-obu-dsh-mcp";

const OCU_PACKAGE = "open-computer-use";
const OBU_PACKAGE = "open-browser-use";

/** Report a fatal, actionable error and stop. */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Print this file's leading doc comment as the `--help` text. */
function helpText() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  return source
    .split("*/")[0]
    .replace(/^#!.*\n/, "")
    .replace(/^\/\*\*?/, "")
    .replace(/^ \* ?/gm, "")
    .trim();
}

function parseArgs(argv) {
  const options = {
    profile: "",
    dshHome: process.env.DSH_HOME || path.join(homedir(), ".dsh"),
    npmRoot: "",
    ocuCommand: "",
    obuCommand: "",
    skill: true,
    forceSkill: false,
    hooks: true,
    dryRun: false,
    uninstall: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--profile": options.profile = next(); break;
      case "--dsh-home": options.dshHome = path.resolve(next()); break;
      case "--npm-root": options.npmRoot = path.resolve(next()); break;
      case "--ocu-command": options.ocuCommand = path.resolve(next()); break;
      case "--obu-command": options.obuCommand = path.resolve(next()); break;
      case "--no-skill": options.skill = false; break;
      case "--force-skill": options.forceSkill = true; break;
      case "--no-turn-ended-hooks": options.hooks = false; break;
      case "--dry-run": options.dryRun = true; break;
      case "--uninstall": options.uninstall = true; break;
      case "-h":
      case "--help":
        console.log(helpText());
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg} (try --help)`);
    }
  }

  return options;
}

/**
 * Map a platform/arch pair onto the paths inside each npm package.
 *
 * Every package ships prebuilt binaries for darwin/linux/windows on amd64 and
 * arm64; Open Computer Use additionally wraps the macOS build in an .app bundle,
 * whose inner Mach-O executable is the MCP server.
 *
 * Exported, and parameterised rather than reading the globals directly, so
 * scripts/check-platforms.mjs can validate every platform's path mapping against
 * the real package contents from any one machine.
 */
export function platformSpec(platform = process.platform, arch = process.arch) {
  const mapped = arch === "x64" ? "amd64" : arch;
  if (mapped !== "amd64" && mapped !== "arm64") {
    fail(`unsupported CPU architecture: ${arch}`);
  }

  switch (platform) {
    case "darwin":
      return {
        name: "macOS",
        needsExecBit: true,
        ocu: ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"],
        obu: ["native", `darwin-${mapped}`, "open-browser-use"],
      };
    case "linux":
      return {
        name: "Linux",
        needsExecBit: true,
        ocu: ["dist", "linux", mapped, "open-computer-use"],
        obu: ["native", `linux-${mapped}`, "open-browser-use"],
      };
    case "win32":
      return {
        name: "Windows",
        needsExecBit: false,
        ocu: ["dist", "windows", mapped, "open-computer-use.exe"],
        obu: ["native", `windows-${mapped}`, "open-browser-use.exe"],
      };
    default:
      fail(`unsupported platform: ${platform}`);
      return null;
  }
}

/** Resolve the npm global root, preferring an explicit override. */
function resolveNpmRoot(explicit) {
  if (explicit) return explicit;

  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  // On Windows npm is a .cmd shim, which Node refuses to spawn without a shell.
  // Go through cmd.exe with literal arguments instead of `shell: true`, so no
  // user-controlled string is ever concatenated into a command line.
  const attempts =
    process.platform === "win32"
      ? [
          () => execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], options),
          () => execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd root -g"], options),
        ]
      : [() => execFileSync("npm", ["root", "-g"], options)];

  for (const attempt of attempts) {
    try {
      const candidate = attempt().trim().split(/\r?\n/).filter(Boolean).pop();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // fall through to the next attempt, then to the known locations below
    }
  }

  const fallbacks = [
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    path.join(homedir(), ".npm-global", "lib", "node_modules"),
  ];
  for (const candidate of fallbacks) {
    if (existsSync(path.join(candidate, OCU_PACKAGE) ) || existsSync(path.join(candidate, OBU_PACKAGE))) {
      return candidate;
    }
  }

  fail("could not determine the npm global root; pass --npm-root <dir> (see `npm root -g`)");
  return "";
}

/** Locate one server executable, checking that it really exists. */
function resolveServerCommand({ explicit, npmRoot, relativeParts, label, pkg }) {
  const command = explicit ? explicit : path.join(npmRoot, pkg, ...relativeParts);
  if (!existsSync(command)) {
    fail(
      `${label} executable not found: ${command}\n` +
        `       install it with:  npm install -g ${pkg}`,
    );
  }
  return command;
}

/**
 * npm does not guarantee the executable bit for prebuilt binaries, and a clone
 * or CI checkout can lose it. Restore it on POSIX platforms when missing.
 */
function ensureExecutable(command, spec) {
  if (!spec.needsExecBit) return false;
  const mode = statSync(command).mode;
  if ((mode & 0o111) !== 0) return false;
  chmodSync(command, mode | 0o755);
  return true;
}

/** Local-time stamp matching the `yyyyMMdd-HHmmss` backups the DSH installer writes. */
function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Choose the DSH profile to patch, preferring explicit and unambiguous input. */
function resolveProfile(dshHome, requested) {
  if (requested) return requested;
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;

  const profilesDir = path.join(dshHome, "profiles");
  let entries = [];
  if (existsSync(profilesDir)) {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  if (entries.length === 1) return entries[0];
  if (entries.includes("desktop")) return "desktop";
  if (entries.includes("web")) return "web";
  if (entries.length === 0) return "desktop";

  fail(
    `several DSH profiles exist under ${profilesDir}: ${entries.join(", ")}\n` +
      "       choose one with --profile <name>",
  );
  return "";
}

/** Quote a scalar for single-quoted YAML (paths here contain spaces and `\\`). */
function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Quote a path for the shell line a command hook runs. */
function shellQuote(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

/**
 * Run a hook command line exactly as the hook runner will: through the platform
 * shell, so quoting is exercised too.
 *
 * Subcommand support genuinely differs between builds — the Windows Open Computer
 * Use executable rejects `turn-ended` — and the raw string `turn-ended` cannot be
 * used to decide that, because the MCP notification name `notifications/turn-ended`
 * contains it on every platform. Testing the real command is the only reliable
 * signal, so hooks are registered only if they succeed here.
 */
function runHookCommand(commandLine) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 };

  try {
    if (process.platform === "win32") {
      // execSync passes the line verbatim to `cmd.exe /d /s /c`. Passing it as an
      // argument to execFileSync instead would escape the embedded quotes as \",
      // which cmd.exe does not understand, failing every command that quotes its
      // executable path.
      execSync(commandLine, options);
    } else {
      execFileSync("/bin/sh", ["-c", commandLine], options);
    }
    return { ok: true, reason: "" };
  } catch (error) {
    const lines = String(error.stderr ?? error.message ?? error)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: false, reason: lines[0] ? lines[0].slice(0, 160) : `exit ${error.status ?? "?"}` };
  }
}

/**
 * Render the managed block.
 *
 * `reasoning` rows differ per platform: Open Computer Use's macOS build hides its
 * software cursor at a turn boundary and the Windows build has no `turn-ended`
 * subcommand at all, so that hook is registered on macOS only.
 */
function renderBlock({ ocuCommand, obuCommand, hooksPath, hookCommands }) {
  const lines = [
    BLOCK_BEGIN,
    "# Regenerated in place by scripts/install.mjs; edits inside this block are lost.",
    "#",
    "# Both rows spawn a bundled native executable by absolute path rather than the",
    "# npm PATH shim: a GUI/background launch need not inherit the installer's PATH,",
    "# and Node cannot spawn a .cmd shim without a shell.",
    "- insert:",
    "    - id: mcp-open-computer-use",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: ocu",
    "        transport: stdio",
    `        command: ${yamlString(ocuCommand)}`,
    "        args:",
    "          - mcp",
    "        toolCallTimeoutMs: 300000",
    "        failOnStartupError: true",
    "    - id: mcp-open-browser-use",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: obu",
    "        transport: stdio",
    `        command: ${yamlString(obuCommand)}`,
    "        args:",
    "          - mcp",
    "        toolCallTimeoutMs: 180000",
    "        # Left at its default (false): the obu MCP server starts without",
    "        # Chrome, and a missing browser must not reject profile activation.",
  ];

  if (hookCommands.length > 0) {
    lines.push(
      "    # dsh-mcp-client never sends notifications/turn-ended, so the software",
      "    # cursors are cleared by mapping DSH's Stop point onto the CLIs instead.",
      "    - id: ocu-obu-turn-ended-hook",
      "      name: '@deepseek-ai/dsh-hooks-codex'",
      "      config:",
      `        configPath: ${yamlString(hooksPath)}`,
      `        defaultTimeoutMs: ${Math.max(...hookCommands.map((entry) => entry.timeoutSec)) * 1000}`,
    );
  }

  lines.push(BLOCK_END);
  return lines;
}

/**
 * Split text into lines that keep their own terminators.
 *
 * The profile patch is hand-edited and may mix LF and CRLF. Editing it must
 * preserve every untouched byte — including the ending of each line — so the
 * block is spliced by line index rather than by normalising and re-joining the
 * whole file.
 */
function splitLinesWithEndings(text) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === "") break;
    lines.push(match[0]);
  }
  return lines;
}

const lineText = (line) => line.replace(/\r?\n$/, "");
const lineEol = (line) => (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "");

/** Pick the line ending new lines should use when the file does not say. */
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** Find the managed block, failing loudly on a half-deleted marker pair. */
function locateBlock(text) {
  const lines = splitLinesWithEndings(text);
  const begin = lines.findIndex((line) => lineText(line).trim() === BLOCK_BEGIN);
  const end = lines.findIndex((line) => lineText(line).trim() === BLOCK_END);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    fail("refusing to edit the profile patch: only one of the two managed markers is present");
  }
  return { lines, begin, end };
}

/** Replace the managed block in place, or append it when the patch has none. */
function replaceBlock(existingText, blockLines) {
  const { lines, begin, end } = locateBlock(existingText);
  const eol = begin !== -1 ? lineEol(lines[begin]) || dominantEol(existingText) : dominantEol(existingText);
  const block = blockLines.map((line) => `${line}${eol}`).join("");

  if (begin === -1) {
    let base = existingText;
    if (base.length > 0 && !base.endsWith("\n")) base += eol;
    if (base.length > 0) base += eol; // exactly one blank separator line
    return base + block;
  }

  return lines.slice(0, begin).join("") + block + lines.slice(end + 1).join("");
}

/** Remove the managed block, restoring the file to its exact previous bytes. */
function stripBlock(existingText) {
  const { lines, begin, end } = locateBlock(existingText);
  if (begin === -1) return { text: existingText, changed: false };

  // Undo the single blank separator line the append path added.
  const before = begin > 0 && lineText(lines[begin - 1]) === "" ? begin - 1 : begin;
  return { text: lines.slice(0, before).join("") + lines.slice(end + 1).join(""), changed: true };
}

/**
 * Refuse to write when an equivalent row already exists outside the managed
 * block: dsh-mcp-client rejects a duplicate serverName, and two rows for the same
 * id would register the server twice.
 */
function findConflicts(existingText) {
  const lines = existingText.replaceAll("\r\n", "\n").split("\n");
  const begin = lines.findIndex((line) => line.trim() === BLOCK_BEGIN);
  const end = lines.findIndex((line) => line.trim() === BLOCK_END);
  const outside =
    begin !== -1 && end > begin ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;

  const conflicts = [];
  outside.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^-\s*id:\s*(mcp-open-computer-use|mcp-open-browser-use|ocu-obu-turn-ended-hook)\s*$/.test(trimmed)) {
      conflicts.push({ what: trimmed, line: index + 1 });
    }
    if (/^serverName:\s*['"]?(ocu|obu)['"]?\s*(#.*)?$/.test(trimmed)) {
      conflicts.push({ what: trimmed, line: index + 1 });
    }
  });
  return conflicts;
}

/** Build the DSH hook config consumed by @deepseek-ai/dsh-hooks-codex. */
function renderHooksConfig(hookCommands) {
  return `${JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: hookCommands.map((entry) => ({
              type: "command",
              command: entry.command,
              timeout: entry.timeoutSec,
            })),
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/** Copy a directory tree, returning the relative file list for comparison. */
function listFiles(dir) {
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(dir, "");
  return found.sort();
}

function directoriesIdentical(left, right) {
  try {
    const leftFiles = listFiles(left);
    const rightFiles = listFiles(right);
    if (leftFiles.join("\n") !== rightFiles.join("\n")) return false;
    return leftFiles.every(
      (file) => readFileSync(path.join(left, file)).equals(readFileSync(path.join(right, file))),
    );
  } catch {
    return false;
  }
}

function copyTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTree(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const spec = platformSpec();
  const npmRoot = resolveNpmRoot(options.npmRoot);

  const profile = resolveProfile(options.dshHome, options.profile);
  const profilesDir = path.join(options.dshHome, "profiles");
  const patchPath = path.join(profilesDir, profile, "cordis.patch.yml");
  const hooksPath = path.join(options.dshHome, "ocu-obu-hooks.json");

  // A typo'd --profile would otherwise create a directory DSH never loads.
  if (!existsSync(path.dirname(patchPath))) {
    const existing = existsSync(profilesDir)
      ? readdirSync(profilesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
    fail(
      `no DSH profile directory at ${path.dirname(patchPath)}\n` +
        (existing.length > 0
          ? `       profiles present: ${existing.join(", ")}\n`
          : "       no profiles found; launch DSH once to create one\n") +
        "       pass --profile <name> if you meant a different profile",
    );
  }

  console.log(`platform      ${spec.name} (${process.platform}/${process.arch})`);
  console.log(`npm root      ${npmRoot}`);
  console.log(`profile patch ${patchPath}`);

  if (options.uninstall) {
    if (!existsSync(patchPath)) fail(`profile patch not found: ${patchPath}`);
    const { text, changed } = stripBlock(readFileSync(patchPath, "utf8"));
    if (!changed) {
      console.log("\nmanaged block not present; nothing to remove");
    } else if (options.dryRun) {
      console.log("\n[dry run] would remove the managed block");
    } else {
      writeFileSync(patchPath, text, "utf8");
      console.log("\nremoved the managed block");
    }
    if (existsSync(hooksPath)) {
      if (options.dryRun) console.log(`[dry run] would delete ${hooksPath}`);
      else {
        rmSync(hooksPath);
        console.log(`deleted ${hooksPath}`);
      }
    }
    console.log("the Open Computer Use skill was left in place; remove it manually if unwanted");
    return;
  }

  const ocuCommand = resolveServerCommand({
    explicit: options.ocuCommand,
    npmRoot,
    relativeParts: spec.ocu,
    label: "Open Computer Use",
    pkg: OCU_PACKAGE,
  });
  const obuCommand = resolveServerCommand({
    explicit: options.obuCommand,
    npmRoot,
    relativeParts: spec.obu,
    label: "Open Browser Use",
    pkg: OBU_PACKAGE,
  });

  for (const [label, command] of [["ocu", ocuCommand], ["obu", obuCommand]]) {
    if (ensureExecutable(command, spec)) {
      console.log(`restored the executable bit on the ${label} binary`);
    }
  }

  console.log(`ocu           ${ocuCommand}`);
  console.log(`obu           ${obuCommand}`);

  // Verify both servers speak MCP *before* writing any configuration: a patch
  // that names a non-server would fail activation with a much worse message.
  const toolCounts = {};
  for (const [label, command, expected] of [
    ["ocu", ocuCommand, "open-computer-use"],
    ["obu", obuCommand, "open-browser-use"],
  ]) {
    const probe = await probeStdioMcp(command, ["mcp"]);
    const name = probe.serverInfo?.name;
    if (name !== expected) {
      fail(`${label} probe returned server name ${JSON.stringify(name)}, expected ${JSON.stringify(expected)}`);
    }
    toolCounts[label] = probe.tools.length;
    console.log(
      `probe ok      ${label}: ${name} ${probe.serverInfo?.version ?? "?"} — ${probe.tools.length} tools`,
    );
  }

  // Turn-boundary hooks are registered only if the command actually runs on this
  // machine, so an unsupported subcommand is skipped instead of failing at every
  // turn end. `obu turn-ended` needs an explicit session id because the MCP server
  // owns `obu-mcp`, not the CLI default `obu-cli`.
  const hookCommands = [];
  if (options.hooks) {
    const candidates = [
      { label: "ocu turn-ended", command: `${shellQuote(ocuCommand)} turn-ended`, timeoutSec: 10 },
      {
        label: "obu turn-ended",
        command: `${shellQuote(obuCommand)} turn-ended --session-id obu-mcp`,
        timeoutSec: 15,
      },
    ];

    for (const candidate of candidates) {
      const result = runHookCommand(candidate.command);
      if (!result.ok) {
        console.log(`hook skipped  ${candidate.label}: ${result.reason}`);
        continue;
      }
      console.log(`hook ok       ${candidate.label}`);
      hookCommands.push({ command: candidate.command, timeoutSec: candidate.timeoutSec });
    }
  } else {
    console.log("hooks         disabled (--no-turn-ended-hooks)");
  }

  const blockLines = renderBlock({
    ocuCommand,
    obuCommand,
    hooksPath,
    hookCommands,
  });

  if (options.dryRun) {
    console.log("\n[dry run] would write this block:");
    console.log(blockLines.map((line) => `  ${line}`).join("\n"));
    if (hookCommands.length > 0) {
      console.log(`\n[dry run] would write ${hooksPath}:`);
      console.log(renderHooksConfig(hookCommands).trimEnd().replace(/^/gm, "  "));
    }
    return;
  }

  const existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const conflicts = findConflicts(existing);
  if (conflicts.length > 0) {
    const found = conflicts.map((entry) => `"${entry.what}" (line ${entry.line})`).join(", ");
    fail(
      `refusing to edit ${patchPath}: it already declares ${found} outside the managed block.\n` +
        "       remove the hand-written row(s) and re-run: duplicate rows register the same\n" +
        "       serverName twice, which dsh-mcp-client rejects at activation.",
    );
  }

  const next = replaceBlock(existing, blockLines);
  const patched = next !== existing;

  if (patched && existing.length > 0) {
    mkdirSync(path.dirname(patchPath), { recursive: true });
    const backup = `${patchPath}.bak-${localStamp()}`;
    writeFileSync(backup, existing, "utf8");
    console.log(`backup        ${backup}`);
  }

  if (patched) {
    mkdirSync(path.dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, next, "utf8");
  }
  console.log(`patch         ${patched ? "updated" : "already current"}`);

  if (hookCommands.length > 0) {
    const hooksText = renderHooksConfig(hookCommands);
    const hooksCurrent = existsSync(hooksPath) && readFileSync(hooksPath, "utf8") === hooksText;
    if (!hooksCurrent) writeFileSync(hooksPath, hooksText, "utf8");
    console.log(
      `hooks         ${hooksPath} (${hookCommands.length} Stop command(s)${hooksCurrent ? ", already current" : ""})`,
    );
  } else if (existsSync(hooksPath)) {
    rmSync(hooksPath);
    console.log("hooks         removed (none requested)");
  }

  const skillSource = path.join(npmRoot, OCU_PACKAGE, "skills", OCU_PACKAGE);
  const skillTarget = path.join(options.dshHome, "skills", OCU_PACKAGE);
  if (!options.skill) {
    console.log("skill         skipped (--no-skill)");
  } else if (!existsSync(skillSource)) {
    console.log(`skill         source missing at ${skillSource}; skipped`);
  } else if (!existsSync(skillTarget)) {
    mkdirSync(path.dirname(skillTarget), { recursive: true });
    copyTree(skillSource, skillTarget);
    console.log(`skill         installed at ${skillTarget}`);
  } else if (directoriesIdentical(skillSource, skillTarget)) {
    console.log(`skill         already current at ${skillTarget}`);
  } else if (options.forceSkill) {
    rmSync(skillTarget, { recursive: true, force: true });
    mkdirSync(path.dirname(skillTarget), { recursive: true });
    copyTree(skillSource, skillTarget);
    console.log(`skill         replaced at ${skillTarget} (a local copy was overwritten)`);
  } else {
    console.log(`skill         local copy at ${skillTarget} differs; left untouched (--force-skill to replace)`);
  }

  console.log(`
Installed into DSH profile patch ${patchPath}.

  tools   mcp__ocu__* (${toolCounts.ocu} tools) and mcp__obu__* (${toolCounts.obu} tools)
  hooks   ${hookCommands.length > 0 ? `Stop -> ${hooksPath}` : "none"}

DSH reloads the profile when the patch changes; other profiles may need a restart.
Next steps per platform:`);

  if (process.platform === "darwin") {
    console.log(`
  macOS
    1. Grant Accessibility and Screen Recording to Open Computer Use once,
       then confirm with:
         "${ocuCommand}" doctor
    2. Register the Chrome extension and native messaging host:
         "${obuCommand}" setup
       Verify the browser backend with:
         "${obuCommand}" ping`);
  } else if (process.platform === "win32") {
    console.log(`
  Windows
    1. Run the runtime notes check:
         "${ocuCommand}" doctor
    2. Register the Chrome extension and native messaging host:
         "${obuCommand}" setup
       Verify the browser backend with:
         "${obuCommand}" ping
    3. Both runtimes need a signed-in desktop session; neither works as a
       service or on a lock screen.`);
  } else {
    console.log(`
  Linux
    1. A signed-in desktop session with AT-SPI2 / D-Bus is required.
    2. Register the Chrome extension and native messaging host:
         "${obuCommand}" setup`);
  }
}

// Only run when executed directly: importing this module (for example from
// scripts/check-platforms.mjs) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
