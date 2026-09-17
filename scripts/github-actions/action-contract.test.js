#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

// Contract tests for action.yml's timeout/configuration boundary.
//
// Run via: node scripts/github-actions/action-contract.test.js
//
// The action is a composite action, so these tests use a small YAML extractor
// and execute the real shell blocks with fake `ocr` and `npm` binaries. No
// YAML or test-runner dependency is required.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const ACTION_PATH = path.join(ROOT, "action.yml");
const ACTION_TEXT = fs.readFileSync(ACTION_PATH, "utf8");
const CONTRACT_WORKFLOW_PATH = path.join(ROOT, ".github/workflows/action-contract.yml");
const CONTRACT_WORKFLOW_TEXT = fs.readFileSync(CONTRACT_WORKFLOW_PATH, "utf8");
const EXAMPLE_README_PATH = path.join(ROOT, "examples/github_actions/README.md");
const EXAMPLE_README_TEXT = fs.readFileSync(EXAMPLE_README_PATH, "utf8");

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    try {
      return JSON.parse(value);
    } catch (_err) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseInputs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  assert.ok(start >= 0, "action.yml must define inputs");
  const end = lines.findIndex((line, index) => index > start && /^(outputs|runs):\s*$/.test(line));
  const inputs = {};
  const limit = end >= 0 ? end : lines.length;

  for (let index = start + 1; index < limit; index += 1) {
    const match = /^  ([A-Za-z0-9_]+):\s*$/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    let defaultValue;
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      if (/^  [A-Za-z0-9_]+:\s*$/.test(lines[cursor])) break;
      const defaultMatch = /^    default:\s*(.*)$/.exec(lines[cursor]);
      if (defaultMatch) defaultValue = parseScalar(defaultMatch[1]);
    }
    inputs[name] = { default: defaultValue };
  }
  return inputs;
}

function parseSteps(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^  steps:\s*$/.test(line));
  assert.ok(start >= 0, "action.yml must define composite steps");
  const steps = [];
  let current;

  function finish() {
    if (!current) return;
    const rawLines = current.lines;
    const runDeclarations = rawLines
      .map((line, index) => (/^\s*run:\s*/.test(line) ? { line, index } : undefined))
      .filter(Boolean);
    assert.ok(runDeclarations.length <= 1, `step ${current.name} must not define multiple run blocks`);
    let run;
    if (runDeclarations.length === 1) {
      const { line, index: runMarker } = runDeclarations[0];
      assert.match(line, /^      run:\s*\|\s*$/, `step ${current.name} uses an unsupported run scalar`);
      const body = [];
      for (let index = runMarker + 1; index < rawLines.length; index += 1) {
        const line = rawLines[index];
        if (line.trim() === "") {
          body.push("");
        } else if (/^        /.test(line)) {
          body.push(line.slice(8));
        } else {
          break;
        }
      }
      run = body.join("\n");
    }

    const env = {};
    const envDeclarations = rawLines
      .map((line, index) => (/^\s*env:\s*$/.test(line) ? { line, index } : undefined))
      .filter(Boolean);
    assert.ok(envDeclarations.length <= 1, `step ${current.name} must not define multiple env blocks`);
    const envMarker = envDeclarations.length === 1 ? envDeclarations[0].index : -1;
    if (envMarker >= 0) {
      assert.match(
        envDeclarations[0].line,
        /^      env:\s*$/,
        `step ${current.name} uses unsupported env indentation`
      );
      for (let index = envMarker + 1; index < rawLines.length; index += 1) {
        const line = rawLines[index];
        if (line.trim() === "") continue;
        // A `#` comment is legal YAML inside a mapping block, and the env
        // blocks use them to record why a value is wired the way it is.
        if (/^\s*#/.test(line)) continue;
        if (/^      [A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line)) break;
        const match = /^        ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        assert.ok(match, `step ${current.name} contains an unsupported env value or indentation`);
        assert.doesNotMatch(
          match[2],
          /^(?:\||>|\|-|>-|\|\+|>\+)$/,
          `step ${current.name} contains an unsupported multiline env value`
        );
        env[match[1]] = parseScalar(match[2]);
      }
    }

    steps.push({ name: current.name, run, env, index: current.index, raw: rawLines.join("\n") });
    current = undefined;
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^    -(?:\s|$)/.test(lines[index]) && !/^    - name:\s*/.test(lines[index])) {
      assert.fail(`unsupported nameless composite step at line ${index + 1}`);
    }
    if (/^\s*-\s+name:\s*/.test(lines[index]) && !/^    - name:\s*/.test(lines[index])) {
      assert.fail(`unsupported composite step indentation at line ${index + 1}`);
    }
    const match = /^    - name:\s*(.*)\s*$/.exec(lines[index]);
    if (match) {
      finish();
      current = { name: parseScalar(match[1]), lines: [lines[index]], index };
    } else if (current) {
      current.lines.push(lines[index]);
    }
  }
  finish();
  const names = steps.map((step) => step.name);
  assert.strictEqual(new Set(names).size, names.length, "composite step names must be unique");
  return steps;
}

const INPUTS = parseInputs(ACTION_TEXT);
const STEPS = parseSteps(ACTION_TEXT);

function inputValues(overrides = {}) {
  const values = {};
  for (const [name, definition] of Object.entries(INPUTS)) {
    if (definition.default !== undefined) values[name] = definition.default;
  }
  return Object.assign(values, overrides);
}

function resolveInputExpressions(value, values, stepOutputs = {}) {
  const resolved = String(value)
    .replace(/\$\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => {
      return values[name] === undefined ? "" : String(values[name]);
    })
    // A step output reads as "" when the step was skipped or never set it,
    // which is the case these contracts exercise; `stepOutputs` overrides it
    // where a test needs the range actually resolved. Other contexts
    // (github.*, env.*) stay unresolved and still fail closed below.
    .replace(/\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/g, (_match, id, name) => {
      const value = (stepOutputs[id] || {})[name];
      return value === undefined ? "" : String(value);
    });
  assert.doesNotMatch(resolved, /\$\{\{[^}]+\}\}/, "unsupported or unresolved action expression");
  return resolved;
}

function renderedEnv(step, values, stepOutputs = {}) {
  const env = {};
  for (const [name, value] of Object.entries(step.env || {})) {
    env[name] = resolveInputExpressions(value, values, stepOutputs);
  }
  return env;
}

function renderedRun(step, values) {
  assert.ok(step && typeof step.run === "string", `step ${step ? step.name : "<missing>"} must have a bash run block`);
  return resolveInputExpressions(step.run, values);
}

function stepNamed(name) {
  return STEPS.find((step) => step.name === name);
}

function validationStep() {
  return STEPS.find((step) => {
    const haystack = `${step.name}\n${step.run || ""}`;
    return /review(?:[ _-]?task)?[ _-]?timeout/i.test(haystack);
  });
}

function installStep() {
  return STEPS.find((step) => /install\s+opencode|install\s+open.?code.?review/i.test(step.name));
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-code-review-action-contract-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const callsPath = path.join(dir, "calls.jsonl");
  const npmCallsPath = path.join(dir, "npm-calls.jsonl");
  const configPath = path.join(dir, "config.jsonl");
  const resultPath = path.join(dir, "ocr-result.json");
  const stderrPath = path.join(dir, "ocr-stderr.log");

  const ocrScript = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const env = {};
for (const name of [
  "HOME", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "OCR_NO_UPDATE",
  "OCR_LLM_TIMEOUT", "OCR_LLM_EXTRA_HEADERS", "REVIEW_TASK_TIMEOUT", "OCR_TIMEOUT",
  "OCR_LLM_URL", "OCR_LLM_MODEL", "OCR_USE_ANTHROPIC", "OCR_LLM_AUTH_HEADER",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
const configFile = process.env.HOME + "/.opencodereview/config.json";
const savedConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
const record = {
  args, env, executable: process.argv[1], savedConfig,
  hasOCRToken: Object.prototype.hasOwnProperty.call(process.env, "OCR_LLM_TOKEN"),
  hasGatewayInput: Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_AUTH_TOKEN_INPUT"),
};
fs.appendFileSync(process.env.OCR_CALLS, JSON.stringify(record) + "\\n");
if (args[0] === "config" && args[1] === "set") {
  fs.appendFileSync(process.env.OCR_CONFIG, JSON.stringify(args) + "\\n");
  process.stdout.write("ocr config set " + args.slice(2).join(" ") + "\\n");
  fs.mkdirSync(require("path").dirname(configFile), { recursive: true });
  savedConfig[args[2]] = args[3];
  fs.writeFileSync(configFile, JSON.stringify(savedConfig));
} else if (args[0] === "config" && args[1] === "unset") {
  fs.appendFileSync(process.env.OCR_CONFIG, JSON.stringify(args) + "\\n");
  process.stdout.write("ocr config unset " + args.slice(2).join(" ") + "\\n");
} else if (args[0] === "version") {
  const output = Object.prototype.hasOwnProperty.call(process.env, "OCR_FAKE_VERSION_OUTPUT")
    ? process.env.OCR_FAKE_VERSION_OUTPUT
    : "open-code-review 1.9.10 contract-test/fixture";
  process.stdout.write(output);
  if (output && !output.endsWith("\\n")) process.stdout.write("\\n");
  process.exit(Number(process.env.OCR_FAKE_VERSION_STATUS || 0));
} else if (args[0] === "review") {
  process.stdout.write(JSON.stringify({ comments: [], warnings: [], message: process.env.OCR_FAKE_REVIEW_MESSAGE }));
  process.stderr.write(process.env.OCR_FAKE_REVIEW_STDERR || "");
  process.exit(Number(process.env.OCR_FAKE_REVIEW_STATUS || 0));
} else {
  process.stdout.write("ocr " + args.join(" ") + "\\n");
}
`;
  const npmScript = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OCR_NPM_CALLS, JSON.stringify(args) + "\\n");
process.stdout.write("npm " + args.join(" ") + "\\n");
`;
  for (const [name, body] of [["ocr", ocrScript], ["npm", npmScript]]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, body, { mode: 0o755 });
  }

  return { dir, bin, home, workspace, callsPath, npmCallsPath, configPath, resultPath, stderrPath };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

function runShell(script, env, fixture) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OCR_|ANTHROPIC_|CLAUDE_|GIT_|GITHUB_)/.test(name)
  ));
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: fixture.workspace,
    env: Object.assign({}, inherited, {
      PATH: `${fixture.bin}:${process.env.PATH || ""}`,
      HOME: fixture.home,
      RUNNER_TEMP: fixture.dir,
      OCR_EXECUTABLE: path.join(fixture.bin, "ocr"),
      OCR_CALLS: fixture.callsPath,
      OCR_NPM_CALLS: fixture.npmCallsPath,
      OCR_CONFIG: fixture.configPath,
      GITHUB_WORKSPACE: fixture.workspace,
      GITHUB_ACTION_PATH: ROOT,
      GITHUB_OUTPUT: path.join(fixture.dir, "github-output"),
      GITHUB_ENV: path.join(fixture.dir, "github-env"),
    }, env),
    encoding: "utf8",
  });
  return result;
}

function initializeReviewOutputs(fixture, extraEnv = {}) {
  fixture.initializationCount = (fixture.initializationCount || 0) + 1;
  const outputFile = path.join(fixture.dir, `review-files-${fixture.initializationCount}.out`);
  const result = runShell(stepNamed("Initialize review outputs").run, {
    ...extraEnv, GITHUB_OUTPUT: outputFile,
  }, fixture);
  assert.strictEqual(result.status, 0, resultDescription(result));
  const outputs = readEnvAssignments(outputFile);
  fixture.resultPath = outputs.result_path;
  fixture.stderrPath = outputs.stderr_path;
  return outputs;
}

function runStep(step, values, fixture, extraEnv = {}, options = {}) {
  const stepOutputs = { ...options.stepOutputs };
  if (options.initializeReviewOutputs) {
    stepOutputs.review_files = initializeReviewOutputs(fixture);
  }
  return runShell(renderedRun(step, values), Object.assign({}, renderedEnv(step, values, stepOutputs), extraEnv), fixture);
}

