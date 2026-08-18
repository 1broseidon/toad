#!/usr/bin/env node
// Probes an ACP agent over stdio: initialize -> session/new -> session/prompt.
// Prints every frame in both directions so backend behaviour can be compared.
//
//   node hack/acp-probe.mjs --cwd /tmp/probe -- cursor-agent acp
//   node hack/acp-probe.mjs --prompt "say hi" -- opencode acp

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1) {
  console.error("usage: acp-probe.mjs [--cwd DIR] [--prompt TEXT] [--timeout MS] -- <agent-cmd> [args...]");
  process.exit(2);
}

const flags = argv.slice(0, sep);
const [cmd, ...cmdArgs] = argv.slice(sep + 1);
const flag = (name, fallback) => {
  const i = flags.indexOf(name);
  return i === -1 ? fallback : flags[i + 1];
};

const cwd = flag("--cwd", mkdtempSync(join(tmpdir(), "acp-probe-")));
const promptText = flag("--prompt", "Reply with exactly the word: pong");
const timeoutMs = Number(flag("--timeout", "60000"));
const protocolVersion = Number(flag("--protocol", "1"));

const child = spawn(cmd, cmdArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 1;
const pending = new Map();
let buf = "";

const log = (dir, obj) => {
  const tag = dir === "in" ? "<--" : "-->";
  console.log(`${tag} ${JSON.stringify(obj)}`);
};

function send(obj) {
  log("out", obj);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

// Minimal client-side handlers. An agent that gets no answer here will hang,
// which is exactly the failure mode Toad has to avoid.
function handleServerRequest(msg) {
  switch (msg.method) {
    case "session/request_permission": {
      const opts = msg.params?.options ?? [];
      const pick =
        opts.find((o) => o.kind === "allow_always") ??
        opts.find((o) => o.kind === "allow_once") ??
        opts[0];
      console.log(`    [probe] auto-allowing permission via option ${JSON.stringify(pick)}`);
      return respond(msg.id, { outcome: { outcome: "selected", optionId: pick?.optionId } });
    }
    case "fs/read_text_file":
      return respond(msg.id, { content: "" });
    case "fs/write_text_file":
      return respond(msg.id, {});
    default:
      console.log(`    [probe] unhandled server request: ${msg.method}`);
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `probe does not implement ${msg.method}` },
      });
  }
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`<-- [non-json] ${line}`);
      continue;
    }
    log("in", msg);
    if (msg.id !== undefined && msg.method) {
      handleServerRequest(msg);
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
child.on("exit", (code, signal) => {
  console.log(`\n[probe] agent exited code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

const bail = setTimeout(() => {
  console.log("\n[probe] timeout reached, killing agent");
  child.kill("SIGKILL");
  process.exit(1);
}, timeoutMs);

(async () => {
  console.log(`[probe] cmd=${[cmd, ...cmdArgs].join(" ")} cwd=${cwd}\n`);

  const init = await request("initialize", {
    protocolVersion,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  console.log(`\n[probe] === INITIALIZE RESULT ===\n${JSON.stringify(init, null, 2)}\n`);

  const session = await request("session/new", { cwd, mcpServers: [] });
  console.log(`\n[probe] === SESSION/NEW RESULT ===\n${JSON.stringify(session, null, 2)}\n`);

  const sessionId = session.sessionId;
  console.log(`[probe] prompting session ${sessionId}\n`);
  const turn = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  console.log(`\n[probe] === PROMPT RESULT ===\n${JSON.stringify(turn, null, 2)}\n`);

  clearTimeout(bail);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
})().catch((err) => {
  console.error(`\n[probe] FAILED: ${err.message}`);
  clearTimeout(bail);
  child.kill("SIGKILL");
  process.exit(1);
});
