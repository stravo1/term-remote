import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = join(ROOT, "app");
const appPath = (reference) => join(APP, reference.replace(/^\//, ""));

function read(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

function pngSize(file) {
  const buffer = readFileSync(file);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG", `${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("index.html references assets that exist", () => {
  const references = [...read("app/index.html").matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]);

  assert.ok(references.length >= 5, "index.html should reference the manifest, icons, styles and scripts");
  for (const reference of references) {
    assert.ok(existsSync(appPath(reference)), `missing asset: ${reference}`);
  }
});

test("manifest icons exist and match their declared size", () => {
  const manifest = JSON.parse(read("app/manifest.webmanifest"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === "maskable"),
    "needs a maskable icon",
  );

  for (const icon of manifest.icons) {
    const file = appPath(icon.src);
    assert.ok(existsSync(file), `missing icon: ${icon.src}`);
    const size = pngSize(file);
    assert.equal(`${size.width}x${size.height}`, icon.sizes, `${icon.src} is ${size.width}x${size.height}`);
    assert.equal(size.width, size.height, `${icon.src} must be square`);
  }
});

test("every element id the script expects exists in the markup", () => {
  // A stale cached page paired with a fresh script used to kill the app before
  // it ever connected. This pins the contract between index.html and app.js.
  const markup = read("app/index.html");
  const script = read("app/app.js");

  const wanted = new Set([...script.matchAll(/must\("([\w-]+)"\)/g)].map((match) => match[1]));
  assert.ok(wanted.size >= 5, "the script should look up its elements by id");

  for (const id of wanted) {
    assert.ok(markup.includes(`id="${id}"`), `index.html has no element with id "${id}"`);
  }

  assert.ok(!existsSync(join(ROOT, "app", "sw.js")), "the service worker was removed; do not reintroduce it");
});

test("every template placeholder is substituted by the provisioner", () => {
  const provisioner = read("setup-term-remote.sh");

  for (const template of readdirSync(join(ROOT, "templates"))) {
    const source = readFileSync(join(ROOT, "templates", template), "utf8");
    const tokens = new Set([...source.matchAll(/@([A-Z_]+)@/g)].map((match) => match[1]));
    for (const token of tokens) {
      assert.ok(
        provisioner.includes(`@${token}@`),
        `${template} uses @${token}@ but the provisioner never substitutes it`,
      );
    }
  }
});

test("every key bar button has a key sequence", () => {
  const source = read("app/app.js");
  const definitions = source.match(/const KEY_DEFINITIONS = \[([\s\S]*?)\n\];/);
  const sequences = source.match(/const KEY_SEQUENCES = \{([\s\S]*?)\n\};/);
  assert.ok(definitions && sequences, "app.js should declare key bar definitions and sequences");

  const ids = [...definitions[1].matchAll(/id: "(\w+)"/g)].map((match) => match[1]);
  const modifiers = [...definitions[1].matchAll(/modifier: "(\w+)"/g)].map((match) => match[1]);
  const mapped = new Set([...sequences[1].matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]));

  assert.ok(ids.length >= 10, "the key bar looks too small");
  for (const id of ids) {
    if (modifiers.includes(id)) {
      continue;
    }
    assert.ok(mapped.has(id), `key bar button "${id}" has no entry in KEY_SEQUENCES`);
  }
});

test("the provisioner ships no host-specific defaults", () => {
  const provisioner = read("setup-term-remote.sh");

  assert.match(provisioner, /TERM_REMOTE_DOMAIN:-term\.example\.com/);
  assert.match(provisioner, /AUTHELIA_PORTAL_DOMAIN:-auth\.example\.com/);
  assert.match(provisioner, /require_settings/, "placeholder hostnames must be refused");
  assert.match(provisioner, /load_host_settings/, "the host settings file must be read");
  const isGeneric = (domain) => domain === "github.com" || domain.endsWith("example.com");
  const domains = [...provisioner.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|dev|net|org|io)\b/g)].map(
    (match) => match[0],
  );
  for (const domain of domains) {
    assert.ok(isGeneric(domain), `unexpected hardcoded hostname in the provisioner: ${domain}`);
  }
  assert.ok(existsSync(join(ROOT, "env.example")), "env.example documents the settings file");
});

test("the provisioner migrates blocks written under the old project name", () => {
  const provisioner = read("setup-term-remote.sh");

  assert.match(provisioner, /LEGACY_MARKER_START/);
  assert.match(provisioner, /LEGACY_UNIT_MARKER/);
});

test("the ttyd version has a single owner", () => {
  const version = read("ttyd.version").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `unexpected pinned version: ${version}`);

  const provisioner = read("setup-term-remote.sh");
  assert.ok(provisioner.includes("ttyd.version"), "the provisioner should read ttyd.version");
  assert.doesNotMatch(provisioner, /TTYD_VERSION:-\d/, "the provisioner must not hardcode a ttyd version");
  assert.ok(read("deploy/receive.sh").includes("ttyd.version"), "the deploy receiver should ship ttyd.version");
});

test("the client uses the ttyd command bytes that the protocol test verifies", () => {
  const source = read("app/app.js");

  assert.match(source, /const COMMAND = \{[^}]*input: "0"/);
  assert.match(source, /resize: "1"/);
  assert.match(source, /output: "0"/);
  assert.match(source, /windowTitle: "1"/);
  assert.match(source, /new WebSocket\(socketUrl\(\), \["tty"\]\)/);
  assert.match(source, /AuthToken/);
});

test("the settings dialog offers every theme the script knows", () => {
  const source = read("app/app.js");
  const markup = read("app/index.html");

  const declared = source.match(/const THEME_CHOICES = \[([^\]]*)\]/);
  assert.ok(declared, "app.js should declare the theme choices");
  const choices = [...declared[1].matchAll(/"(\w+)"/g)].map((match) => match[1]);

  assert.ok(choices.includes("system"), "the theme should be able to follow the OS");
  for (const choice of choices) {
    assert.ok(markup.includes(`data-theme-choice="${choice}"`), `the settings dialog has no "${choice}" theme`);
  }
});

test("only a dropped connection offers the Reconnect button", () => {
  const source = read("app/app.js");

  for (const call of source.match(/showNotice\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /isRetryable/, `a transient notice must not offer Reconnect: ${call}`);
  }
  assert.match(source, /showOverlay\("Connection lost", \{ isRetryable: true \}\)/);
  assert.match(source, /showOverlay\("Could not reach the terminal", \{ isRetryable: true \}\)/);
});