function resultDescription(result) {
  return `status=${result.status}; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}`;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readEnvAssignments(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function configValues(calls) {
  const values = {};
  for (const args of calls) {
    if (!Array.isArray(args) || args.length < 2) continue;
    if (args[0] !== "config" || args[1] !== "set") continue;
    const key = args[2];
    const value = args[3];
    if (key) values[key] = value;
  }
  return values;
}

function configOperations(fixture) {
  return readJsonLines(fixture.configPath);
}

function allFixtureFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...allFixtureFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function escapedRegExp(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function assertValidation(value, expectedValid) {
  const step = validationStep();
  assert.ok(step, "action.yml must add a validation step that references review_task_timeout");
  const fixture = makeFixture();
  try {
    const result = runStep(step, inputValues({ review_task_timeout: value }), fixture);
    if (expectedValid) {
      assert.strictEqual(result.status, 0, `review_task_timeout=${JSON.stringify(value)} should be accepted; ${resultDescription(result)}`);
    } else {
      assert.notStrictEqual(result.status, 0, `review_task_timeout=${JSON.stringify(value)} should be rejected; ${resultDescription(result)}`);
    }
  } finally {
    removeFixture(fixture);
  }
}

function testReviewTaskTimeoutInputNameAndScope() {
  assert.ok(INPUTS.review_task_timeout, "action.yml must define the review_task_timeout input");
  assert.ok(!INPUTS.review_timeout, "the not-yet-released review_timeout input must be renamed");
  assert.strictEqual(
    INPUTS.review_task_timeout.default,
    "15",
    "review_task_timeout default must remain 15 minutes"
  );
  const inputBlock = ACTION_TEXT.match(
    /^  review_task_timeout:\s*$([\s\S]*?)(?=^  [A-Za-z0-9_]+:\s*$|^outputs:|^runs:)/m
  );
  assert.ok(inputBlock, "action.yml must expose review_task_timeout metadata");
  assert.match(
    inputBlock[1],
    /per-(?:file|task)|concurrent task/i,
    "review_task_timeout must describe its per-file/per-task scope"
  );
  assert.doesNotMatch(
    inputBlock[1],
    /whole[- ]review|wall[- ]clock cap/i,
    "review_task_timeout must not promise a whole-review wall-clock cap"
  );
}

function testLlmTimeoutInputDefault() {
  assert.ok(INPUTS.llm_timeout, "action.yml must define the llm_timeout input");
  assert.strictEqual(INPUTS.llm_timeout.default, "300", "llm_timeout default must match the CLI's 5-minute timeout");
}

function testReviewTimeoutValidationAcceptsBoundaries() {
  for (const value of ["1", "10", "120"]) assertValidation(value, true);
}

function testReviewTimeoutValidationRejectsMalformedValues() {
  for (const value of ["", "1.5", "+10", "0", "-1", "-10", "121"]) {
    assertValidation(value, false);
  }
}

function testValidationPrecedesNpmInstall() {
  const validation = validationStep();
  const install = installStep();
  assert.ok(validation, "action.yml must add review_task_timeout validation before installation");
  assert.ok(install, "action.yml must retain an OpenCodeReview installation step");
  assert.ok(validation.index < install.index, "review_task_timeout validation must occur before NPM install");

  const fixture = makeFixture();
  try {
    const values = inputValues({ review_task_timeout: "121", ocr_version: "contract-test" });
    const script = `${renderedRun(validation, values)}\n${renderedRun(install, values)}`;
    const env = Object.assign({}, renderedEnv(validation, values), renderedEnv(install, values));
    const result = runShell(script, env, fixture);
    assert.notStrictEqual(result.status, 0, `invalid review_task_timeout must stop the action; ${resultDescription(result)}`);
    assert.deepStrictEqual(readJsonLines(fixture.npmCallsPath), [], "NPM must not run after timeout validation fails");
  } finally {
    removeFixture(fixture);
  }
}

function testReviewTimeoutForwardedSeparatelyFromLlmTimeout() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      review_task_timeout: "10",
      llm_timeout: "900",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: values.review_task_timeout },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const timeoutIndices = reviewCall.args
      .map((arg, index) => (arg === "--timeout" ? index : -1))
      .filter((index) => index >= 0);
    assert.strictEqual(
      timeoutIndices.length,
      1,
      `review timeout must be forwarded exactly once; args=${JSON.stringify(reviewCall.args)}`
    );
    assert.strictEqual(reviewCall.args[timeoutIndices[0] + 1], "10", "review_task_timeout must be passed as --timeout");
    assert.strictEqual(reviewCall.env.OCR_LLM_TIMEOUT, "900", "llm_timeout must remain the LLM request timeout");
    assert.notStrictEqual(
      reviewCall.args[timeoutIndices[0] + 1],
      reviewCall.env.OCR_LLM_TIMEOUT,
      "review_task_timeout and llm_timeout must remain distinct settings"
    );
  } finally {
    removeFixture(fixture);
  }
}

function testDefaultLlmTimeoutExportedSeparatelyFromReviewTimeout() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      review_task_timeout: "10",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: values.review_task_timeout },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const timeoutIndex = reviewCall.args.indexOf("--timeout");
    assert.ok(timeoutIndex >= 0, "Run OpenCodeReview must forward review_task_timeout");
    assert.strictEqual(reviewCall.args[timeoutIndex + 1], "10");
    assert.strictEqual(reviewCall.env.OCR_LLM_TIMEOUT, "300");
    assert.notStrictEqual(reviewCall.args[timeoutIndex + 1], reviewCall.env.OCR_LLM_TIMEOUT);
  } finally {
    removeFixture(fixture);
  }
}

function testEmptyLlmTimeoutNormalizesBeforeReviewInvocation() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      review_task_timeout: "10",
      llm_timeout: "",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: values.review_task_timeout },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const timeoutIndex = reviewCall.args.indexOf("--timeout");
    assert.strictEqual(reviewCall.env.OCR_LLM_TIMEOUT, "300");
    assert.strictEqual(reviewCall.args[timeoutIndex + 1], "10");
    assert.notStrictEqual(reviewCall.args[timeoutIndex + 1], reviewCall.env.OCR_LLM_TIMEOUT);
  } finally {
    removeFixture(fixture);
  }
}

function testReviewTimeoutLeadingZeroIsNormalizedAcrossSteps() {
  const validation = validationStep();
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(validation, "action.yml must retain review_task_timeout validation");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      review_task_timeout: "010",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const validationResult = runStep(validation, values, fixture);
    assert.strictEqual(
      validationResult.status,
      0,
      `review_task_timeout=010 validation failed; ${resultDescription(validationResult)}`
    );
    const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
    assert.strictEqual(exported.REVIEW_TASK_TIMEOUT, "10", "validation must export normalized decimal review_task_timeout");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(run.env, "REVIEW_TASK_TIMEOUT"),
      "Run OpenCodeReview must consume the normalized GITHUB_ENV value, not rebind the raw input"
    );
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: exported.REVIEW_TASK_TIMEOUT },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const timeoutIndex = reviewCall.args.indexOf("--timeout");
    assert.strictEqual(reviewCall.args[timeoutIndex + 1], "10");
  } finally {
    removeFixture(fixture);
  }
}

function testValidateInputsRejectsInvalidEffortAndBudget() {
  const validation = validationStep();
  assert.ok(validation, "action.yml must retain input validation");
  const cases = [
    [{ effort: "extreme" }, /effort must be one of/],
    [{ effort: "max" }, /effort must be one of/],
    [{ max_tokens_budget: "-5" }, /max_tokens_budget must be/],
    [{ max_tokens_budget: "10.5" }, /max_tokens_budget must be/],
    [{ max_tokens_budget: "abc" }, /max_tokens_budget must be/],
  ];
  for (const [overrides, pattern] of cases) {
    const fixture = makeFixture();
    try {
      const result = runStep(validation, inputValues(overrides), fixture);
      assert.notStrictEqual(
        result.status,
        0,
        `inputs ${JSON.stringify(overrides)} should be rejected; ${resultDescription(result)}`
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        pattern,
        `rejection for ${JSON.stringify(overrides)} must name the offending input; ${resultDescription(result)}`
      );
    } finally {
      removeFixture(fixture);
    }
  }
}

function testEffortAndBudgetNormalizeAndForwardAcrossSteps() {
  const validation = validationStep();
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(validation, "action.yml must retain input validation");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      effort: "HIGH",
      max_tokens_budget: "010000",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const validationResult = runStep(validation, values, fixture);
    assert.strictEqual(validationResult.status, 0, `validation failed; ${resultDescription(validationResult)}`);
    const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
    assert.strictEqual(exported.EFFORT, "high", "validation must export lowercase effort");
    assert.strictEqual(
      exported.MAX_TOKENS_BUDGET,
      "10000",
      "validation must export normalized decimal max_tokens_budget"
    );
    const result = runStep(
      run,
      values,
      fixture,
      {
        MERGE_BASE: "base-sha",
        HEAD_SHA: "head-sha",
        REVIEW_TASK_TIMEOUT: exported.REVIEW_TASK_TIMEOUT,
        EFFORT: exported.EFFORT,
        MAX_TOKENS_BUDGET: exported.MAX_TOKENS_BUDGET,
      },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const effortIndex = reviewCall.args.indexOf("--effort");
    assert.ok(effortIndex >= 0, "Run OpenCodeReview must forward --effort");
    assert.strictEqual(reviewCall.args[effortIndex + 1], "high");
    const budgetIndex = reviewCall.args.indexOf("--max-tokens-budget");
    assert.ok(budgetIndex >= 0, "Run OpenCodeReview must forward --max-tokens-budget");
    assert.strictEqual(reviewCall.args[budgetIndex + 1], "10000");
  } finally {
    removeFixture(fixture);
  }
}

function testZeroMaxTokensBudgetNormalizesToUnlimited() {
  const validation = validationStep();
  assert.ok(validation, "action.yml must retain input validation");
  const fixture = makeFixture();
  try {
    const result = runStep(validation, inputValues({ max_tokens_budget: "0" }), fixture);
    assert.strictEqual(result.status, 0, `validation failed; ${resultDescription(result)}`);
    const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
    assert.strictEqual(exported.MAX_TOKENS_BUDGET, "", "max_tokens_budget=0 must normalize to unlimited (empty)");
  } finally {
    removeFixture(fixture);
  }
}

function testEmptyEffortAndBudgetOmitTheFlags() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      {
        MERGE_BASE: "base-sha",
        HEAD_SHA: "head-sha",
        REVIEW_TASK_TIMEOUT: "15",
        EFFORT: "",
        MAX_TOKENS_BUDGET: "",
      },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    assert.ok(!reviewCall.args.includes("--effort"), "empty effort must omit --effort so the CLI default applies");
    assert.ok(
      !reviewCall.args.includes("--max-tokens-budget"),
      "empty max_tokens_budget must omit --max-tokens-budget so the CLI default applies"
    );
  } finally {
    removeFixture(fixture);
  }
}

function testValidateInputsRejectsInvalidReasoningEffort() {
  const validation = validationStep();
  assert.ok(validation, "action.yml must retain input validation");
  for (const value of ["extreme", "1", "reasoning"]) {
    const fixture = makeFixture();
    try {
      const result = runStep(validation, inputValues({ llm_reasoning_effort: value }), fixture);
      assert.notStrictEqual(
        result.status,
        0,
        `llm_reasoning_effort=${JSON.stringify(value)} should be rejected; ${resultDescription(result)}`
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /llm_reasoning_effort must be one of/,
        `rejection for llm_reasoning_effort=${JSON.stringify(value)} must name the input; ${resultDescription(result)}`
      );
    } finally {
      removeFixture(fixture);
    }
  }
  const fixture = makeFixture();
  try {
    const result = runStep(validation, inputValues({ llm_reasoning_effort: "MAX" }), fixture);
    assert.strictEqual(result.status, 0, `llm_reasoning_effort=MAX should be accepted; ${resultDescription(result)}`);
    const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
    assert.strictEqual(exported.LLM_REASONING_EFFORT, "max", "validation must export lowercase llm_reasoning_effort");
  } finally {
    removeFixture(fixture);
  }
}

