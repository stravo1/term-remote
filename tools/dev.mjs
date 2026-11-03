#!/usr/bin/env node
// Local development loop: one origin that serves app/ with live reload and
// proxies the two ttyd endpoints, the way Caddy does on the host. Nothing here
// ships to production.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(process.env.DEV_APP_ROOT ?? fileURLToPath(new URL("../app", import.meta.url)));
const HOST = process.env.DEV_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DEV_PORT ?? 8080);
// The provisioned service already owns 7681, so the dev pty takes the next port.
const TTYD_PORT = Number(process.env.DEV_TTYD_PORT ?? 7682);
const TTYD_BIN = process.env.TTYD_BIN ?? `${process.env.HOME}/.local/bin/ttyd`;
const SHELL_COMMAND = (process.env.DEV_COMMAND ?? "tmux new -A -s dev").split(/\s+/);
const RELOAD_EVENTS = "/__dev/reload";
const RELOAD_CLIENT = "/__dev/client.js";
const RELOAD_DELAY_MS = 80;
const TTYD_START_TIMEOUT_MS = 10000;

const CLIENT_SOURCE = `// Injected by tools/dev.mjs; reloads the page when app/ changes.
const events = new EventSource("${RELOAD_EVENTS}");
events.addEventListener("reload", () => location.reload());
`;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const reloadClients = new Set();
let isStopping = false;

function contentType(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendNotFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
}

function sendIndex(response) {
  const markup = readFileSync(join(APP_ROOT, "index.html"), "utf8");
  const injected = markup.replace("</body>", `    <script src="${RELOAD_CLIENT}"></script>\n  </body>`);
  response.writeHead(200, { "content-type": contentType("index.html"), "cache-control": "no-store" });
  response.end(injected);
}

function decodePath(url) {
  try {
    return decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    return null;
  }
}

function serveStatic(url, response) {
  const pathname = decodePath(url);
  if (pathname === null) {
    return sendNotFound(response);
  }
  const file = normalize(join(APP_ROOT, pathname));
  const isIndex = pathname === "/" || pathname === "/index.html";

  if (!isIndex && (!file.startsWith(`${APP_ROOT}/`) || !existsSync(file) || !statSync(file).isFile())) {
    return sendNotFound(response);
  }
  if (isIndex) {
    return sendIndex(response);
  }

  response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
  const stream = createReadStream(file);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

// The host block proxies /token and /ws to ttyd and serves the rest itself.
// ttyd sends no credentials, so the browser talks to this one origin only.
function proxyToken(response) {
  const upstream = httpRequest(
    { host: "127.0.0.1", port: TTYD_PORT, path: "/token", method: "GET" },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, {
        "content-type": upstreamResponse.headers["content-type"] ?? "application/json",
        "cache-control": "no-store",
      });
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) {
      return response.destroy();
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`ttyd is not answering on 127.0.0.1:${TTYD_PORT}\n`);
  });
  upstream.end();
}

function proxySocket(request, socket, head) {
  const upstream = connect(TTYD_PORT, "127.0.0.1", () => {
    const headers = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function streamReload(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write("retry: 500\n\n");
  reloadClients.add(response);
  request.on("close", () => reloadClients.delete(response));
}

function notifyReload() {
  for (const response of reloadClients) {
    response.write("event: reload\ndata: 1\n\n");
  }
}

// Editors write in bursts, so one event per change batch is enough.
function watchApp() {
  let timer;
  watch(APP_ROOT, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(notifyReload, RELOAD_DELAY_MS);
  });
}

function handleRequest(request, response) {
  if (request.url === RELOAD_EVENTS) {
    return streamReload(request, response);
  }
  if (request.url === RELOAD_CLIENT) {
    response.writeHead(200, { "content-type": contentType("client.js"), "cache-control": "no-store" });
    return response.end(CLIENT_SOURCE);
  }
  if (request.url === "/token") {
    return proxyToken(response);
  }
  return serveStatic(request.url, response);
}

function startTtyd() {
  if (!existsSync(TTYD_BIN)) {
    console.error(`ttyd not found at ${TTYD_BIN}. Set TTYD_BIN or run ./setup-term-remote.sh.`);
    process.exit(1);
  }
  const args = ["--interface", "127.0.0.1", "--port", String(TTYD_PORT), "--writable", ...SHELL_COMMAND];
  const child = spawn(TTYD_BIN, args, { stdio: ["ignore", "ignore", "inherit"] });
  child.on("exit", (code) => {
    if (!isStopping) {
      console.error(`ttyd exited with code ${code}`);
      process.exit(1);
    }
  });
  return child;
}

async function waitForTtyd() {
  const deadline = Date.now() + TTYD_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${TTYD_PORT}/token`)).ok) {
        return;
      }
    } catch {
      // ttyd is still binding the port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`ttyd did not start on 127.0.0.1:${TTYD_PORT}`);
}

let ttyd;

function stop(code = 0) {
  isStopping = true;
  ttyd?.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

ttyd = startTtyd();
try {
  await waitForTtyd();
} catch (error) {
  console.error(error.message);
  stop(1);
}
watchApp();

const server = createServer(handleRequest);
server.on("upgrade", proxySocket);
server.listen(PORT, HOST, () => {
  console.log(`term-remote dev on http://${HOST}:${PORT}`);
  console.log(`serving ${APP_ROOT}`);
  console.log(`ttyd on 127.0.0.1:${TTYD_PORT} running: ${SHELL_COMMAND.join(" ")}`);
});
