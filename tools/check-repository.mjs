#!/usr/bin/env node
// Repository checks that need no server: shell and JS syntax, Python compile, JSON
// parse, and the executable bit the provisioner and the deploy receiver rely on.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SHELL_SCRIPTS = ["setup-term-remote.sh", "deploy/receive.sh", "deploy/deploy-key.sh"];
const JAVASCRIPT = ["app/app.js", "app/sw.js"];
const PYTHON = ["tools/generate-icons.py"];
const JSON_FILES = ["package.json", "app/manifest.webmanifest"];

const failures = [];

function check(label, action) {
  try {
    action();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`fail ${label}`);
  }
}

function path(file) {
  return join(ROOT, file);
}

for (const script of SHELL_SCRIPTS) {
  check(`bash -n ${script}`, () => execFileSync("bash", ["-n", path(script)], { stdio: "pipe" }));
  check(`${script} is executable`, () => {
    if ((statSync(path(script)).mode & 0o111) === 0) {
      throw new Error("missing the executable bit");
    }
  });
}

for (const file of JAVASCRIPT) {
  check(`node --check ${file}`, () => execFileSync(process.execPath, ["--check", path(file)], { stdio: "pipe" }));
}

for (const file of PYTHON) {
  check(`python compile ${file}`, () =>
    execFileSync(
      "python3",
      ["-c", `compile(open(${JSON.stringify(path(file))}).read(), ${JSON.stringify(file)}, "exec")`],
      {
        stdio: "pipe",
      },
    ),
  );
}

for (const file of JSON_FILES) {
  check(`json parse ${file}`, () => JSON.parse(readFileSync(path(file), "utf8")));
}

check("setup-term-remote.sh sets -euo pipefail", () => {
  const source = readFileSync(path("setup-term-remote.sh"), "utf8");
  if (!source.includes("set -euo pipefail")) {
    throw new Error("missing set -euo pipefail");
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("\nAll repository checks passed.");
