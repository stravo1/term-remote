// Guards the local dev loop: the page must be served from one origin with the
// reload client injected, and both ttyd endpoints must be reachable through it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const DEV_SERVER = join(ROOT, "tools/dev.mjs");
const FAKE_TTYD = join(ROOT, "tests/fixtures/fake-ttyd.mjs");

let devProcess;
let workspace;
let appRoot;
let base;

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

async function waitUntilReady(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // the dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dev server did not start on ${url}`);
}

function writeAppFile(name, contents) {
  writeFileSync(join(appRoot, name), contents);
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "term-remote-dev-"));
  appRoot = join(workspace, "app");
  mkdirSync(appRoot);
  writeFileSync(join(workspace, "secret.txt"), "do not serve\n");
  writeAppFile("index.html", "<!doctype html>\n<html><body>\n<p>dev</p>\n</body></html>\n");
  writeAppFile("app.js", "// app\n");

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  devProcess = spawn(process.execPath, [DEV_SERVER], {
    env: {
      ...process.env,
      DEV_APP_ROOT: appRoot,
      DEV_PORT: String(port),
      DEV_TTYD_PORT: String(await freePort()),
      TTYD_BIN: FAKE_TTYD,
      DEV_COMMAND: "echo",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  devProcess.stderr.on("data", () => {});
  await waitUntilReady(`${base}/__dev/client.js`);
});

after(() => {
  devProcess?.kill("SIGTERM");
  rmSync(workspace, { recursive: true, force: true });
});

test("index.html is served with the reload client injected", async () => {
  const response = await fetch(`${base}/`);
  const markup = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(markup.includes('<script src="/__dev/client.js"></script>'), "the reload client is missing");
  assert.ok(markup.trimEnd().endsWith("</body></html>"), "the injected tag broke the markup");
  assert.equal(markup.match(/<script src="\/app\.js"><\/script>/), null, "only the reload client is injected");
});

test("the page assets are served from the same origin", async () => {
  const response = await fetch(`${base}/app.js`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/javascript/);
  assert.equal(await response.text(), "// app\n");
});

test("paths outside the app root are refused", async () => {
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%zz"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, `${path} should not be served`);
    assert.doesNotMatch(await response.text(), /do not serve/);
  }
});

test("the token endpoint is proxied to ttyd", async () => {
  const response = await fetch(`${base}/token`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { token: "" });
});

test("the websocket upgrade is tunneled to ttyd", async () => {
  const { port } = new URL(base);
  const received = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.write("GET /ws HTTP/1.1\r\nHost: dev\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    let buffer = "";
    let sent = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!sent && buffer.includes("\r\n\r\n")) {
        sent = true;
        socket.write("ping");
        return;
      }
      if (buffer.includes("ping")) {
        socket.end();
        resolve(buffer);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`upgrade tunnel stalled; saw: ${JSON.stringify(buffer)}`)), 5000);
  });

  assert.match(received, /HTTP\/1\.1 101/);
  assert.match(received, /ping/);
});

test("a changed file tells open pages to reload", async () => {
  const response = await fetch(`${base}/__dev/reload`);
  const reader = response.body.getReader();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  writeAppFile("app.js", "// changed\n");

  const deadline = Date.now() + 5000;
  let text = "";
  while (!text.includes("event: reload") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += new TextDecoder().decode(value);
  }

  await reader.cancel();
  assert.match(text, /event: reload/, `the reload event never arrived; saw: ${JSON.stringify(text)}`);
});
