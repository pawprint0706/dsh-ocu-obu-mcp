/**
 * Minimal stdio MCP probe shared by probe-mcp.mjs and scripts/install.mjs.
 *
 * Speaks just enough JSON-RPC over newline-delimited stdin/stdout to perform
 * `initialize` + `tools/list`, which is what the DSH MCP client itself does at
 * activation. Deliberately dependency-free: it must be runnable from a bare
 * `git clone` before any npm install.
 */

import { spawn } from "node:child_process";

/**
 * Spawn `command args...`, discover its MCP identity and tool catalog.
 *
 * @param {string} command Absolute path (or PATH name) of the MCP server.
 * @param {string[]} [args] Server arguments, normally ["mcp"].
 * @param {{ timeoutMs?: number, env?: Record<string, string> }} [options]
 * @returns {Promise<{ serverInfo: object|null, protocolVersion: string|null,
 *   tools: Array<{name: string, title: string|null}>, stderr: string }>}
 */
export function probeStdioMcp(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    } catch (error) {
      reject(new Error(`could not spawn ${command}: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(new Error("probe settled"));
      }
      pending.clear();
      if (!child.killed) child.kill();
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`MCP probe timed out after ${timeoutMs} ms: ${command}`)),
      timeoutMs,
    );

    child.on("error", (error) => finish(reject, new Error(`could not spawn ${command}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      finish(
        reject,
        new Error(
          `${command} exited before discovery (code=${code ?? "null"}, signal=${signal ?? "none"})` +
            (stderr.trim() ? `: ${stderr.trim()}` : ""),
        ),
      );
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });

    const request = (method, params) => {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          rejectRequest(error);
        });
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(reject, new Error(`MCP server wrote non-JSON stdout: ${line.slice(0, 200)}`));
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        entry.resolve(message);
      }
    });

    (async () => {
      const initialized = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ocu-obu-dsh-mcp", version: "1" },
      });
      if (initialized.error) {
        throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

      const listed = await request("tools/list", {});
      if (listed.error) {
        throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
      }
      const tools = listed.result?.tools;
      if (!Array.isArray(tools)) {
        throw new Error("tools/list did not return an array");
      }

      finish(resolve, {
        serverInfo: initialized.result?.serverInfo ?? null,
        protocolVersion: initialized.result?.protocolVersion ?? null,
        tools: tools.map((tool) => ({ name: tool?.name, title: tool?.title ?? null })),
        stderr,
      });
    })().catch((error) => finish(reject, error));
  });
}
