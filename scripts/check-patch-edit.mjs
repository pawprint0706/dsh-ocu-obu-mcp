#!/usr/bin/env node
/**
 * Regression checks for the profile-patch editing in install.mjs.
 *
 * Both defects this guards against were silent: the installer reported success
 * while producing a patch DSH could not load, or while deleting a hook. They are
 * cheap to check and expensive to notice, so they are checked here instead of by
 * eye after every change.
 *
 *   node scripts/check-patch-edit.mjs
 *
 * The YAML check is structural rather than a full parse (the suite is deliberately
 * dependency-free): the failure mode is the profile template's `[]` placeholder
 * being left next to a block sequence, which makes two top-level nodes. The
 * round-trip and idempotency checks are exact byte comparisons.
 */

import { replaceBlock, stripBlock } from "./install.mjs";

const BLOCK = [
  "# >>> ocu-obu-dsh-mcp (managed by scripts/install.mjs)",
  "# Regenerated in place.",
  "- insert:",
  "    - id: mcp-open-computer-use",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: ocu",
  "# <<< ocu-obu-dsh-mcp",
];

// The exact text dsh-app-boot writes into a new profile (PROFILE_PATCH_TEMPLATE).
const FRESH_TEMPLATE =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries (id-targeted config\n" +
  "# overrides, disables, and insert lists; `!!js` expressions allowed).\n" +
  "[]\n";

const POPULATED =
  "# Your patch layer for this dsh profile\n" +
  "- id: ui-theme\n" +
  "  config:\n" +
  "    preference: dark\n";

const EMPTY = "";

/** A file already corrupted by the old append-after-`[]` behaviour. */
const BROKEN = `${FRESH_TEMPLATE}\n${BLOCK.join("\n")}\n`;

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Two top-level YAML nodes: a bare `[]` line coexisting with block entries. */
function hasTwoTopLevelNodes(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.includes("[]") && lines.includes("- insert:");
}

console.log("fresh profile template (the new-PC case)");
const freshOut = replaceBlock(FRESH_TEMPLATE, BLOCK);
check("produces a single top-level node", !hasTwoTopLevelNodes(freshOut), freshOut.split("\n")[3]);
check("keeps the template's comments", freshOut.includes("# Your patch layer for this dsh profile"));
check("contains the managed block", freshOut.includes("# >>> ocu-obu-dsh-mcp"));
check("is idempotent", replaceBlock(freshOut, BLOCK) === freshOut);
check("uninstall restores the template byte for byte", stripBlock(freshOut).text === FRESH_TEMPLATE);

console.log("profile with existing entries");
const popOut = replaceBlock(POPULATED, BLOCK);
check("keeps existing entries and does not add a placeholder", !popOut.includes("[]"));
check("is idempotent", replaceBlock(popOut, BLOCK) === popOut);
check("uninstall is byte exact", stripBlock(popOut).text === POPULATED);

console.log("empty patch file");
const emptyOut = replaceBlock(EMPTY, BLOCK);
check("produces only the managed block", emptyOut === `${BLOCK.join("\n")}\n`);
check("is idempotent", replaceBlock(emptyOut, BLOCK) === emptyOut);
check("uninstall returns an empty file", stripBlock(emptyOut).text === "");

console.log("file already corrupted by an earlier run");
const repaired = replaceBlock(BROKEN, BLOCK);
check("repairs the placeholder clash", !hasTwoTopLevelNodes(repaired), repaired.split("\n")[3]);
check("is idempotent after repair", replaceBlock(repaired, BLOCK) === repaired);
check("uninstall restores the template", stripBlock(repaired).text === FRESH_TEMPLATE);

console.log("mixed line endings are preserved");
const crlf = "# comment\r\n- id: ui-theme\n  config:\n    preference: dark\n";
const crlfOut = replaceBlock(crlf, BLOCK);
check("untouched CRLF line survives", crlfOut.startsWith("# comment\r\n- id: ui-theme\n"));
check("uninstall is byte exact", stripBlock(crlfOut).text === crlf);

console.log(failures === 0 ? "\nall patch-edit checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
