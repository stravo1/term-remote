// Guards the one fragile coupling in this project: the client speaks ttyd's
// WebSocket protocol directly. If a ttyd upgrade changes framing, this fails
// before the page does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

const TTYD = process.env.TTYD_BIN ?? `${process.env.HOME}/.local/bin/ttyd`;
const SKIP = existsSync(TTYD) ? false : `ttyd not found at ${TTYD}; set TTYD_BIN to run this test`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let process_handle;
let base;

class TtydClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.addEventListener("message", (event) => {
      assert.ok(event.data instanceof ArrayBuffer, "ttyd frames must arrive as binary");
      const frame = decoder.decode(event.data);
      this.messages.push({ command: frame[0], body: frame.slice(1) });
      for (const waiter of [...this.waiters]) {
        waiter();
      }
    });
  }

  get output() {
    return this.messages
      .filter((message) => message.command === "0")
      .map((message) => message.body)
      .join("");
  }

  input(text) {
    this.socket.send(encoder.encode(`0${text}`));
  }

  resize(columns, rows) {
    this.socket.send(encoder.encode(`1${JSON.stringify({ columns, rows })}`));
  }

  until(predicate, timeout = 8000) {
    if (predicate(this.output, this.messages)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for terminal output; saw: ${JSON.stringify(this.output.slice(-200))}`));
      }, timeout);
      const waiter = () => {
        if (predicate(this.output, this.messages)) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          resolve();
        }
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForToken(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/token`);
      if (response.ok) {
        return;
      }
    } catch {
      // ttyd is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ttyd did not start on ${url}`);
}

async function connect(columns = 80, rows = 24) {
  const { token } = await (await fetch(`${base}/token`)).json();
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, ["tty"]);
  socket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket handshake failed")), { once: true });
  });

  const client = new TtydClient(socket);
  socket.send(encoder.encode(JSON.stringify({ AuthToken: token, columns, rows })));
  return client;
}

before(async () => {
  if (SKIP) {
    return;
  }
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  process_handle = spawn(
    TTYD,
    ["--interface", "127.0.0.1", "--port", String(port), "--writable", "bash", "--norc", "--noprofile"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  process_handle.stderr.on("data", () => {});
  await waitForToken(base);
});

after(() => {
  process_handle?.kill("SIGTERM");
});

test("the token endpoint returns a token", { skip: SKIP }, async () => {
  const response = await fetch(`${base}/token`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof payload.token, "string");
});

test("the server greets with a window title and terminal output", { skip: SKIP }, async () => {
  const client = await connect();
  try {
    await client.until((output, messages) => messages.some((message) => message.command === "1") && output.length > 0);
    assert.ok(
      client.messages.some((message) => message.command === "1"),
      "expected a window title frame",
    );
  } finally {
    client.close();
  }
});

test("input framed as 0 + data reaches the shell", { skip: SKIP }, async () => {
  const client = await connect();
  try {
    client.input('echo "PROTOCOL_MARKER_$((40 + 2))"\n');
    await client.until((output) => output.includes("PROTOCOL_MARKER_42"));
  } finally {
    client.close();
  }
});

test("resize framed as 1 + JSON changes the pty size", { skip: SKIP }, async () => {
  const client = await connect(80, 24);
  try {
    client.resize(42, 17);
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.input('printf "COLS=%s ROWS=%s\\n" "$(tput cols)" "$(stty size | cut -d" " -f1)"\n');
    await client.until((output) => output.includes("COLS=42 ROWS=17"));
  } finally {
    client.close();
  }
});