function testStreamProgressInputDefaultsToFalse() {
  assert.ok(INPUTS.stream_progress, "action.yml must define the stream_progress input");
  assert.strictEqual(
    INPUTS.stream_progress.default,
    "false",
    "stream_progress must default to 'false' so live progress stays opt-in"
  );
  const inputBlock = ACTION_TEXT.match(
    /^  stream_progress:\s*$([\s\S]*?)(?=^  [A-Za-z0-9_]+:\s*$|^outputs:|^runs:)/m
  );
  assert.ok(inputBlock, "action.yml must expose stream_progress metadata");
  assert.match(inputBlock[1], /\[ocr\].*progress|progress.*\[ocr\]/i, "stream_progress must describe the [ocr] progress lines");
}

function testValidateInputsValidatesStreamProgress() {
  const validation = validationStep();
  assert.ok(validation, "action.yml must retain input validation");
  for (const value of ["yes", "1", "on"]) {
    const fixture = makeFixture();
    try {
      const result = runStep(validation, inputValues({ stream_progress: value }), fixture);
      assert.notStrictEqual(
        result.status,
        0,
        `stream_progress=${JSON.stringify(value)} should be rejected; ${resultDescription(result)}`
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /stream_progress must be one of/,
        `rejection for stream_progress=${JSON.stringify(value)} must name the input; ${resultDescription(result)}`
      );
    } finally {
      removeFixture(fixture);
    }
  }
  const acceptance = [
    ["TRUE", "true"],
    ["", "false"],
  ];
  for (const [value, expected] of acceptance) {
    const fixture = makeFixture();
    try {
      const result = runStep(validation, inputValues({ stream_progress: value }), fixture);
      assert.strictEqual(result.status, 0, `stream_progress=${JSON.stringify(value)} should be accepted; ${resultDescription(result)}`);
      const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
      assert.strictEqual(
        exported.STREAM_PROGRESS,
        expected,
        `validation must export ${JSON.stringify(expected)} for stream_progress=${JSON.stringify(value)}`
      );
    } finally {
      removeFixture(fixture);
    }
  }
}

function testRunKeepsAgentAudienceAndLogFileByDefault() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  assert.match(
    run.run,
    /STREAM_PROGRESS:-false\}" = "true" \]; then\s+OCR_STDERR_FIFO="\$OCR_OUTPUT_DIR\/stderr\.fifo"\s+mkfifo "\$OCR_STDERR_FIFO" \|\| exit 1\s+tee "\$OCR_STDERR_PATH" < "\$OCR_STDERR_FIFO" >&2 &\s+TEE_PID=\$!\s+echo "started=true" >> "\$GITHUB_OUTPUT"\s+"\$OCR_EXECUTABLE" review "\$\{ARGS\[@\]\}" > "\$OCR_RESULT_PATH" 2> "\$OCR_STDERR_FIFO"\s+OCR_EXIT_CODE=\$\?\s+wait "\$TEE_PID"\s+rm -f "\$OCR_STDERR_FIFO"\s+else\s+echo "started=true" >> "\$GITHUB_OUTPUT"\s+"\$OCR_EXECUTABLE" review "\$\{ARGS\[@\]\}" > "\$OCR_RESULT_PATH" 2> "\$OCR_STDERR_PATH"/,
    "the live-tee path must be gated on stream_progress, flush the FIFO-fed tee via wait, and the default path must redirect stderr to the log file"
  );
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: "15" },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    const audienceIndex = reviewCall.args.indexOf("--audience");
    assert.ok(audienceIndex >= 0, "the default path must keep --audience agent");
    assert.strictEqual(reviewCall.args[audienceIndex + 1], "agent");
    assert.ok(fs.existsSync(fixture.stderrPath), "the default path must still capture stderr to the log file");
  } finally {
    removeFixture(fixture);
  }
}

function testRunStreamsProgressWhenOptedIn() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: "15", STREAM_PROGRESS: "true" },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    assert.ok(!reviewCall.args.includes("--audience"), "stream_progress=true must drop --audience agent");
    assert.ok(fs.existsSync(fixture.stderrPath), "the streaming path must still capture stderr to the log file");
  } finally {
    removeFixture(fixture);
  }
}

function testLlmExtraBodyDefaultDisablesThinking() {
  assert.ok(INPUTS.llm_extra_body, "action.yml must define the llm_extra_body input");
  assert.strictEqual(
    INPUTS.llm_extra_body.default,
    '{"thinking": {"type": "disabled"}}',
    "llm_extra_body default must disable thinking mode; enabling it must be an explicit opt-in"
  );
}

function testConfigureMergesReasoningEffortIntoExtraBody() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const baseValues = {
    llm_url: "https://llm.example.invalid/v1",
    llm_model: "contract-model",
    llm_use_anthropic: "false",
    llm_auth_token: "unused-token",
  };
  const cases = [
    [
      "the default body disables thinking when nothing is set",
      {},
      {},
      { thinking: { type: "disabled" } },
    ],
    [
      "the effort merges into the default body",
      {},
      { LLM_REASONING_EFFORT: "low" },
      { thinking: { type: "disabled" }, reasoning_effort: "low" },
    ],
    [
      "an explicitly empty extra_body still receives the effort",
      { llm_extra_body: "" },
      { LLM_REASONING_EFFORT: "low" },
      { reasoning_effort: "low" },
    ],
    [
      "an explicit extra_body key wins over the input",
      { llm_extra_body: '{"reasoning_effort":"high"}' },
      { LLM_REASONING_EFFORT: "low" },
      { reasoning_effort: "high" },
    ],
    [
      "merges alongside existing extra_body keys",
      { llm_extra_body: '{"thinking":{"type":"enabled"}}' },
      { LLM_REASONING_EFFORT: "max" },
      { thinking: { type: "enabled" }, reasoning_effort: "max" },
    ],
  ];
  for (const [label, overrides, extraEnv, expected] of cases) {
    const fixture = makeFixture();
    try {
      const values = inputValues(Object.assign({}, baseValues, overrides));
      const result = runStep(configure, values, fixture, extraEnv);
      assert.strictEqual(result.status, 0, `Configure OCR failed for "${label}"; ${resultDescription(result)}`);
      const configured = configValues(readJsonLines(fixture.configPath));
      const body =
        typeof configured["llm.extra_body"] === "string"
          ? JSON.parse(configured["llm.extra_body"])
          : configured["llm.extra_body"];
      assert.deepStrictEqual(body, expected, `extra_body mismatch for "${label}"`);
    } finally {
      removeFixture(fixture);
    }
  }
}

function testConfigureRejectsReasoningEffortOnAnthropic() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "true",
      llm_auth_token: "unused-token",
    });
    const result = runStep(configure, values, fixture, { LLM_REASONING_EFFORT: "low" });
    assert.notStrictEqual(result.status, 0, "Configure OCR must reject llm_reasoning_effort on the anthropic protocol");
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /::error::llm_reasoning_effort is supported only with OpenAI-compatible protocols/,
      `the failure must name the llm_reasoning_effort input; ${resultDescription(result)}`
    );
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureRejectsMalformedExtraBodyWithActionableError() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: "unused-token",
      llm_extra_body: "{not json",
    });
    const result = runStep(configure, values, fixture, { LLM_REASONING_EFFORT: "low" });
    assert.notStrictEqual(result.status, 0, "Configure OCR must fail on malformed llm_extra_body");
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /::error::llm_extra_body is not valid JSON/,
      `the failure must name the llm_extra_body input; ${resultDescription(result)}`
    );
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureRejectsNonObjectExtraBody() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  for (const extraBody of ["null", "[]", "5", '"text"']) {
    const fixture = makeFixture();
    try {
      const values = inputValues({
        llm_url: "https://llm.example.invalid/v1",
        llm_model: "contract-model",
        llm_use_anthropic: "false",
        llm_auth_token: "unused-token",
        llm_extra_body: extraBody,
      });
      const result = runStep(configure, values, fixture, { LLM_REASONING_EFFORT: "low" });
      assert.notStrictEqual(
        result.status,
        0,
        `Configure OCR must fail on non-object llm_extra_body=${extraBody}; ${resultDescription(result)}`
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /::error::llm_extra_body must be a JSON object/,
        `the failure must name the llm_extra_body input for ${extraBody}; ${resultDescription(result)}`
      );
    } finally {
      removeFixture(fixture);
    }
  }
}

function testConfigureBuildsCompleteLlmConfig() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const extraBody = '{"thinking":{"type":"disabled"},"contract":"yes"}';
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: "configure-token-sentinel",
      llm_extra_body: extraBody,
      language: "English",
    });
    const result = runStep(configure, values, fixture, { OCR_LLM_TOKEN: values.llm_auth_token });
    assert.strictEqual(result.status, 0, `Configure OCR shell block failed; ${resultDescription(result)}`);
    const configured = configValues(readJsonLines(fixture.configPath));
    assert.strictEqual(configured["llm.url"], values.llm_url);
    assert.strictEqual(configured["llm.model"], values.llm_model);
    assert.strictEqual(configured["llm.use_anthropic"], values.llm_use_anthropic);
    assert.strictEqual(typeof configured["llm.auth_token_cmd"], "string", "llm.auth_token_cmd must be configured");
    assert.match(configured["llm.auth_token_cmd"], /OCR_LLM_TOKEN/, "auth_token_cmd must reference the token env var");
    const configuredExtraBody =
      typeof configured["llm.extra_body"] === "string"
        ? JSON.parse(configured["llm.extra_body"])
        : configured["llm.extra_body"];
    assert.deepStrictEqual(configuredExtraBody, JSON.parse(extraBody));
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureNeverPersistsToken() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const token = "configure-token-sentinel-DO-NOT-PERSIST";
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: token,
      llm_extra_body: '{"thinking":{"type":"disabled"}}',
    });
    const result = runStep(configure, values, fixture, { OCR_LLM_TOKEN: token });
    assert.strictEqual(result.status, 0, `Configure OCR shell block failed; ${resultDescription(result)}`);
    const outputAndFiles = [result.stdout, result.stderr];
    for (const file of allFixtureFiles(fixture.dir)) outputAndFiles.push(fs.readFileSync(file, "utf8"));
    const leaked = outputAndFiles.join("\n");
    assert.doesNotMatch(leaked, escapedRegExp(token), "the token must not appear in config output or files");

    const configured = configValues(readJsonLines(fixture.configPath));
    assert.ok(configured["llm.auth_token_cmd"], "only an auth_token_cmd should be stored for the token");
    assert.match(configured["llm.auth_token_cmd"], /OCR_LLM_TOKEN/);
    assert.doesNotMatch(configured["llm.auth_token_cmd"], escapedRegExp(token));
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureNeutralizesStaleProviderAndStaticToken() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: "config-token-sentinel",
      llm_auth_header: "x-api-key",
      llm_extra_body: '{"thinking":{"type":"disabled"}}',
    });
    const result = runStep(configure, values, fixture);
    assert.strictEqual(result.status, 0, `Configure OCR shell block failed; ${resultDescription(result)}`);
    const operations = configOperations(fixture);
    const unsetProviderIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "unset" && args[2] === "provider"
    );
    const clearStaticTokenIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.auth_token" && args[3] === ""
    );
    const setTokenCmdIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.auth_token_cmd"
    );
    const firstLegacySetIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && String(args[2]).startsWith("llm.")
    );
    assert.ok(unsetProviderIndex >= 0, "Configure OCR must unset a stale active provider");
    assert.ok(clearStaticTokenIndex >= 0, "Configure OCR must clear stale static llm.auth_token");
    assert.ok(setTokenCmdIndex >= 0, "Configure OCR must configure auth_token_cmd");
    assert.ok(unsetProviderIndex < firstLegacySetIndex, "provider must be unset before legacy llm config is built");
    assert.ok(clearStaticTokenIndex < setTokenCmdIndex, "static token must be cleared before auth_token_cmd is set");

    const configured = configValues(operations);
    assert.strictEqual(configured["llm.auth_header"], "x-api-key", "custom auth header must be stored in llm config");
    assert.strictEqual(configured["llm.protocol"], "openai", "false llm_use_anthropic must set the OpenAI protocol");
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureProtocolTracksUseAnthropic() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  for (const [useAnthropic, expectedProtocol] of [["true", "anthropic"], ["false", "openai"]]) {
    const fixture = makeFixture();
    try {
      const values = inputValues({
        llm_url: "https://llm.example.invalid/v1",
        llm_model: "contract-model",
        llm_use_anthropic: useAnthropic,
        llm_auth_token: "protocol-token-sentinel",
      });
      const result = runStep(configure, values, fixture);
      assert.strictEqual(result.status, 0, `Configure OCR failed for llm_use_anthropic=${useAnthropic}; ${resultDescription(result)}`);
      const configured = configValues(configOperations(fixture));
      assert.strictEqual(configured["llm.use_anthropic"], useAnthropic);
      assert.strictEqual(configured["llm.protocol"], expectedProtocol);
    } finally {
      removeFixture(fixture);
    }
  }
}

