#!/usr/bin/env node
// Minimal stand-in for ttyd: answers /token and echoes bytes after an upgrade,
// so the dev server can be tested without a real pty behind it.
import { createServer } from "node:net";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);

createServer((socket) => {
  socket.once("data", (chunk) => {
    const requestLine = chunk.toString().split("\r\n")[0];
    if (requestLine.includes("/token")) {
      const body = '{"token":""}';
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (payload) => socket.write(payload));
  });
}).listen(port, "127.0.0.1");
