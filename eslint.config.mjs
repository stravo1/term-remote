import js from "@eslint/js";
import globals from "globals";

// no-undef is the point: app.js is plain browser JavaScript with no build
// step, so a typo'd or missing function name only fails at runtime — a class
// of bug that once shipped as a terminal that never connected.
export default [
  {
    ignores: ["node_modules/", "app/vendor/"],
  },
  js.configs.recommended,
  {
    files: ["app/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        // UMD globals from the vendored xterm bundles.
        Terminal: "readonly",
        FitAddon: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: ["tests/**/*", "tools/**/*"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