function testConfigurePreservesLegacyUseAnthropicResolution() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const inputBlock = ACTION_TEXT.match(
    /^  llm_use_anthropic:\s*$([\s\S]*?)(?=^  [A-Za-z0-9_]+:\s*$|^outputs:|^runs:)/m
  );
  assert.ok(inputBlock, "action.yml must expose llm_use_anthropic metadata");
  assert.match(
    inputBlock[1],
    /explicitly\s+supplied\s+empty\s+string/i,
    "llm_use_anthropic docs must distinguish an explicit empty value from omitting the required input"
  );
  const cases = [
    ["true", "true", "anthropic"],
    ["TRUE", "true", "anthropic"],
    ["1", "true", "anthropic"],
    ["yes", "true", "anthropic"],
    ["YeS", "true", "anthropic"],
    ["", "true", "anthropic"],
    ["false", "false", "openai"],
    ["FALSE", "false", "openai"],
    ["0", "false", "openai"],
    ["no", "false", "openai"],
    ["unexpected", "false", "openai"],
  ];
  for (const [value, expectedBoolean, expectedProtocol] of cases) {
    const fixture = makeFixture();
    try {
      const values = inputValues({
        llm_url: "https://llm.example.invalid/v1",
        llm_model: "contract-model",
        llm_use_anthropic: value,
        llm_auth_token: "legacy-boolean-token-sentinel",
      });
      const result = runStep(configure, values, fixture);
      assert.strictEqual(
        result.status,
        0,
        `legacy llm_use_anthropic=${JSON.stringify(value)} must remain accepted; ${resultDescription(result)}`
      );
      const configured = configValues(configOperations(fixture));
      assert.strictEqual(configured["llm.use_anthropic"], expectedBoolean);
      assert.strictEqual(configured["llm.protocol"], expectedProtocol);
    } finally {
      removeFixture(fixture);
    }
  }
}

function testConfigureClearsStaleExtraHeadersBeforeTokenCommand() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: "extra-header-token-sentinel",
      llm_extra_headers: "X-Request-ID=contract-value",
    });
    const result = runStep(configure, values, fixture);
    assert.strictEqual(result.status, 0, `Configure OCR shell block failed; ${resultDescription(result)}`);
    const operations = configOperations(fixture);
    const unsetProviderIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "unset" && args[2] === "provider"
    );
    const clearExtraHeadersIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.extra_headers" && args[3] === ""
    );
    const setTokenCmdIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.auth_token_cmd"
    );
    assert.ok(clearExtraHeadersIndex >= 0, "Configure OCR must clear stale persisted llm.extra_headers");
    assert.ok(unsetProviderIndex < clearExtraHeadersIndex, "provider must be unset before legacy extra headers are cleared");
    assert.ok(clearExtraHeadersIndex < setTokenCmdIndex, "stale extra headers must be cleared before auth_token_cmd is set");
    assert.strictEqual(configValues(operations)["llm.extra_headers"], "");
  } finally {
    removeFixture(fixture);
  }
}

function testConfigureClearsStaleRetryCodesBeforeEndpointConfig() {
  const configure = stepNamed("Configure OCR");
  assert.ok(configure, "action.yml must retain the Configure OCR step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_auth_token: "retry-code-token-sentinel",
    });
    const result = runStep(configure, values, fixture);
    assert.strictEqual(result.status, 0, `Configure OCR shell block failed; ${resultDescription(result)}`);
    const operations = configOperations(fixture);
    const unsetProviderIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "unset" && args[2] === "provider"
    );
    const clearRetryCodesIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.retry_codes" && args[3] === ""
    );
    const setUrlIndex = operations.findIndex(
      (args) => args[0] === "config" && args[1] === "set" && args[2] === "llm.url"
    );
    assert.ok(clearRetryCodesIndex >= 0, "Configure OCR must clear stale persisted llm.retry_codes");
    assert.ok(unsetProviderIndex < clearRetryCodesIndex, "provider must be unset before retry codes are cleared");
    assert.ok(clearRetryCodesIndex < setUrlIndex, "stale retry codes must be cleared before endpoint config is built");
    assert.strictEqual(configValues(operations)["llm.retry_codes"], "");
  } finally {
    removeFixture(fixture);
  }
}

