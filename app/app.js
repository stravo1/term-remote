"use strict";

// ttyd wire protocol: binary frames, one command byte followed by the payload.
// Client sends '0' + input and '1' + JSON resize; the JSON init frame has no prefix.
const ENDPOINTS = { token: "/token", socket: "/ws" };
const COMMAND = { input: "0", output: "0", resize: "1", windowTitle: "1" };

const FONT = { min: 9, max: 26, step: 1, initial: 13, storageKey: "term-remote:font-size" };
const THEME_KEY = "term-remote:theme";
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000];

const KEY_SEQUENCES = {
  esc: "\x1b",
  tab: "\t",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  pipe: "|",
  dash: "-",
  slash: "/",
  tilde: "~",
};

const KEY_DEFINITIONS = [
  { id: "esc", label: "Esc" },
  { id: "tab", label: "Tab" },
  { id: "ctrl", label: "Ctrl", modifier: "ctrl" },
  { id: "alt", label: "Alt", modifier: "alt" },
  { id: "left", label: "←" },
  { id: "right", label: "→" },
  { id: "up", label: "↑" },
  { id: "down", label: "↓" },
  { id: "home", label: "Home" },
  { id: "end", label: "End" },
  { id: "pageUp", label: "PgUp" },
  { id: "pageDown", label: "PgDn" },
  { id: "pipe", label: "|" },
  { id: "dash", label: "-" },
  { id: "slash", label: "/" },
  { id: "tilde", label: "~" },
];

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function loadFontSize() {
  const stored = Number(localStorage.getItem(FONT.storageKey));
  if (!Number.isFinite(stored) || stored < FONT.min || stored > FONT.max) {
    return FONT.initial;
  }
  return Math.round(stored);
}

function socketUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${ENDPOINTS.socket}`;
}

async function requestToken() {
  const response = await fetch(ENDPOINTS.token, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`token request failed with ${response.status}`);
  }
  const payload = await response.json();
  return payload.token ?? "";
}

// Sticky Ctrl/Alt: applied to the next key, whether tapped on the key bar or typed.
function applyModifiers(data, armed) {
  if (armed.size === 0) {
    return data;
  }
  let result = data;
  if (armed.has("ctrl") && result.length === 1) {
    const code = result.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) {
      result = String.fromCharCode(code - 0x40);
    }
  }
  if (armed.has("alt")) {
    result = `\x1b${result}`;
  }
  return result;
}

// Maps Espresso tokens to the xterm palette, so the terminal follows the
// color scheme the page uses. Read at connect time and on theme changes.
function espressoTerminalTheme() {
  const token = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: token("--surface-base", "#1a1a1a"),
    foreground: token("--ink-gray-9", "#f8f8f8"),
    cursor: token("--ink-gray-4", "#aeaeae"),
    cursorAccent: token("--surface-base", "#1a1a1a"),
    selectionBackground: `color-mix(in oklab, ${token("--ink-gray-4", "#aeaeae")} 30%, transparent)`,
  };
}

function isDarkScheme() {
  return document.documentElement.dataset.theme !== "light";
}

function syncSchemeMeta(isDark) {
  document.querySelector('meta[name="theme-color"]').setAttribute("content", isDark ? "#1a1a1a" : "#ffffff");
  document.querySelector('meta[name="color-scheme"]').setAttribute("content", isDark ? "dark" : "light");
}

function setScheme(isDark) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  syncSchemeMeta(isDark);
}

class TerminalSocket {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.socket = null;
    this.closedByUser = false;
  }

  get isOpen() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  async connect(columns, rows) {
    this.close();
    this.closedByUser = false;
    const token = await requestToken();
    const socket = new WebSocket(socketUrl(), ["tty"]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send(JSON.stringify({ AuthToken: token, columns, rows }));
      this.callbacks.onOpen();
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.callbacks.onClose();
    });
  }

  sendInput(data) {
    return this.send(COMMAND.input + data);
  }

  sendResize(columns, rows) {
    return this.send(COMMAND.resize + JSON.stringify({ columns, rows }));
  }

  send(text) {
    if (!this.isOpen) {
      return false;
    }
    this.socket.send(ENCODER.encode(text));
    return true;
  }

  handleMessage(event) {
    const message = DECODER.decode(event.data);
    const command = message[0];
    const body = message.slice(1);
    if (command === COMMAND.output) {
      this.callbacks.onOutput(body);
    } else if (command === COMMAND.windowTitle) {
      this.callbacks.onWindowTitle(body);
    }
    // COMMAND '2' is server-side UI preferences; this client owns its own.
  }

  close() {
    this.closedByUser = true;
    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
  }
}

class TerminalView {
  constructor(element) {
    this.terminal = new Terminal({
      fontSize: loadFontSize(),
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: espressoTerminalTheme(),
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(element);
    this.wireTouchScroll();
    this.fit();
  }

  get columns() {
    return this.terminal.cols;
  }

  get rows() {
    return this.terminal.rows;
  }

  get fontSize() {
    return this.terminal.options.fontSize;
  }

  write(data) {
    this.terminal.write(data);
  }

  focus() {
    this.terminal.focus();
  }

  fit() {
    try {
      this.fitAddon.fit();
    } catch (error) {
      console.warn("[terminal] fit failed", error);
    }
  }

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    this.fit();
  }

  applyTheme() {
    this.terminal.options.theme = espressoTerminalTheme();
  }

  onData(handler) {
    this.terminal.onData(handler);
  }

  onResize(handler) {
    this.terminal.onResize(({ cols, rows }) => handler(cols, rows));
  }

  // xterm has no touch scrolling of its own; drag one line per line height.
  wireTouchScroll() {
    const element = this.terminal.element;
    let lastY = null;
    element.addEventListener(
      "touchstart",
      (event) => {
        lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
      },
      { passive: true },
    );
    element.addEventListener(
      "touchmove",
      (event) => {
        if (lastY === null || event.touches.length !== 1) {
          return;
        }
        const delta = lastY - event.touches[0].clientY;
        if (Math.abs(delta) < this.terminal.options.fontSize * 1.2) {
          return;
        }
        this.terminal.scrollLines(Math.sign(delta));
        lastY = event.touches[0].clientY;
      },
      { passive: true },
    );
    element.addEventListener(
      "touchend",
      () => {
        lastY = null;
      },
      { passive: true },
    );
  }
}

class KeyBar {
  constructor(element, onKey) {
    this.element = element;
    this.onKey = onKey;
    this.armed = new Set();
    this.buttons = new Map();
    this.render();
  }

  get activeModifiers() {
    return new Set(this.armed);
  }

  render() {
    const buttons = KEY_DEFINITIONS.map((definition) => {
      const button = this.createButton(definition);
      this.buttons.set(definition.id, button);
      return button;
    });
    this.element.replaceChildren(...buttons);
  }

  createButton(definition) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = definition.modifier ? "key modifier" : "key";
    button.textContent = definition.label;
    button.addEventListener("click", () => this.press(definition));
    return button;
  }

  press(definition) {
    if (definition.modifier) {
      this.toggleModifier(definition.modifier);
      return;
    }
    this.onKey(KEY_SEQUENCES[definition.id], this.armed);
    this.clearModifiers();
  }

  toggleModifier(name) {
    if (this.armed.has(name)) {
      this.armed.delete(name);
    } else {
      this.armed.add(name);
    }
    this.syncModifierButtons();
  }

  clearModifiers() {
    if (this.armed.size === 0) {
      return;
    }
    this.armed.clear();
    this.syncModifierButtons();
  }

  syncModifierButtons() {
    for (const definition of KEY_DEFINITIONS) {
      if (!definition.modifier) {
        continue;
      }
      this.buttons.get(definition.id).classList.toggle("active", this.armed.has(definition.modifier));
    }
  }
}

class TerminalApp {
  constructor() {
    this.view = new TerminalView(document.querySelector("#terminal"));
    this.keyBar = new KeyBar(document.querySelector("#keys"), (data, armed) => {
      this.sendInput(applyModifiers(data, armed));
    });
    this.status = document.querySelector("#status");
    this.title = document.querySelector("#title");
    this.overlay = document.querySelector("#overlay");
    this.overlayText = document.querySelector("#overlay-text");
    this.retryButton = document.querySelector("#retry");
    this.socket = new TerminalSocket({
      onOutput: (data) => this.view.write(data),
      onWindowTitle: (title) => this.setTitle(title),
      onOpen: () => this.handleOpen(),
      onClose: () => this.handleClose(),
    });
    this.attempt = 0;
    this.retryTimer = null;
    this.wireControls();
    this.wireViewport();
    this.connect();
  }

  wireControls() {
    document.querySelector("#font-up").addEventListener("click", () => this.changeFontSize(FONT.step));
    document.querySelector("#font-down").addEventListener("click", () => this.changeFontSize(-FONT.step));
    document.querySelector("#theme-toggle").addEventListener("click", () => {
      setScheme(!isDarkScheme());
      this.view.applyTheme();
    });
    this.retryButton.addEventListener("click", () => this.connect());
    this.view.onData((data) => {
      this.sendInput(applyModifiers(data, this.keyBar.activeModifiers));
      this.keyBar.clearModifiers();
    });
    this.view.onResize((columns, rows) => this.socket.sendResize(columns, rows));
  }

  wireViewport() {
    applySavedScheme();
    // The token values change under us when the scheme flips; re-read them.
    new MutationObserver(() => this.view.applyTheme()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const applyHeight = () => {
      const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
      this.view.fit();
    };
    applyHeight();
    window.addEventListener("resize", applyHeight);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyHeight);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.socket.isOpen) {
        this.connect();
      }
    });
  }

  async connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.hideOverlay();
    this.setStatus("connecting");
    this.view.fit();
    try {
      await this.socket.connect(this.view.columns, this.view.rows);
    } catch (error) {
      console.error("[terminal] connect failed", error);
      this.showOverlay("Could not reach the terminal");
      this.scheduleReconnect();
    }
  }

  handleOpen() {
    this.attempt = 0;
    this.setStatus("online");
    this.hideOverlay();
    this.view.fit();
    this.view.focus();
  }

  handleClose() {
    if (this.socket.closedByUser) {
      return;
    }
    this.setStatus("offline");
    this.showOverlay("Connection lost");
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.retryTimer !== null) {
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  sendInput(data) {
    this.socket.sendInput(data);
  }

  changeFontSize(delta) {
    const next = Math.min(FONT.max, Math.max(FONT.min, this.view.fontSize + delta));
    if (next === this.view.fontSize) {
      return;
    }
    localStorage.setItem(FONT.storageKey, String(next));
    this.view.setFontSize(next);
  }

  setTitle(text) {
    const title = text.trim() || "Terminal";
    this.title.textContent = title;
    document.title = title;
  }

  setStatus(state) {
    this.status.dataset.state = state;
  }

  showOverlay(message) {
    this.overlayText.textContent = message;
    this.overlay.hidden = false;
  }

  hideOverlay() {
    this.overlay.hidden = true;
  }
}

function boot() {
  if (!window.Terminal || !window.FitAddon) {
    document.body.textContent = "Terminal assets failed to load.";
    return;
  }
  new TerminalApp();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[terminal] service worker registration failed", error);
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
