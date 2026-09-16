#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/claude-review.yml"), "utf8");
const example = fs.readFileSync(path.join(root, "examples/github_actions/claude-code.yml"), "utf8");

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert(start >= 0, `missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start + marker.length, end < 0 ? undefined : end);
}

function script(name) {
  const block = step(name).split("        run: |\n")[1];
  assert(block, `step has no shell script: ${name}`);
  return block.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-workflow-"));
  try {
    const env = {
      ...process.env,
      BASH_ENV: "",
      HOME: dir,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: path.join(dir, "outputs"),
      GITHUB_PATH: path.join(dir, "paths"),
      SOURCE_REPOSITORY: "p4u/open-code-review",
      SOURCE_SHA: "a".repeat(40),
      MODEL: "claude-gpt-6-astra",
      GATEWAY_URL: "https://gateway.invalid",
      CLAUDE_VERSION: "2.1.273",
    };
    fn(dir, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(name, env, cwd = env.RUNNER_TEMP) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script(name)], {
    cwd, env, encoding: "utf8", timeout: 10000,
  });
}

function executable(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/bash\nset -euo pipefail\n${content}\n`, { mode: 0o755 });
}

function testConfigurationAndModelSelection() {
  assert(workflow.includes("MODEL: ${{ inputs.model || vars.OCR_MODEL || 'claude-gpt-6-astra' }}"));
  assert(workflow.includes("GATEWAY_URL: ${{ inputs.gateway_url || vars.OCR_GATEWAY_URL }}"));
  const cases = [
    ["opus", "sonnet", "opus"],
    ["", "sonnet", "sonnet"],
    ["", "", "claude-gpt-6-astra"],
    ["sonnet[1m]", "haiku", "sonnet[1m]"],
    ["model; $(touch injected)", "haiku", "model; $(touch injected)"],
  ];
  for (const [input, variable, expected] of cases) {
    fixture((dir, env) => {
      env.MODEL = input || variable || "claude-gpt-6-astra";
      env.SOURCE_SHA = "A".repeat(40);
      const result = run("Validate workflow configuration", env);
      assert.strictEqual(result.status, 0, result.stderr);
      const output = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
      assert(output.includes(`model=${expected}\n`));
      assert(output.includes(`source_sha=${"a".repeat(40)}\n`));
      assert(!fs.existsSync(path.join(dir, "injected")));
    });
  }
}

function testInvalidConfigurationFailsBeforeCheckout() {
  const cases = [
    ["SOURCE_REPOSITORY", "../ocr"],
    ["SOURCE_REPOSITORY", "owner/repo/extra"],
    ["SOURCE_SHA", "main"],
    ["SOURCE_SHA", "a".repeat(39)],
    ["SOURCE_SHA", "g".repeat(40)],
    ["MODEL", ""],
    ["MODEL", "   "],
    ["MODEL", "sonnet\nforged=value"],
    ["MODEL", "sonnet\rforged=value"],
    ["GATEWAY_URL", ""],
    ["GATEWAY_URL", "http://gateway.invalid"],
    ["GATEWAY_URL", "not-a-url"],
    ["GATEWAY_URL", "https://user:fixture-secret@gateway.invalid"],
    ["GATEWAY_URL", "https://gateway.invalid?token=fixture-secret"],
    ["GATEWAY_URL", "https://gateway.invalid#fixture-secret"],
    ["CLAUDE_VERSION", "latest"],
    ["CLAUDE_VERSION", "^2.1.273"],
    ["CLAUDE_VERSION", "2.1.273 --registry=https://elsewhere.invalid"],
  ];
  for (const [name, value] of cases) {
    fixture((dir, env) => {
      const result = run("Validate workflow configuration", { ...env, [name]: value });
      assert.strictEqual(result.status, 1, `${name}: ${result.stderr}`);
      assert(!fs.existsSync(env.GITHUB_OUTPUT), "invalid configuration wrote step outputs");
      assert(!result.stderr.includes("fixture-secret"), "diagnostics leaked URL credentials");
    });
  }
  assert(workflow.indexOf("name: Validate workflow configuration") < workflow.indexOf("name: Checkout trusted review base"));
}