function testRunRetainsExtraHeadersEnvironmentOverride() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      review_task_timeout: "10",
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
      llm_extra_headers: "X-Request-ID=contract-value",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: values.review_task_timeout },
      { initializeReviewOutputs: true }
    );
    assert.strictEqual(result.status, 0, `Run OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const reviewCall = readJsonLines(fixture.callsPath).find((call) => call.args[0] === "review");
    assert.ok(reviewCall, "Run OpenCodeReview must invoke `ocr review`");
    assert.strictEqual(reviewCall.env.OCR_LLM_EXTRA_HEADERS, values.llm_extra_headers);
  } finally {
    removeFixture(fixture);
  }
}

function testRunFailsClosedWhenValidatedTaskTimeoutIsMissing() {
  const run = stepNamed("Run OpenCodeReview");
  assert.ok(run, "action.yml must retain the Run OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({
      llm_url: "https://llm.example.invalid/v1",
      llm_auth_token: "unused-token",
      llm_model: "contract-model",
      llm_use_anthropic: "false",
    });
    const result = runStep(
      run,
      values,
      fixture,
      { MERGE_BASE: "base-sha", HEAD_SHA: "head-sha", REVIEW_TASK_TIMEOUT: "" },
      { initializeReviewOutputs: true }
    );
    assert.notStrictEqual(result.status, 0, "Run OpenCodeReview must fail when validated timeout state is missing");
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /validated review_task_timeout is missing/i,
      "missing timeout failure must identify the validation boundary"
    );
    assert.ok(
      !readJsonLines(fixture.callsPath).some((call) => call.args[0] === "review"),
      "Run OpenCodeReview must fail before invoking OCR"
    );
  } finally {
    removeFixture(fixture);
  }
}

function testOfficialNpmPackageInstallIsPreserved() {
  const install = installStep();
  assert.ok(install, "action.yml must retain the Install OpenCodeReview step");
  const fixture = makeFixture();
  try {
    const values = inputValues({ ocr_version: "1.9.10" });
    const result = runStep(install, values, fixture);
    assert.strictEqual(result.status, 0, `Install OpenCodeReview shell block failed; ${resultDescription(result)}`);
    const npmCall = readJsonLines(fixture.npmCallsPath).find((args) => args[0] === "install");
    assert.ok(npmCall, "Install OpenCodeReview must invoke npm install");
    assert.deepStrictEqual(npmCall.slice(0, 2), ["install", "-g"]);
    assert.strictEqual(npmCall[2], "@alibaba-group/open-code-review@1.9.10");
  } finally {
    removeFixture(fixture);
  }
}

function testInstallRejectsStreamProgressBelowV198() {
  const install = installStep();
  assert.ok(install, "action.yml must retain the Install OpenCodeReview step");
  const cases = [
    { output: "open-code-review 1.9.7 linux/amd64", streamProgress: "true", valid: false },
    { output: "open-code-review 1.9.8 linux/amd64", streamProgress: "true", valid: true },
    { output: "open-code-review v1.10.0 linux/amd64", streamProgress: "true", valid: true },
    { output: "open-code-review 1.9.7 linux/amd64", streamProgress: "false", valid: true },
  ];
  for (const testCase of cases) {
    const fixture = makeFixture();
    try {
      const result = runStep(install, inputValues({ ocr_version: "contract-test" }), fixture, {
        OCR_FAKE_VERSION_OUTPUT: testCase.output,
        STREAM_PROGRESS: testCase.streamProgress,
      });
      const message = `version ${JSON.stringify(testCase.output)} with stream_progress=${JSON.stringify(testCase.streamProgress)}; ${resultDescription(result)}`;
      if (testCase.valid) {
        assert.strictEqual(result.status, 0, `should pass: ${message}`);
      } else {
        assert.notStrictEqual(result.status, 0, `should fail: ${message}`);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /::error::The stream_progress input requires OpenCodeReview v1\.9\.8 or newer/,
          `the failure must name the stream_progress input and the version floor; ${message}`
        );
      }
    } finally {
      removeFixture(fixture);
    }
  }
}

function testInstallRejectsEffortBelowV1100() {
  const install = installStep();
  assert.ok(install, "action.yml must retain the Install OpenCodeReview step");
  const cases = [
    { output: "open-code-review 1.9.10 linux/amd64", effort: "low", valid: false },
    { output: "open-code-review 1.10.0 linux/amd64", effort: "low", valid: true },
    { output: "open-code-review v2.0.0 linux/amd64", effort: "high", valid: true },
    { output: "open-code-review 1.9.10 linux/amd64", effort: "", valid: true },
  ];
  for (const testCase of cases) {
    const fixture = makeFixture();
    try {
      const result = runStep(install, inputValues({ ocr_version: "contract-test" }), fixture, {
        OCR_FAKE_VERSION_OUTPUT: testCase.output,
        EFFORT: testCase.effort,
      });
      const message = `version ${JSON.stringify(testCase.output)} with effort=${JSON.stringify(testCase.effort)}; ${resultDescription(result)}`;
      if (testCase.valid) {
        assert.strictEqual(result.status, 0, `should pass: ${message}`);
      } else {
        assert.notStrictEqual(result.status, 0, `should fail: ${message}`);
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /::error::The effort input requires OpenCodeReview v1\.10\.0 or newer/,
          `the failure must name the effort input and the version floor; ${message}`
        );
      }
    } finally {
      removeFixture(fixture);
    }
  }
}

function testInstallEnforcesAuthTokenCommandVersionFloor() {
  const install = installStep();
  assert.ok(install, "action.yml must retain the Install OpenCodeReview step");
  const inputBlock = ACTION_TEXT.match(
    /^  ocr_version:\s*$([\s\S]*?)(?=^  [A-Za-z0-9_]+:\s*$|^outputs:|^runs:)/m
  );
  assert.ok(inputBlock, "action.yml must expose ocr_version metadata");
  assert.match(inputBlock[1], /1\.9\.6/, "ocr_version must document the minimum compatible OCR release");

  const cases = [
    { output: "open-code-review 1.9.5 linux/amd64", valid: false },
    { output: "open-code-review 1.9.6 linux/amd64", valid: true },
    { output: "open-code-review v1.9.10 linux/amd64", valid: true },
    { output: "open-code-review 1.10.0 linux/amd64", valid: true },
    { output: "open-code-review 1.9.6+brokerkit.1 linux/amd64", valid: true },
    { output: "open-code-review 1.9.6-rc.1 linux/amd64", valid: false },
    { output: "open-code-review 01.09.006 linux/amd64", valid: false },
    { output: "open-code-review 1.9.6+! linux/amd64", valid: false },
    { output: "version unavailable", valid: false },
    { output: "", valid: false },
    { output: "version command unavailable", status: 7, valid: false, commandFailure: true },
  ];

  for (const testCase of cases) {
    const fixture = makeFixture();
    try {
      const result = runStep(
        install,
        inputValues({ ocr_version: "contract-test" }),
        fixture,
        {
          OCR_FAKE_VERSION_OUTPUT: testCase.output,
          OCR_FAKE_VERSION_STATUS: String(testCase.status || 0),
        }
      );
      const message = `version output ${JSON.stringify(testCase.output)}; ${resultDescription(result)}`;
      if (testCase.valid) assert.strictEqual(result.status, 0, `supported ${message}`);
      else assert.notStrictEqual(result.status, 0, `unsupported ${message}`);
      if (testCase.commandFailure) {
        assert.match(
          result.stdout,
          /Unable to read the installed OpenCodeReview version/,
          `failed version command must produce an actionable error; ${message}`
        );
      }
    } finally {
      removeFixture(fixture);
    }
  }
}

function testContractHarnessFailsClosedOnUnsupportedYamlShapes() {
  assert.throws(
    () => parseSteps(ACTION_TEXT.replace("    - name: Configure OCR", "   - name: Configure OCR")),
    /unsupported|step/i,
    "changed step indentation must fail instead of silently dropping a step"
  );
  assert.throws(
    () =>
      parseSteps(
        ACTION_TEXT.replace(
          "    - name: Configure OCR",
          "    - uses: example/action@v1\n\n    - name: Configure OCR"
        )
      ),
    /unsupported|step/i,
    "nameless composite steps must fail instead of being appended to the previous named step"
  );
  assert.throws(
    () =>
      parseSteps(
        ACTION_TEXT.replace(
          "    - name: Configure OCR",
          "    -\n      uses: example/action@v1\n\n    - name: Configure OCR"
        )
      ),
    /unsupported|step/i,
    "block-style nameless composite steps must fail instead of being appended to the previous step"
  );
  assert.throws(
    () =>
      parseSteps(
        ACTION_TEXT.replace(
          "      run: |\n        if command -v git",
          "      run: >-\n        if command -v git"
        )
      ),
    /unsupported|run/i,
    "unsupported run scalar styles must fail instead of producing an undefined shell block"
  );
  assert.throws(
    () =>
      parseSteps(
        ACTION_TEXT.replace(
          "        OCR_EXTRA_BODY: ${{ inputs.llm_extra_body }}",
          "        OCR_EXTRA_BODY: >-\n          ${{ inputs.llm_extra_body }}"
        )
      ),
    /unsupported|env/i,
    "multiline env values must fail instead of truncating the environment map"
  );
  assert.throws(
    () => parseSteps(ACTION_TEXT.replace("    - name: Configure OCR", "    - name: Run OpenCodeReview")),
    /duplicate|step/i,
    "duplicate step names must fail instead of making step selection ambiguous"
  );
  assert.throws(
    () => resolveInputExpressions("${{ github.ref }}", {}),
    /unsupported|unresolved|expression/i,
    "non-input action expressions must not remain unresolved in executed test fixtures"
  );
}

function testRequiredStepTopologyAndEnvironmentContracts() {
  const required = {
    "Validate inputs": [
      "REVIEW_TASK_TIMEOUT",
      "EFFORT_INPUT",
      "MAX_TOKENS_BUDGET_INPUT",
      "LLM_REASONING_EFFORT_INPUT",
      "STREAM_PROGRESS_INPUT",
    ],
    "Install OpenCodeReview": ["OCR_VERSION"],
    "Configure OCR": [
      "OCR_LLM_URL",
      "OCR_LLM_MODEL",
      "OCR_USE_ANTHROPIC",
      "OCR_LLM_AUTH_HEADER",
      "OCR_EXTRA_BODY",
      "OCR_LANGUAGE",
    ],
    "Run OpenCodeReview": [
      "OCR_LLM_URL",
      "OCR_LLM_TOKEN",
      "OCR_LLM_MODEL",
      "OCR_USE_ANTHROPIC",
      "OCR_LLM_AUTH_HEADER",
      "OCR_LLM_EXTRA_HEADERS",
      "OCR_LLM_TIMEOUT",
      "OCR_REVIEW_CONCURRENCY",
      "OCR_BACKGROUND",
      "OCR_RULE",
    ],
  };
  for (const [name, envNames] of Object.entries(required)) {
    const step = stepNamed(name);
    assert.ok(step, `action.yml must retain the ${name} step`);
    assert.strictEqual(typeof step.run, "string", `${name} must retain a supported shell block`);
    for (const envName of envNames) {
      assert.ok(Object.prototype.hasOwnProperty.call(step.env, envName), `${name} must define ${envName}`);
    }
  }
}

function testContractsRunInDedicatedWorkflow() {
  assert.match(
    CONTRACT_WORKFLOW_TEXT,
    /^\s+- name:\s*Test GitHub Actions contracts\s*$[\s\S]*?^\s+run:\s*npm run test:github-actions\s*$/m,
    "action-contract.yml must execute the complete GitHub Actions contract suite"
  );
  assert.match(
    CONTRACT_WORKFLOW_TEXT,
    /paths:\s*[\s\S]*?examples\/github_actions\/README\.md/,
    "action-contract.yml must run the contract suite when the GitHub Actions README changes"
  );
  assert.match(
    CONTRACT_WORKFLOW_TEXT,
    /uses:\s*actions\/checkout@[0-9a-f]{40}\s*#\s*v7/,
    "the dedicated contract workflow must pin checkout to an immutable commit"
  );
  assert.match(
    CONTRACT_WORKFLOW_TEXT,
    /container:\s*[\s\S]*?image:\s*node:[0-9]/,
    "the contract job must declare its Node runtime via a pinned container image"
  );
}

function testExampleReadmeDocumentsTimeoutAndVersionContracts() {
  assert.match(
    EXAMPLE_README_TEXT,
    /\| `review_task_timeout` \| `'15'` \|[^\n]*(?:per-file|per-task|concurrent task)[^\n]*\|/i,
    "GitHub Actions README must document the per-task timeout and its default"
  );
  assert.match(
    EXAMPLE_README_TEXT,
    /\| `llm_timeout` \| `'300'` \|[^\n]*(?:LLM|HTTP)[^\n]*seconds[^\n]*\|/i,
    "GitHub Actions README must document the LLM request timeout and its default"
  );
  assert.match(
    EXAMPLE_README_TEXT,
    /ocr_version[^\n]*1\.9\.6/i,
    "GitHub Actions README must document the minimum compatible OCR version"
  );
  const sample = EXAMPLE_README_TEXT.match(
    /### Use a specific OCR version[\s\S]*?ocr_version:\s*['\"]?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)['\"]?/
  );
  assert.ok(sample, "GitHub Actions README must include a valid stable OCR version sample");
  const [major, minor, patch] = sample.slice(1, 4).map(Number);
  assert.ok(
    major > 1 || (major === 1 && (minor > 9 || (minor === 9 && patch >= 6))),
    "GitHub Actions README must not recommend an OCR version below the supported floor"
  );
}

function testTransportInputsAndValidation() {
  for (const name of ["provider", "ocr_binary", "claude_auth_token", "skip_checkout", "require_complete"]) {
    assert.ok(INPUTS[name], `action must define ${name}`);
  }
  assert.strictEqual(INPUTS.provider.default, "");
  assert.strictEqual(INPUTS.skip_checkout.default, "false");
  assert.strictEqual(INPUTS.require_complete.default, "false");
  for (const name of ["llm_url", "llm_auth_token", "llm_use_anthropic"]) {
    const block = ACTION_TEXT.match(new RegExp(`^  ${name}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z0-9_]+:|^outputs:)`, "m"));
    assert.match(block[1], /required: false/);
  }
  assert.match(ACTION_TEXT, /  llm_model:\s*\n[^\n]*\n    required: true/);
  const step = stepNamed("Validate transport and checkout");
  assert.ok(step.index < stepNamed("Checkout base").index, "validate transport before checkout or installing tools");
  const cases = [
    [{}, true],
    [{ provider: "claude-code" }, true],
    [{ provider: "openai" }, false],
    [{ provider: "CLAUDE-CODE" }, false],
    [{ provider: "claude-code\nOCR_EXECUTABLE=/evil" }, false],
    [{ skip_checkout: "true", require_complete: "true" }, true],
    [{ skip_checkout: "TRUE" }, false],
    [{ skip_checkout: "" }, false],
    [{ require_complete: "yes" }, false],
  ];
  for (const [overrides, valid] of cases) {
    const fixture = makeFixture();
    try {
      const result = runStep(step, inputValues(overrides), fixture);
      assert.strictEqual(result.status === 0, valid, resultDescription(result));
      if (!valid) assert.match(result.stdout, /::error::(?:provider|skip_checkout|require_complete) must be/);
      assert.deepStrictEqual(readJsonLines(fixture.npmCallsPath), []);
      assert.deepStrictEqual(readJsonLines(fixture.callsPath), []);
    } finally {
      removeFixture(fixture);
    }
  }
}

function testPreinstalledBinaryValidationAndVersionGates() {
  const cases = [
    { kind: "space", version: "open-code-review 1.10.0+fork.abc123 linux/amd64", valid: true },
    { kind: "symlink", valid: true },
    { kind: "relative", valid: false },
    { kind: "missing", valid: false },
    { kind: "directory", valid: false },
    { kind: "not-executable", valid: false },
    { kind: "newline", valid: false },
    { kind: "carriage-return", valid: false },
    { kind: "command", valid: false },
    { kind: "space", version: "open-code-review 1.9.5 linux/amd64", valid: false },
    { kind: "space", version: "open-code-review 1.10.0-rc.1 linux/amd64", valid: false },
    { kind: "space", version: "open-code-review 1.9.9 linux/amd64", effort: "low", valid: false },
    { kind: "space", version: "open-code-review 1.9.7 linux/amd64", stream: "true", valid: false },
  ];
  for (const testCase of cases) {
    const fixture = makeFixture();
    try {
      const trustedDir = path.join(fixture.dir, "trusted tooling");
      fs.mkdirSync(trustedDir);
      const executable = path.join(trustedDir, "ocr fork");
      fs.copyFileSync(path.join(fixture.bin, "ocr"), executable);
      fs.chmodSync(executable, 0o755);
      let selected = executable;
      if (testCase.kind === "relative") selected = "./ocr";
      if (testCase.kind === "missing") selected += " missing";
      if (testCase.kind === "directory") selected = trustedDir;
      if (testCase.kind === "not-executable") fs.chmodSync(executable, 0o644);
      if (testCase.kind === "command") selected += " --version";
      if (["newline", "carriage-return"].includes(testCase.kind)) {
        selected += testCase.kind === "newline" ? "\nINJECTED=yes" : "\rINJECTED=yes";
        fs.copyFileSync(executable, selected);
        fs.chmodSync(selected, 0o755);
      }
      if (testCase.kind === "symlink") {
        selected = path.join(trustedDir, "ocr link");
        fs.symlinkSync(executable, selected);
      }
      const result = runStep(installStep(), inputValues({ ocr_binary: selected }), fixture, {
        OCR_FAKE_VERSION_OUTPUT: testCase.version || "open-code-review 1.10.0 (abc1234) linux/amd64",
        EFFORT: testCase.effort || "",
        STREAM_PROGRESS: testCase.stream || "false",
      });
      assert.strictEqual(result.status === 0, testCase.valid, `${testCase.kind}: ${resultDescription(result)}`);
      assert.deepStrictEqual(readJsonLines(fixture.npmCallsPath), [], "preinstalled binary must never fall back to npm");
      const exported = readEnvAssignments(path.join(fixture.dir, "github-env"));
      assert.strictEqual(exported.INJECTED, undefined, "path must not inject job environment values");
      if (testCase.valid) {
        assert.strictEqual(exported.OCR_EXECUTABLE, selected);
        const call = readJsonLines(fixture.callsPath)[0];
        assert.deepStrictEqual(call.args, ["version"]);
        assert.strictEqual(call.env.OCR_NO_UPDATE, "1");
        assert.ok(exported.OCR_VERSION_ACTUAL.includes("abc123"), "fork commit identity must survive in fingerprint version");
      }
    } finally {
      removeFixture(fixture);
    }
  }
}

function testCLIIsolationModelForwardingAndCredentialScope() {
  for (const auth of ["gateway", "inherited", "api-key", "saved"]) {
    const fixture = makeFixture();
    try {
      const executable = path.join(fixture.dir, "trusted ocr binary");
      fs.copyFileSync(path.join(fixture.bin, "ocr"), executable);
      fs.chmodSync(executable, 0o755);
      const configDir = path.join(fixture.home, ".opencodereview");
      fs.mkdirSync(configDir);
      const staleConfig = JSON.stringify({
        provider: "unrelated",
        providers: { "claude-code": { api_key_cmd: "touch must-not-run", extra_body: { thinking: { type: "disabled" } } } },
        llm: { auth_token_cmd: "touch must-not-run" },
        mcp_servers: { dangerous: { command: "touch", args: ["must-not-run"] } },
      });
      const globalConfigPath = path.join(configDir, "config.json");
      fs.writeFileSync(globalConfigPath, staleConfig);
      const claudeDir = path.join(fixture.home, ".claude");
      fs.mkdirSync(claudeDir);
      fs.writeFileSync(path.join(claudeDir, ".credentials.json"), '{"fake":"saved-auth"}');
      const values = inputValues({
        provider: "claude-code",
        ocr_binary: executable,
        llm_model: 'gateway alias[1m]; $(touch must-not-run)',
        claude_auth_token: auth === "gateway" ? "gateway-secret-sentinel" : "",
        // Deliberately unusable HTTP settings must be ignored, not interpreted.
        llm_url: "https://ignored.invalid",
        llm_auth_token: "ignored-http-token",
        llm_auth_header: "ignored-header",
        llm_extra_headers: "not even a header",
        llm_extra_body: "not even JSON",
        llm_reasoning_effort: "not an HTTP effort",
      });
      if (auth === "saved") {
        Object.assign(values, {
          llm_url: "", llm_auth_token: "", llm_auth_header: "", llm_extra_headers: "",
          llm_extra_body: INPUTS.llm_extra_body.default, llm_reasoning_effort: "",
        });
      }
      const installed = runStep(installStep(), values, fixture);
      assert.strictEqual(installed.status, 0, resultDescription(installed));
      const selected = readEnvAssignments(path.join(fixture.dir, "github-env"));
      const validated = runStep(validationStep(), values, fixture);
      assert.strictEqual(validated.status, 0, resultDescription(validated));
      const validatedEnv = readEnvAssignments(path.join(fixture.dir, "github-env"));
      assert.strictEqual(validatedEnv.LLM_REASONING_EFFORT, "");
      const configured = runStep(stepNamed("Configure OCR"), values, fixture, selected);
      assert.strictEqual(configured.status, 0, resultDescription(configured));
      assert.deepStrictEqual(configOperations(fixture), [["config", "set", "language", "English"]]);
      assert.doesNotMatch(configured.stdout + configured.stderr, /gateway-secret-sentinel|ignored-http-token/);
      const home = readEnvAssignments(path.join(fixture.dir, "github-output")).home;
      assert.ok(home && home !== fixture.home, "CLI OCR config must use a fresh isolated home");
      const extraEnv = {
        ...validatedEnv,
        OCR_ACTION_HOME: home,
        MERGE_BASE: "base-sha",
        HEAD_SHA: "head-sha",
      };
      if (auth === "gateway") extraEnv.ANTHROPIC_AUTH_TOKEN = "overridden-inherited-token";
      if (auth === "inherited") {
        extraEnv.ANTHROPIC_AUTH_TOKEN = "inherited-secret-sentinel";
        extraEnv.CLAUDE_CONFIG_DIR = claudeDir;
      }
      if (auth === "api-key") extraEnv.ANTHROPIC_API_KEY = "inherited-api-key-sentinel";
      const reviewed = runStep(stepNamed("Run OpenCodeReview"), values, fixture, extraEnv, { initializeReviewOutputs: true });
      assert.strictEqual(reviewed.status, 0, resultDescription(reviewed));
      const calls = readJsonLines(fixture.callsPath);
      assert.ok(calls.every((call) => call.executable === executable), "version/config/review must use exactly the selected executable");
      assert.ok(calls.every((call) => call.env.OCR_NO_UPDATE === "1"));
      for (const call of calls.filter((call) => call.args[0] !== "review")) {
        assert.strictEqual(call.env.ANTHROPIC_AUTH_TOKEN, undefined, "gateway token must not reach install/configure");
      }
      const review = calls.find((call) => call.args[0] === "review");
      assert.ok(review);
      assert.strictEqual(review.args[review.args.indexOf("--provider") + 1], "claude-code");
      assert.strictEqual(review.args[review.args.indexOf("--model") + 1], values.llm_model);
      assert.strictEqual(review.env.HOME, home);
      assert.strictEqual(review.env.CLAUDE_CONFIG_DIR, claudeDir);
      assert.strictEqual(review.env.GIT_CONFIG_GLOBAL, path.join(fixture.home, ".gitconfig"));
      assert.deepStrictEqual(review.savedConfig, { language: "English" }, "no saved OCR HTTP fields, command credentials or MCP can be loaded");
      for (const name of ["OCR_LLM_URL", "OCR_LLM_EXTRA_HEADERS", "OCR_LLM_AUTH_HEADER", "OCR_USE_ANTHROPIC"]) {
        assert.strictEqual(review.env[name], undefined, `${name} must not reach CLI review`);
      }
      assert.strictEqual(review.hasOCRToken, false);
      assert.strictEqual(review.hasGatewayInput, false);
      assert.strictEqual(review.env.ANTHROPIC_AUTH_TOKEN,
        auth === "gateway" ? values.claude_auth_token : auth === "inherited" ? extraEnv.ANTHROPIC_AUTH_TOKEN : undefined);
      if (auth === "api-key") assert.strictEqual(review.env.ANTHROPIC_API_KEY, extraEnv.ANTHROPIC_API_KEY);
      assert.strictEqual(fs.readFileSync(globalConfigPath, "utf8"), staleConfig, "global OCR settings must not be overwritten");
      assert.strictEqual(fs.readFileSync(path.join(claudeDir, ".credentials.json"), "utf8"), '{"fake":"saved-auth"}');
      assert.deepStrictEqual(readJsonLines(fixture.npmCallsPath), []);
      assert.ok(!fs.existsSync(path.join(fixture.workspace, "must-not-run")), "model must remain a quoted argument");
      assert.doesNotMatch(fs.readFileSync(path.join(fixture.dir, "github-env"), "utf8"), /secret-sentinel|ignored-http-token/);
    } finally {
      removeFixture(fixture);
    }
  }
  for (const step of STEPS) {
    if (step.name === "Run OpenCodeReview") continue;
    assert.doesNotMatch(JSON.stringify(step.env), /inputs\.claude_auth_token/, "only review may bind the gateway input");
    assert.doesNotMatch(step.run || "", /ANTHROPIC_AUTH_TOKEN/, "only review may map the gateway credential");
  }
}

function testHTTPAndCLIConditionalSettings() {
  const fixture = makeFixture();
  try {
    const values = inputValues({ llm_url: "https://http.invalid", llm_model: "http-model", llm_auth_token: "http-token", claude_auth_token: "unused-gateway-token" });
    for (const step of [installStep(), stepNamed("Configure OCR"), stepNamed("Run OpenCodeReview")]) {
      const result = runStep(step, values, fixture, { REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head" }, { initializeReviewOutputs: true });
      assert.strictEqual(result.status, 0, resultDescription(result));
    }
    const calls = readJsonLines(fixture.callsPath);
    assert.ok(calls.every((call) => call.env.OCR_NO_UPDATE === "1"), "all npm-launcher invocations must disable updates");
    const review = calls.find((call) => call.args[0] === "review");
    assert.ok(!review.args.includes("--provider"));
    assert.strictEqual(review.env.ANTHROPIC_AUTH_TOKEN, undefined, "HTTP must not map the CLI gateway token");
    assert.strictEqual(review.env.OCR_LLM_MODEL, "http-model");
    assert.strictEqual(review.env.HOME, fixture.home, "legacy HTTP home remains unchanged");
    assert.strictEqual(readJsonLines(fixture.npmCallsPath).length, 1);
    const missingURL = runStep(stepNamed("Configure OCR"), { ...values, llm_url: "" }, fixture);
    assert.notStrictEqual(missingURL.status, 0);
    assert.match(missingURL.stdout, /llm_url is required/);
    const missingToken = runStep(stepNamed("Run OpenCodeReview"), { ...values, llm_auth_token: "" }, fixture,
      { REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head" }, { initializeReviewOutputs: true });
    assert.notStrictEqual(missingToken.status, 0);
    assert.match(missingToken.stdout, /llm_auth_token is required/);
    const missingModel = runStep(stepNamed("Configure OCR"), { ...values, provider: "claude-code", llm_model: "" }, fixture);
    assert.notStrictEqual(missingModel.status, 0);
    assert.match(missingModel.stdout, /llm_model is required/);
    const missingHome = runStep(stepNamed("Run OpenCodeReview"), { ...values, provider: "claude-code" }, fixture,
      { REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head" }, { initializeReviewOutputs: true });
    assert.notStrictEqual(missingHome.status, 0);
    assert.match(missingHome.stdout, /Isolated claude-code configuration is missing/);
  } finally {
    removeFixture(fixture);
  }
}

function testTrustedCheckoutAndRefs() {
  const checkout = stepNamed("Checkout base");
  assert.match(checkout.raw, /if: inputs\.skip_checkout != 'true'/);
  assert.match(checkout.raw, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(checkout.raw, /clean: false|head\.sha|pull_request\.head/);
  assert.ok(stepNamed("Verify trusted checkout").index < stepNamed("Fetch PR head (fork-safe)").index);
  const fixture = makeFixture();
  try {
    function git(...args) {
      const result = spawnSync("git", args, {
        cwd: fixture.workspace,
        env: { PATH: process.env.PATH, HOME: fixture.home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
        encoding: "utf8",
      });
      assert.strictEqual(result.status, 0, resultDescription(result));
      return result.stdout.trim();
    }
    git("init", "--initial-branch=main");
    git("config", "user.name", "Contract Test");
    git("config", "user.email", "contract@example.invalid");
    git("commit", "--allow-empty", "-m", "trusted base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "pull-head");
    fs.writeFileSync(path.join(fixture.workspace, "untrusted-head-file"), "must not materialize");
    git("add", "untrusted-head-file");
    git("commit", "-m", "untrusted PR head");
    const head = git("rev-parse", "HEAD");
    const mismatch = runShell(stepNamed("Verify trusted checkout").run, { EVENT_BASE_SHA: base }, fixture);
    assert.notStrictEqual(mismatch.status, 0, "skip_checkout must reject a PR-head checkout");
    assert.match(mismatch.stdout, /trusted pull request base.sha/);
    const origin = path.join(fixture.dir, "origin.git");
    git("clone", "--bare", fixture.workspace, origin);
    git("--git-dir", origin, "update-ref", "refs/pull/123/head", head);
    git("checkout", "--detach", base);
    git("remote", "add", "origin", origin);
    const trusted = runShell(stepNamed("Verify trusted checkout").run, { EVENT_BASE_SHA: base }, fixture);
    assert.strictEqual(trusted.status, 0, resultDescription(trusted));
    const comment = runShell(stepNamed("Verify trusted checkout").run, { EVENT_BASE_SHA: "" }, fixture);
    assert.strictEqual(comment.status, 0, "issue_comment keeps trusted default-base behavior");
    const refs = runShell(stepNamed("Resolve PR refs").run, {
      INPUT_BASE_REF: "", INPUT_HEAD_SHA: "", EVENT_BASE_REF: "main", EVENT_HEAD_SHA: head,
    }, fixture);
    assert.strictEqual(refs.status, 0, resultDescription(refs));
    const fetched = runShell(stepNamed("Fetch PR head (fork-safe)").run, { PR_NUM: "123" }, fixture);
    assert.strictEqual(fetched.status, 0, resultDescription(fetched));
    const merged = runShell(stepNamed("Compute merge-base").run, { BASE_REF: "main", HEAD_SHA: head }, fixture);
    assert.strictEqual(merged.status, 0, resultDescription(merged));
    assert.strictEqual(readEnvAssignments(path.join(fixture.dir, "github-env")).MERGE_BASE, base);
    assert.strictEqual(git("rev-parse", "HEAD"), base, "fetch/merge-base must leave HEAD at trusted base");
    assert.ok(!fs.existsSync(path.join(fixture.workspace, "untrusted-head-file")));
    for (const [baseRef, headSha] of [["main\nINJECTED=x", head], ["--upload-pack=evil", head], ["main", "$(touch injected)"], ["main", ""]]) {
      const result = runShell(stepNamed("Resolve PR refs").run, {
        INPUT_BASE_REF: baseRef, INPUT_HEAD_SHA: headSha, EVENT_BASE_REF: "", EVENT_HEAD_SHA: "",
      }, fixture);
      assert.notStrictEqual(result.status, 0, "untrusted refs must fail before entering GITHUB_ENV/git commands");
    }
  } finally {
    removeFixture(fixture);
  }
}

function testMergeBaseFailsClosed() {
  for (const failure of ["fetch", "merge-base", "empty-result"]) {
    const fixture = makeFixture();
    try {
      fs.writeFileSync(path.join(fixture.bin, "git"), `#!/bin/bash
