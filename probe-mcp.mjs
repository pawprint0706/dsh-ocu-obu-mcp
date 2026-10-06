// Probe a stdio MCP server: initialize -> tools/list, print results as JSON.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node probe-mcp.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
const pending = new Map();
let stderr = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dsh-probe", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await request(2, "tools/list", {});
  const list = tools?.result?.tools ?? [];
  console.log(
    JSON.stringify(
      {
        ok: true,
        server: init?.result?.serverInfo ?? null,
        protocolVersion: init?.result?.protocolVersion ?? null,
        toolCount: list.length,
        tools: list.map((tool) => ({ name: tool.name, title: tool.title ?? null })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error), stderr }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill();
}