function testTrustedBootstrapAndCredentialScope() {
  assert(workflow.includes("github.event_name == 'pull_request_target'"));
  assert(workflow.includes("github.event.pull_request.head.repo.full_name == github.repository"));
  assert(workflow.includes("github.event.pull_request.user.type != 'Bot'"));
  assert(workflow.includes("!github.event.pull_request.draft"));
  assert(workflow.includes("runs-on: ubuntu-latest"));
  assert(!workflow.includes("self-hosted"));
  assert(workflow.includes("contents: read\n  pull-requests: write"));
  assert(!workflow.includes("contents: write"));
  const base = step("Checkout trusted review base");
  assert(base.includes("ref: ${{ github.event.pull_request.base.sha }}"));
  assert(base.includes("fetch-depth: 0"));
  assert(!workflow.includes("ref: ${{ github.event.pull_request.head.sha }}"));
  const tooling = step("Checkout pinned OCR tooling");
  assert(tooling.includes("ref: ${{ steps.settings.outputs.source_sha }}"));
  assert(tooling.includes("repository: ${{ steps.settings.outputs.source_repository }}"));
  assert(tooling.includes("persist-credentials: false"));
  assert(workflow.indexOf("name: Checkout trusted review base") < workflow.indexOf("name: Checkout pinned OCR tooling"));
  assert(step("Build pinned OCR").includes("working-directory: .ocr-tooling"));
  assert(step("Set up Go").includes("cache: false"));
  assert(step("Install pinned Claude Code").includes("working-directory: ${{ runner.temp }}"));
  const review = step("Review and publish findings");
  assert(review.includes("uses: ./.ocr-tooling"));
  assert(review.includes("ocr_binary: ${{ github.workspace }}/.ocr-tooling/dist/opencodereview"));
  assert(review.includes("skip_checkout: 'true'"));
  assert(review.includes("provider: claude-code"));
  assert(review.includes("llm_model: ${{ steps.settings.outputs.model }}"));
  assert(review.includes("require_complete: 'true'"));
  assert(review.includes("checkpoint_range: 'false'"));
  assert(review.includes("ANTHROPIC_API_KEY: ''"));
  assert(review.includes("claude_auth_token: ${{ secrets.gateway_token }}"));
  assert.strictEqual(workflow.split("${{ secrets.gateway_token }}").length - 1, 1);
  assert(!workflow.includes("ANTHROPIC_AUTH_TOKEN:"), "secret must be an action input scoped to its review shell");
  const uses = [...workflow.matchAll(/uses: (actions\/[^\s]+)/g)].map((match) => match[1]);
  assert(uses.length >= 4);
  for (const action of uses) assert(/@[a-f0-9]{40}$/.test(action), `unpinned action: ${action}`);
}

function testBuildChecksPinnedRevision() {
  for (const matches of [true, false]) {
    fixture((dir, env) => {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, "dist"));
      executable(bin, "git", `printf '%s\\n' '${(matches ? "a" : "b").repeat(40)}'`);
      executable(bin, "make", 'printf "%s\\n" "$@" > "$RUNNER_TEMP/make-args"; touch "$RUNNER_TEMP/built"');
      executable(path.join(dir, "dist"), "opencodereview", 'printf "fixture OCR\\n"');
      const result = run("Build pinned OCR", { ...env, PATH: `${bin}:${env.PATH}` });
      assert.strictEqual(result.status, matches ? 0 : 1, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, "built")), matches);
      if (matches) {
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, "make-args"), "utf8").trim().split("\n"), [
          "build", `VERSION=v1.12.2+fork.${env.SOURCE_SHA}`,
        ], "source builds must work without release tags and retain the full pinned identity");
      }
    });
  }
}

function testPinnedClaudeInstallation() {
  fixture((dir, env) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    executable(bin, "npm", 'printf "%s\\n" "$@" > "$RUNNER_TEMP/npm-args"');
    const installed = path.join(dir, "ocr-claude/node_modules/.bin");
    fs.mkdirSync(installed, { recursive: true });
    executable(installed, "claude", 'printf "fixture Claude\\n"');
    const result = run("Install pinned Claude Code", { ...env, PATH: `${bin}:${env.PATH}` });
    assert.strictEqual(result.status, 0, result.stderr);
    const args = fs.readFileSync(path.join(dir, "npm-args"), "utf8").trim().split("\n");
    assert(args.includes("@anthropic-ai/claude-code@2.1.273"));
    assert(args.includes("https://registry.npmjs.org/"));
    assert(!args.includes("-g"), "bootstrap must not change a persistent runner installation");
    assert.strictEqual(fs.readFileSync(env.GITHUB_PATH, "utf8"), `${installed}\n`);
  });
}

function testPublicationMustSucceed() {
  const cases = [
    ["0", "https://github.com/owner/repo/pull/1#issuecomment-1", 0],
    ["1", "https://github.com/owner/repo/pull/1#issuecomment-1", 1],
    ["", "https://github.com/owner/repo/pull/1#issuecomment-1", 1],
    ["0", "", 1],
    ["not-a-count", "https://github.com/owner/repo/pull/1#issuecomment-1", 1],
  ];
  for (const [count, url, status] of cases) {
    fixture((dir, env) => {
      const result = run("Verify review publication", { ...env, COMMENTS_FAILED: count, SUMMARY_URL: url });
      assert.strictEqual(result.status, status, result.stderr);
    });
  }
}

function testCallerExample() {
  assert(example.includes("pull_request_target:"));
  assert(example.includes("cancel-in-progress: true"));
  assert(example.includes("claude-review.yml@REPLACE_WITH_COMMIT_SHA"));
  assert(example.includes("source_sha: REPLACE_WITH_COMMIT_SHA"));
  assert(example.includes("gateway_token: ${{ secrets.OCR_GATEWAY_AUTH_TOKEN }}"));
  assert(example.includes("# model: claude-gpt-6-astra"));
  assert(!example.includes("secrets: inherit"));
}

const tests = [
  testConfigurationAndModelSelection,
  testInvalidConfigurationFailsBeforeCheckout,
  testTrustedBootstrapAndCredentialScope,
  testBuildChecksPinnedRevision,
  testPinnedClaudeInstallation,
  testPublicationMustSucceed,
  testCallerExample,
];
for (const test of tests) {
  test();
  console.log(`PASS ${test.name}`);
}
console.log(`All ${tests.length} Claude workflow tests passed.`);