if [[ "$1" = "fetch" ]]; then
  [[ "${failure}" != "fetch" ]]
elif [[ "${failure}" = "empty-result" ]]; then
  exit 0
else
  exit 1
fi
`, { mode: 0o755 });
      const result = runShell(stepNamed("Compute merge-base").run, { BASE_REF: "main", HEAD_SHA: "a".repeat(40) }, fixture);
      assert.notStrictEqual(result.status, 0, `must not fall back to head on ${failure}`);
      assert.strictEqual(readEnvAssignments(path.join(fixture.dir, "github-env")).MERGE_BASE, undefined);
    } finally {
      removeFixture(fixture);
    }
  }
}

async function testCheckpointFingerprintSeparatesTransports() {
  const range = stepNamed("Resolve review range");
  assert.strictEqual(range.env.OCR_FP_PROVIDER, "${{ inputs.provider }}");
  const source = range.raw.split("        script: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)("require", "process", "core", "context", "github", source);
  const fixture = makeFixture();
  try {
    async function fingerprint(provider) {
      const outputs = {};
      await execute(require, { env: {
        GITHUB_ACTION_PATH: ROOT, GITHUB_WORKSPACE: fixture.workspace,
        OCR_VERSION_ACTUAL: "open-code-review 1.10.0 (abc1234)",
        OCR_FP_PROVIDER: provider, OCR_FP_LLM_MODEL: "same-model",
        OCR_HEAD_SHA: "a".repeat(40), OCR_BASE_REF: "main", OCR_MERGE_BASE: "b".repeat(40), OCR_STICKY_SUMMARY: "true",
      } }, {
        setOutput: (name, value) => { outputs[name] = value; }, info() {},
        warning(message) { throw new Error(message); },
      }, { repo: { owner: "owner", repo: "repo" }, issue: { number: 1 } }, {
        rest: { issues: { listComments: async () => ({ data: [] }) } },
      });
      assert.match(outputs.config_fingerprint, /^[0-9a-f]{16}$/);
      return outputs.config_fingerprint;
    }
    const http = await fingerprint("");
    const cli = await fingerprint("claude-code");
    assert.notStrictEqual(cli, http, "transport changes must invalidate checkpoint reuse even for identical model/version");
    assert.strictEqual(await fingerprint("claude-code"), cli, "fingerprint must be deterministic");
  } finally {
    removeFixture(fixture);
  }
}

function testCompletenessGatePrecedesPublication() {
  const gate = stepNamed("Validate complete review");
  assert.ok(gate.index > stepNamed("Upload review artifacts").index);
  assert.ok(gate.index > stepNamed("Fail job on OCR error").index);
  assert.ok(gate.index < stepNamed("Post review comments").index);
  assert.match(gate.raw, /if: inputs\.require_complete == 'true' && env\.OCR_EXIT_CODE == '0'/);
  assert.match(gate.run, /node "\$HELPER" "\$OCR_RESULT_PATH"/);
  for (const exitCode of [0, 1]) {
    const fixture = makeFixture();
    try {
      const helperDir = path.join(fixture.dir, "trusted tooling", "scripts", "github-actions");
      fs.mkdirSync(helperDir, { recursive: true });
      fs.writeFileSync(path.join(helperDir, "validate-review-result.js"), `process.exit(${exitCode});`);
      const result = runStep(gate, inputValues(), fixture,
        { GITHUB_ACTION_PATH: path.join(fixture.dir, "trusted tooling") }, { initializeReviewOutputs: true });
      assert.strictEqual(result.status, exitCode, "validator failure must prevent posting");
    } finally {
      removeFixture(fixture);
    }
  }
}

function artifactUploadAllowed(values, reviewFiles, review) {
  const line = stepNamed("Upload review artifacts").raw.match(/^      if: \$\{\{ (.+) \}\}$/m);
  assert.ok(line, "artifact upload must keep an explicit scoped step-output gate");
  const evaluate = new Function("inputs", "steps", "always", `return ${line[1]};`);
  return evaluate(values, { review_files: reviewFiles, review }, () => true);
}

function testOutputInitializationUsesPrivateScopedDirectories() {
  const initialize = stepNamed("Initialize review outputs");
  assert.match(initialize.raw, /id: review_files/);
  assert.ok(initialize.index < stepNamed("Run OpenCodeReview").index);
  assert.doesNotMatch(initialize.run, /GITHUB_ENV/, "output paths must not outlive the composite invocation as job environment");
  assert.doesNotMatch(ACTION_TEXT, /\/tmp\/ocr-(?:result\.json|stderr\.log)/, "the action must never fall back to shared result files");
  const fixture = makeFixture();
  const directories = [];
  try {
    const runnerTemp = path.join(fixture.dir, "runner temporary files");
    const tmpdir = path.join(fixture.dir, "fallback temporary files");
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(tmpdir);
    for (const [env, root] of [
      [{ RUNNER_TEMP: runnerTemp, TMPDIR: tmpdir }, runnerTemp],
      [{ RUNNER_TEMP: "", TMPDIR: tmpdir }, tmpdir],
      [{ RUNNER_TEMP: "", TMPDIR: "" }, "/tmp"],
    ]) {
      const outputs = initializeReviewOutputs(fixture, env);
      directories.push(outputs.directory);
      assert.strictEqual(path.dirname(outputs.directory), root);
      assert.strictEqual(outputs.result_path, path.join(outputs.directory, "ocr-result.json"));
      assert.strictEqual(outputs.stderr_path, path.join(outputs.directory, "ocr-stderr.log"));
      assert.strictEqual(outputs.artifact_suffix, path.basename(outputs.directory));
      assert.strictEqual(fs.statSync(outputs.directory).mode & 0o777, 0o700);
      assert.deepStrictEqual(fs.readdirSync(outputs.directory), [], "initialization must not reuse any old result files");
    }
    assert.strictEqual(new Set(directories).size, 3);
    for (const root of ["relative/tmp", `${runnerTemp}\nINJECTED=yes`, path.join(fixture.dir, "missing")]) {
      const outputFile = path.join(fixture.dir, "failed-init-output");
      fs.writeFileSync(outputFile, "");
      const result = runShell(initialize.run, { RUNNER_TEMP: root, GITHUB_OUTPUT: outputFile }, fixture);
      assert.notStrictEqual(result.status, 0, "invalid temporary roots must fail without publishing paths");
      assert.deepStrictEqual(readEnvAssignments(outputFile), {});
    }
  } finally {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    removeFixture(fixture);
  }
}

function testRepeatedReviewsIsolateResultsLogsAndArtifacts() {
  const fixture = makeFixture();
  try {
    const values = inputValues({ llm_model: "fixture-model", llm_auth_token: "fixture-token" });
    const root = path.join(fixture.dir, "shared runner temp with spaces");
    fs.mkdirSync(root);
    const runs = [];
    for (const label of ["first", "second"]) {
      const outputs = initializeReviewOutputs(fixture, { RUNNER_TEMP: root });
      const reviewOutputFile = path.join(fixture.dir, `${label}-review.out`);
      const result = runStep(stepNamed("Run OpenCodeReview"), values, fixture, {
        GITHUB_OUTPUT: reviewOutputFile,
        REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head",
        OCR_FAKE_REVIEW_MESSAGE: `${label}-result-only`,
        OCR_FAKE_REVIEW_STDERR: `${label}-stderr-only\n`,
        STREAM_PROGRESS: label === "first" ? "false" : "true",
      }, { stepOutputs: { review_files: outputs } });
      assert.strictEqual(result.status, 0, resultDescription(result));
      assert.strictEqual(readEnvAssignments(reviewOutputFile).started, "true");
      assert.strictEqual(JSON.parse(fs.readFileSync(outputs.result_path, "utf8")).message, `${label}-result-only`);
      assert.strictEqual(fs.readFileSync(outputs.stderr_path, "utf8"), `${label}-stderr-only\n`);
      assert.strictEqual(fs.statSync(outputs.result_path).mode & 0o777, 0o600);
      assert.ok(!fs.existsSync(path.join(outputs.directory, "stderr.fifo")), "streaming must remove its private FIFO after flushing");
      const upload = stepNamed("Upload review artifacts");
      const paths = upload.raw.match(/        path: \|\n((?:          .+\n)+)/)[1];
      const rendered = resolveInputExpressions(paths, values, { review_files: outputs }).trim().split(/\n\s*/);
      assert.deepStrictEqual(rendered, [outputs.result_path, outputs.stderr_path]);
      const name = upload.raw.match(/^        name: (.+)$/m)[1]
        .replace("${{ github.run_id }}", "same-run").replace("${{ github.run_attempt }}", "same-attempt");
      runs.push({ outputs, artifactName: resolveInputExpressions(name, values, { review_files: outputs }) });
      assert.strictEqual(artifactUploadAllowed(values, { outcome: "success", outputs }, { outputs: { started: "true" } }), true);
    }
    assert.notStrictEqual(runs[0].outputs.directory, runs[1].outputs.directory);
    assert.notStrictEqual(runs[0].artifactName, runs[1].artifactName, "multiple invocations in one workflow must not collide in artifact storage");
    assert.strictEqual(JSON.parse(fs.readFileSync(runs[0].outputs.result_path, "utf8")).message, "first-result-only");
    assert.strictEqual(fs.readFileSync(runs[0].outputs.stderr_path, "utf8"), "first-stderr-only\n");
    const jobEnv = readEnvAssignments(path.join(fixture.dir, "github-env"));
    for (const name of ["OCR_OUTPUT_DIR", "OCR_RESULT_PATH", "OCR_STDERR_PATH"]) assert.strictEqual(jobEnv[name], undefined);
  } finally {
    removeFixture(fixture);
  }
}

function testEarlyFailureCannotUploadPreviousResults() {
  const fixture = makeFixture();
  try {
    const values = inputValues({ llm_model: "fixture-model", llm_auth_token: "fixture-token" });
    const previous = initializeReviewOutputs(fixture);
    fs.writeFileSync(previous.result_path, "previous sensitive result");
    fs.writeFileSync(previous.stderr_path, "previous sensitive stderr");
    const ambient = {
      OCR_OUTPUT_DIR: previous.directory, OCR_RESULT_PATH: previous.result_path, OCR_STDERR_PATH: previous.stderr_path,
      OCR_EXIT_CODE: "0", REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head",
    };
    const run = stepNamed("Run OpenCodeReview");
    const missingInitialization = runShell(run.run, { ...ambient, ...renderedEnv(run, values) }, fixture);
    assert.notStrictEqual(missingInitialization.status, 0);
    assert.match(missingInitialization.stdout, /Scoped review output paths are missing/);
    assert.deepStrictEqual(readJsonLines(fixture.callsPath), []);
    assert.strictEqual(artifactUploadAllowed(values, { outcome: "skipped", outputs: {} }, { outputs: {} }), false);
    assert.strictEqual(artifactUploadAllowed(values, { outcome: "failure", outputs: {} }, { outputs: {} }), false);

    const current = initializeReviewOutputs(fixture);
    const reviewOutput = path.join(fixture.dir, "early-review.out");
    const failedValidation = runStep(run, values, fixture, {
      REVIEW_TASK_TIMEOUT: "", GITHUB_OUTPUT: reviewOutput,
    }, { stepOutputs: { review_files: current } });
    assert.notStrictEqual(failedValidation.status, 0);
    assert.deepStrictEqual(readEnvAssignments(reviewOutput), {});
    assert.deepStrictEqual(fs.readdirSync(current.directory), []);
    assert.strictEqual(artifactUploadAllowed(values, { outcome: "success", outputs: current }, { outputs: readEnvAssignments(reviewOutput) }), false);
    assert.strictEqual(fs.readFileSync(previous.result_path, "utf8"), "previous sensitive result");
    assert.strictEqual(fs.readFileSync(previous.stderr_path, "utf8"), "previous sensitive stderr");

    const failedReview = runStep(run, values, fixture, {
      REVIEW_TASK_TIMEOUT: "15", MERGE_BASE: "base", HEAD_SHA: "head", GITHUB_OUTPUT: reviewOutput,
      OCR_FAKE_REVIEW_STATUS: "7", OCR_FAKE_REVIEW_STDERR: "current review failed",
    }, { stepOutputs: { review_files: current } });
    assert.strictEqual(failedReview.status, 0, "the existing exit-code step still handles OCR failure after artifacts are uploaded");
    assert.strictEqual(readEnvAssignments(path.join(fixture.dir, "github-env")).OCR_EXIT_CODE, "7");
    assert.strictEqual(artifactUploadAllowed(values, { outcome: "success", outputs: current }, { outputs: readEnvAssignments(reviewOutput) }), true);
    assert.strictEqual(artifactUploadAllowed({ ...values, upload_artifacts: "false" }, { outcome: "success", outputs: current }, { outputs: { started: "true" } }), false);
    assert.strictEqual(fs.readFileSync(current.stderr_path, "utf8"), "current review failed");
  } finally {
    removeFixture(fixture);
  }
}

async function testValidatorAndPublisherConsumeOnlyScopedOutputs() {
  const fixture = makeFixture();
  try {
    const root = path.join(fixture.dir, "runner temp with spaces");
    fs.mkdirSync(root);
    const outputs = initializeReviewOutputs(fixture, { RUNNER_TEMP: root });
    fs.writeFileSync(outputs.result_path, "current result only");
    fs.writeFileSync(outputs.stderr_path, "current stderr only");
    const gate = stepNamed("Validate complete review");
    const post = stepNamed("Post review comments");
    assert.strictEqual(gate.env.OCR_RESULT_PATH, "${{ steps.review_files.outputs.result_path }}");
    assert.strictEqual(post.env.OCR_RESULT_PATH, "${{ steps.review_files.outputs.result_path }}");
    assert.strictEqual(post.env.OCR_STDERR_PATH, "${{ steps.review_files.outputs.stderr_path }}");
    const helperRoot = path.join(fixture.dir, "trusted helpers with spaces");
    const helperDir = path.join(helperRoot, "scripts", "github-actions");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "validate-review-result.js"),
      'process.stdout.write(JSON.stringify({path: process.argv[2], content: require("fs").readFileSync(process.argv[2], "utf8")}));');
    const checked = runStep(gate, inputValues(), fixture, { GITHUB_ACTION_PATH: helperRoot }, { stepOutputs: { review_files: outputs } });
    assert.strictEqual(checked.status, 0, resultDescription(checked));
    assert.deepStrictEqual(JSON.parse(checked.stdout), { path: outputs.result_path, content: "current result only" });
    const missing = runStep(gate, inputValues(), fixture, { GITHUB_ACTION_PATH: helperRoot });
    assert.notStrictEqual(missing.status, 0, "validator must not fall back to any shared result when initialization was skipped");

    const source = post.raw.split("        script: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n")
      .replace(/\$\{\{ inputs\.(sticky_summary|incremental|checkpoint_range) == 'true' \}\}/g, "false");
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)("require", "process", "core", "context", "github", source);
    let published;
    const requireFixture = (name) => name.endsWith("post-review-comments.js")
      ? { runPostReviewComments: async (args) => { published = args; } }
      : require(name);
    await execute(requireFixture, { env: { GITHUB_ACTION_PATH: ROOT, OCR_RESULT_PATH: outputs.result_path, OCR_STDERR_PATH: outputs.stderr_path } }, {}, {}, {});
    assert.strictEqual(published.resultPath, outputs.result_path);
    assert.strictEqual(published.stderrPath, outputs.stderr_path);
    published = undefined;
    await assert.rejects(
      execute(requireFixture, { env: { GITHUB_ACTION_PATH: ROOT } }, {}, {}, {}),
      /Scoped review output paths are missing/
    );
    assert.strictEqual(published, undefined, "missing paths must never invoke the helper's shared-path defaults");
  } finally {
    removeFixture(fixture);
  }
}

const TESTS = [
  ["review outputs initialize in private per-invocation temporary directories", testOutputInitializationUsesPrivateScopedDirectories],
  ["repeated reviews isolate result files, stderr, FIFOs and artifact names", testRepeatedReviewsIsolateResultsLogsAndArtifacts],
  ["early failures never upload previous invocation artifacts", testEarlyFailureCannotUploadPreviousResults],
  ["validation and publication consume only scoped output paths", testValidatorAndPublisherConsumeOnlyScopedOutputs],
  ["transport inputs validate before tools or checkout", testTransportInputsAndValidation],
  ["trusted preinstalled OCR bypasses npm and preserves version gates", testPreinstalledBinaryValidationAndVersionGates],
  ["CLI isolates settings, skips HTTP, forwards models and scopes authentication", testCLIIsolationModelForwardingAndCredentialScope],
  ["HTTP remains legacy and provider-specific settings are conditional", testHTTPAndCLIConditionalSettings],
  ["checkout and PR refs preserve the trusted base boundary", testTrustedCheckoutAndRefs],
  ["merge-base and fetch failures never become empty head reviews", testMergeBaseFailsClosed],
  ["checkpoint fingerprints distinguish HTTP from CLI transport", testCheckpointFingerprintSeparatesTransports],
  ["opt-in complete-review validation gates comment publication", testCompletenessGatePrecedesPublication],
  ["review_task_timeout names and describes the CLI task deadline", testReviewTaskTimeoutInputNameAndScope],
  ["llm_timeout defaults to the CLI's 5-minute timeout", testLlmTimeoutInputDefault],
  ["review_task_timeout accepts 1/10/120", testReviewTimeoutValidationAcceptsBoundaries],
  ["review_task_timeout rejects malformed values", testReviewTimeoutValidationRejectsMalformedValues],
  ["review_task_timeout validation runs before NPM install", testValidationPrecedesNpmInstall],
  ["review_task_timeout forwards --timeout separately from llm_timeout", testReviewTimeoutForwardedSeparatelyFromLlmTimeout],
  ["default llm_timeout exports independently from review_task_timeout", testDefaultLlmTimeoutExportedSeparatelyFromReviewTimeout],
  ["empty llm_timeout normalizes before review invocation", testEmptyLlmTimeoutNormalizesBeforeReviewInvocation],
  ["review_task_timeout with a leading zero normalizes across steps", testReviewTimeoutLeadingZeroIsNormalizedAcrossSteps],
  ["effort and max_tokens_budget reject malformed values", testValidateInputsRejectsInvalidEffortAndBudget],
  ["effort and max_tokens_budget normalize and forward across steps", testEffortAndBudgetNormalizeAndForwardAcrossSteps],
  ["max_tokens_budget=0 normalizes to unlimited", testZeroMaxTokensBudgetNormalizesToUnlimited],
  ["empty effort and max_tokens_budget omit the CLI flags", testEmptyEffortAndBudgetOmitTheFlags],
  ["llm_reasoning_effort rejects values outside the OpenAI/GLM vocabulary", testValidateInputsRejectsInvalidReasoningEffort],
  ["stream_progress defaults to false and describes [ocr] progress", testStreamProgressInputDefaultsToFalse],
  ["stream_progress validation accepts true/false case-insensitively", testValidateInputsValidatesStreamProgress],
  ["Run OpenCodeReview keeps --audience agent and the log file by default", testRunKeepsAgentAudienceAndLogFileByDefault],
  ["Run OpenCodeReview streams live progress when opted in", testRunStreamsProgressWhenOptedIn],
  ["llm_extra_body defaults to disabling thinking", testLlmExtraBodyDefaultDisablesThinking],
  ["Configure OCR merges reasoning_effort into extra_body", testConfigureMergesReasoningEffortIntoExtraBody],
  ["Configure OCR rejects reasoning_effort on the anthropic protocol", testConfigureRejectsReasoningEffortOnAnthropic],
  ["Configure OCR rejects malformed extra_body with an actionable error", testConfigureRejectsMalformedExtraBodyWithActionableError],
  ["Configure OCR rejects a non-object extra_body", testConfigureRejectsNonObjectExtraBody],
  ["Configure OCR builds a complete llm config", testConfigureBuildsCompleteLlmConfig],
  ["Configure OCR never persists the token", testConfigureNeverPersistsToken],
  ["Configure OCR neutralizes stale provider and static token", testConfigureNeutralizesStaleProviderAndStaticToken],
  ["Configure OCR sets a protocol consistent with use_anthropic", testConfigureProtocolTracksUseAnthropic],
  ["Configure OCR preserves legacy use_anthropic resolution", testConfigurePreservesLegacyUseAnthropicResolution],
  ["Configure OCR clears stale persisted extra headers", testConfigureClearsStaleExtraHeadersBeforeTokenCommand],
  ["Configure OCR clears stale persisted retry codes", testConfigureClearsStaleRetryCodesBeforeEndpointConfig],
  ["Run OpenCodeReview retains the extra-headers env override", testRunRetainsExtraHeadersEnvironmentOverride],
  ["Run OpenCodeReview fails closed without validated task timeout", testRunFailsClosedWhenValidatedTaskTimeoutIsMissing],
  ["the official OpenCodeReview NPM install is preserved", testOfficialNpmPackageInstallIsPreserved],
  ["Install OpenCodeReview enforces the auth_token_cmd version floor", testInstallEnforcesAuthTokenCommandVersionFloor],
  ["Install OpenCodeReview rejects the effort input below v1.10.0", testInstallRejectsEffortBelowV1100],
  ["Install OpenCodeReview rejects stream_progress below v1.9.8", testInstallRejectsStreamProgressBelowV198],
  ["contract harness fails closed on unsupported YAML shapes", testContractHarnessFailsClosedOnUnsupportedYamlShapes],
  ["required action steps and env contracts are present", testRequiredStepTopologyAndEnvironmentContracts],
  ["GitHub Actions contracts run in a dedicated workflow", testContractsRunInDedicatedWorkflow],
  ["GitHub Actions README documents timeout and version contracts", testExampleReadmeDocumentsTimeoutAndVersionContracts],
];

async function main() {
  const failures = [];
  for (const [name, test] of TESTS) {
    try {
      await test();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`not ok - ${name}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} action contract test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${TESTS.length} action contract tests passed.`);
  }
}

main();
