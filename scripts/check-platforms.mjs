#!/usr/bin/env node
/**
 * Validate the platform -> path mapping used by scripts/install.mjs.
 *
 * The npm packages ship prebuilt binaries for every supported platform, so a
 * single machine can confirm that the path the installer will use on macOS,
 * Linux, and Windows really exists inside the installed packages. This is what
 * makes the macOS wiring reviewable without a Mac; it does not prove that a
 * macOS binary runs, only that the installer will point at the right file.
 *
 * Usage:
 *   node scripts/check-platforms.mjs [--npm-root <dir>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { platformSpec } from "./install.mjs";

const OCU_PACKAGE = "open-computer-use";
const OBU_PACKAGE = "open-browser-use";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function resolveNpmRoot() {
  const index = process.argv.indexOf("--npm-root");
  if (index !== -1 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);

  const attempts =
    process.platform === "win32"
      ? [() => execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8" })]
      : [() => execFileSync("npm", ["root", "-g"], { encoding: "utf8" })];

  for (const attempt of attempts) {
    try {
      const candidate = attempt().trim().split(/\r?\n/).filter(Boolean).pop();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // fall through
    }
  }
  fail("could not determine the npm global root; pass --npm-root <dir>");
  return "";
}

/**
 * Whether the literal `turn-ended` appears in a build.
 *
 * This is **not** decisive: `notifications/turn-ended` is an MCP notification name
 * present in every build, so the Windows executable matches the string even though
 * it rejects `turn-ended` as a subcommand. install.mjs therefore decides hook
 * registration by running the command, and this column is reported only as raw
 * evidence about a build.
 */
function advertisesTurnEnded(command) {
  try {
    return readFileSync(command).includes("turn-ended");
  } catch {
    return null;
  }
}

const npmRoot = resolveNpmRoot();
console.log(`npm root  ${npmRoot}\n`);

const combinations = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
];

const rows = [];
let missing = 0;

for (const [platform, arch] of combinations) {
  const spec = platformSpec(platform, arch);
  const ocu = path.join(npmRoot, OCU_PACKAGE, ...spec.ocu);
  const obu = path.join(npmRoot, OBU_PACKAGE, ...spec.obu);
  const ocuPresent = existsSync(ocu);
  const obuPresent = existsSync(obu);
  if (!ocuPresent) missing += 1;
  if (!obuPresent) missing += 1;

  rows.push({
    platform: `${platform}/${arch}`,
    ocu: ocuPresent ? "ok" : "MISSING",
    obu: obuPresent ? "ok" : "MISSING",
    "turn-ended str": ocuPresent ? (advertisesTurnEnded(ocu) ? "present" : "absent") : "-",
  });
}

const width = (key) => Math.max(key.length, ...rows.map((row) => String(row[key]).length));
const columns = Object.keys(rows[0]);
const widths = Object.fromEntries(columns.map((column) => [column, width(column)]));

console.log(columns.map((column) => column.padEnd(widths[column])).join("  "));
console.log(columns.map((column) => "-".repeat(widths[column])).join("  "));
for (const row of rows) {
  console.log(columns.map((column) => String(row[column]).padEnd(widths[column])).join("  "));
}

console.log(`\ninstalled package versions`);
for (const [label, pkg] of [["ocu", OCU_PACKAGE], ["obu", OBU_PACKAGE]]) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(npmRoot, pkg, "package.json"), "utf8"));
    console.log(`  ${label}  ${manifest.name}@${manifest.version}`);
  } catch {
    console.log(`  ${label}  not installed under ${path.join(homedir(), ".dsh")}`);
  }
}

if (missing > 0) {
  console.log(
    `\n${missing} path(s) missing. The package versions above may not ship every` +
      ` platform, or the install is partial; install.mjs will refuse to run there.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "\nall platform path mappings resolve against the installed packages" +
      "\n(hook support cannot be decided from these files; install.mjs reads each" +
      "\n build's own --help command list instead)",
  );
}
