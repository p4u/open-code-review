#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

// Run directly with Node >=14; no dependencies, credentials, or model calls.
// Fixtures mirror jsonOutput/jsonSummary in cmd/opencodereview/output.go and
// RunManifest in internal/session/manifest.go. See emit_run_result_test.go,
// budget_output_test.go, and internal/agent/manifest_integration_test.go for
// the empty-selection, budget-stop, reuse, and completed-with-warning cases.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");
const {
  validateReviewResult,
  validateReviewResultFile,
  MANIFEST_SCHEMA_VERSION,
  MAX_RESULT_BYTES,
} = require("./validate-review-result.js");

const script = path.join(__dirname, "validate-review-result.js");
let passed = 0;
function test(name, run) {
  try {
    run();
    passed++;
  } catch (error) {
    process.stderr.write(`FAIL: ${name}\n`);
    throw error;
  }
}

function item(file) {
  return {
    item_id: createHash("sha256").update(["review", "range", file, file].join("\0")).digest("hex"),
    path: file,
    old_path: file,
    fingerprint: createHash("sha256").update(`diff:${file}`).digest("hex"),
  };
}

function completeResult() {
  const selected = [item("a.go"), item("b.go")].sort((a, b) => a.item_id.localeCompare(b.item_id));
  return {
    status: "complete",
    llm: { provider: "claude-code", model: "sonnet" },
    message: "Review complete: 1 finding(s) across 2 selected item(s).",
    summary: {
      files_reviewed: 2, comments: 1, total_tokens: 150,
      input_tokens: 100, output_tokens: 50, cache_read_tokens: 10,
      cache_write_tokens: 5, elapsed: "1s",
    },
    tool_calls: { total: 2, by_tool: { code_comment: 1, task_done: 1 }, failure: 0, failure_by_tool: {}, failure_details: [] },
    comments: [{ path: "a.go", content: "Check the error before returning.", start_line: 2, end_line: 3, category: "bug", severity: "high" }],
    groups: [{ label: "pair", files: ["a.go", "b.go"] }],
    session_id: "e78cf2d3-20b0-44a7-845a-ef7320f67ec1",
    manifest: {
      schema_version: "ocr.run-manifest/v1",
      run_id: "e78cf2d3-20b0-44a7-845a-ef7320f67ec1",
      operation: "review",
      terminal_state: "complete",
      repository: { identity_sha256: "a".repeat(64) },
      input: { mode: "range", requested_from: "main", requested_head: "feature", resolved_base: "b".repeat(40), resolved_head: "c".repeat(40), exact_range: `${"b".repeat(40)}..${"c".repeat(40)}` },
      execution: { ocr_version: "dev", provider: "claude-code", model: "sonnet", configured_concurrency: 1 },
      coverage: { selected, completed: selected.map((entry) => ({ ...entry })), reused: [], failed: [], waived: [] },
      elapsed_ms: 1000,
    },
  };
}

function emptyResult() {
  const result = completeResult();
  result.status = result.manifest.terminal_state = "skipped";
  result.message = "Review skipped: no items were selected.";
  result.summary = { files_reviewed: 0, comments: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, elapsed: "0s" };
  result.tool_calls = { total: 0, by_tool: {}, failure: 0, failure_by_tool: {}, failure_details: [] };
  result.comments = [];
  delete result.groups;
  result.manifest.coverage.selected = [];
  result.manifest.coverage.completed = [];
  result.manifest.elapsed_ms = 0;
  return result;
}

function rejects(name, mutate, expected, fixture = completeResult) {
  test(name, () => {
    const result = fixture();
    mutate(result);
    assert.throws(() => validateReviewResult(result), expected);
  });
}

function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-validator-"));
  try {
    run(dir);
  } finally {
    // rmdirSync({recursive:true}) and rmSync have different Node 14 support.
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  }
}

function cli(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "", "validation must not print result contents");
  return result;
}

test("real-shaped successful result and pure return value", () => {
  const result = completeResult();
  const before = JSON.stringify(result);
  assert.strictEqual(MANIFEST_SCHEMA_VERSION, "ocr.run-manifest/v1");
  assert.deepStrictEqual(validateReviewResult(result), { status: "complete", selectedFiles: 2, completedFiles: 2, reusedFiles: 0, findings: 1 });
  assert.strictEqual(JSON.stringify(result), before);
});

for (const severity of ["critical", "high", "medium", "low", "future-severity"]) {
  test(`findings never gate completion: ${severity}`, () => {
    const result = completeResult();
    result.comments[0].severity = severity;
    assert.strictEqual(validateReviewResult(result).findings, 1);
  });
}

test("malformed individual findings cannot pass through summary publication", () => {
  // The publisher treats {} as a no-line finding, renders an undefined path,
  // and reports zero failed comments. Validate entries before publication.
  for (const entry of [{}, null, [], "finding", 1, true]) {
    const result = completeResult();
    result.comments = [entry];
    assert.throws(() => validateReviewResult(result), /comments\[0\]/);
  }
});

for (const key of ["path", "content"]) {
  test(`finding ${key} must be usable text`, () => {
    for (const value of [undefined, null, "", " \t\n", 1, false, [], {}]) {
      const result = completeResult();
      result.comments[0][key] = value;
      assert.throws(() => validateReviewResult(result), new RegExp(`comments\\[0\\]\\.${key} must be a non-empty string`));
    }
  });
}

for (const key of ["suggestion_code", "existing_code", "thinking", "category", "severity"]) {
  test(`optional finding ${key} must have the Go string type`, () => {
    for (const value of [null, 1, false, [], {}]) {
      const result = completeResult();
      result.comments[0][key] = value;
      assert.throws(() => validateReviewResult(result), /must be a string when present/);
    }
  });
}

for (const key of ["start_line", "end_line"]) {
  test(`finding ${key} must be a non-negative integer`, () => {
    for (const value of [undefined, null, "2", -1, 1.5, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const result = completeResult();
      result.comments[0][key] = value;
      assert.throws(() => validateReviewResult(result), /non-negative safe integer/);
    }
  });
}
rejects("reversed finding line range", (r) => { r.comments[0].start_line = 4; }, /must not exceed end_line/);

for (const [start, end] of [[0, 0], [0, 3], [2, 0], [2, 2], [2, 3]]) {
  test(`valid finding line range ${start}/${end} and advisory metadata`, () => {
    const result = completeResult();
    Object.assign(result.comments[0], {
      start_line: start, end_line: end, content: "A multiline finding.\n\nPlease check this case.",
      suggestion_code: "", existing_code: "", thinking: "", category: "future-category", severity: "future-severity",
    });
    assert.strictEqual(validateReviewResult(result).findings, 1);
  });
}

for (const fixture of [completeResult, emptyResult]) {
  for (const comments of [[], null]) {
    test(`valid no-findings ${fixture.name}, comments=${JSON.stringify(comments)}`, () => {
      const result = fixture();
      result.comments = comments;
      result.summary.comments = 0;
      assert.strictEqual(validateReviewResult(result).findings, 0);
    });
  }
}

test("warnings and recovered tool errors do not override complete manifest", () => {
  const result = completeResult();
  result.warnings = [
    { type: "review_filter_error", file: "a.go", message: "Filtering failed after timeout; original findings retained." },
    { type: "info", message: "An earlier request was cancelled, skipped, incomplete, or exhausted; retry succeeded." },
  ];
  result.tool_calls = { total: 3, by_tool: { file_read: 2, task_done: 1 }, failure: 1, failure_by_tool: { file_read: 1 }, failure_details: [{ tool_call_number: 1, tool_name: "file_read", arguments: "{}", error: "retry succeeded" }] };
  result.summary.budget_exceeded = false;
  assert.strictEqual(validateReviewResult(result).status, "complete");
});

for (const count of [1, 2]) {
  test(`completed plus reused coverage (${count} reused)`, () => {
    const result = completeResult();
    result.manifest.parent_run_id = "parent-run";
    result.manifest.coverage.reused = result.manifest.coverage.completed.splice(0, count);
    assert.strictEqual(validateReviewResult(result).reusedFiles, count);
    assert.strictEqual(result.summary.files_reviewed, 2);
  });
}

test("omitted optional coverage fields and metadata", () => {
  const result = completeResult();
  for (const key of ["selected", "completed"]) {
    for (const entry of result.manifest.coverage[key]) {
      delete entry.old_path;
      delete entry.fingerprint;
    }
  }
  delete result.session_id;
  delete result.summary.cache_read_tokens;
  delete result.summary.cache_write_tokens;
  result.manifest.repository = {};
  result.manifest.execution = {};
  assert.strictEqual(validateReviewResult(result).status, "complete");
});

for (const value of [null, [], "result", 7, true, {}]) {
  test(`reject missing result or manifest: ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateReviewResult(value), /result JSON object|Missing review manifest/);
  });
}
for (const version of [undefined, null, 1, "ocr.run-manifest/v2", ""]) {
  rejects("unknown or absent schema version", (r) => { r.manifest.schema_version = version; }, /schema_version/);
}
for (const status of ["partial", "failed", "cancelled", "exhausted", "budget_exceeded", "success", "completed_with_warnings", "complete ", null]) {
  rejects(`reject non-success status ${status}`, (r) => { r.status = r.manifest.terminal_state = status; }, /partial or failed|Unknown manifest.terminal_state/);
}
rejects("mismatched top-level status", (r) => { r.status = "success"; }, /must match/);
rejects("missing top-level status", (r) => { delete r.status; }, /must match/);
rejects("absent manifest", (r) => { delete r.manifest; }, /Missing review manifest/);
rejects("null manifest", (r) => { r.manifest = null; }, /Missing review manifest/);
rejects("wrong operation", (r) => { r.manifest.operation = "scan"; }, /operation/);
rejects("unknown input mode", (r) => { r.manifest.input.mode = "future"; }, /input.mode/);
rejects("missing run ID", (r) => { delete r.manifest.run_id; }, /run_id/);
rejects("mismatched session ID", (r) => { r.session_id = "other"; }, /session_id/);
rejects("invalid elapsed time", (r) => { r.manifest.elapsed_ms = -1; }, /elapsed_ms/);
rejects("missing provenance", (r) => { delete r.manifest.execution; }, /execution/);
rejects("invalid parent ID", (r) => { r.manifest.parent_run_id = 9; }, /parent_run_id/);
rejects("missing summary", (r) => { delete r.summary; }, /Missing review summary/);
rejects("missing comments", (r) => { delete r.comments; }, /comments must/);
rejects("invalid comments type", (r) => { r.comments = {}; }, /comments must/);
rejects("comments counter mismatch", (r) => { r.summary.comments++; }, /findings count/);
rejects("files counter mismatch", (r) => { r.summary.files_reviewed--; }, /selected coverage count/);
rejects("token counter mismatch", (r) => { r.summary.total_tokens++; }, /input_tokens plus output_tokens/);
rejects("budget diagnostic despite complete status", (r) => { r.summary.budget_exceeded = true; }, /budget was exhausted/);
for (const value of [null, "false", 0]) {
  rejects("budget flag must be boolean", (r) => { r.summary.budget_exceeded = value; }, /must be a boolean/);
}
for (const key of ["files_reviewed", "comments", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) {
  for (const value of [-1, 1.5, "0", null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(`invalid summary counter ${key} (${String(value)})`, (r) => { r.summary[key] = value; }, /non-negative safe integer/);
  }
}
for (const key of ["files_reviewed", "comments", "input_tokens", "output_tokens", "total_tokens"]) {
  rejects(`missing summary counter ${key}`, (r) => { delete r.summary[key]; }, /non-negative safe integer/);
}
for (const key of ["selected", "completed", "reused", "failed", "waived"]) {
  for (const value of [undefined, null, {}, 0]) {
    rejects(`coverage.${key} must be an array`, (r) => { r.manifest.coverage[key] = value; }, /must be an array/);
  }
}
rejects("missing coverage", (r) => { delete r.manifest.coverage; }, /Missing manifest.coverage/);
rejects("selected item skipped", (r) => { r.status = r.manifest.terminal_state = "skipped"; }, /zero-selection/);
rejects("empty selection cannot claim complete", (r) => { r.status = r.manifest.terminal_state = "complete"; }, /zero-selection/, emptyResult);
rejects("empty selection cannot contain findings", (r) => { r.comments = completeResult().comments; r.summary.comments = 1; }, /cannot contain findings/, emptyResult);
rejects("empty selection cannot report reviewed files", (r) => { r.summary.files_reviewed = 1; }, /selected coverage count/, emptyResult);
rejects("empty selection still rejects run failure", (r) => { r.manifest.run_failure = { classification: "input" }; }, /run_failure/, emptyResult);
rejects("missing terminal outcome", (r) => { r.manifest.coverage.completed.pop(); }, /incomplete/);
rejects("duplicate selected IDs", (r) => { r.manifest.coverage.selected[1] = { ...r.manifest.coverage.selected[0] }; }, /duplicate item_id/);
rejects("duplicate completed IDs hide missing coverage", (r) => { r.manifest.coverage.completed[1] = { ...r.manifest.coverage.completed[0] }; }, /without duplicates/);
rejects("overlapping completed and reused sets", (r) => { r.manifest.parent_run_id = "parent"; r.manifest.coverage.reused.push({ ...r.manifest.coverage.completed[0] }); }, /disjoint/);
rejects("reused coverage without parent", (r) => { r.manifest.coverage.reused.push(r.manifest.coverage.completed.pop()); }, /requires manifest.parent_run_id/);
rejects("unselected outcome despite equal counters", (r) => { r.manifest.coverage.completed[0].item_id = "other"; }, /unselected item/);
for (const key of ["path", "old_path", "fingerprint"]) {
  rejects(`inconsistent outcome ${key}`, (r) => { r.manifest.coverage.completed[0][key] = "other"; }, /identity differs/);
}
for (const value of [null, {}, { item_id: 2, path: "a.go" }, { item_id: "a", path: "" }]) {
  rejects("invalid coverage entry", (r) => { r.manifest.coverage.selected[0] = value; }, /entries must have/);
}
rejects("invalid optional item field", (r) => { r.manifest.coverage.selected[0].old_path = 42; }, /invalid old_path/);
rejects("hidden failure metadata in completed item", (r) => { r.manifest.coverage.completed[0].classification = "budget"; }, /failure or waiver metadata/);
rejects("waived items do not satisfy strict coverage", (r) => { r.manifest.coverage.waived.push({ ...r.manifest.coverage.completed.pop(), reason: "waived explicitly" }); }, /waived coverage/);

for (const classification of ["provider", "timeout", "cancelled", "configuration", "input", "budget", "panic", "unknown", "future-class"]) {
  rejects(`failed item cannot hide behind complete: ${classification}`, (r) => {
    r.manifest.coverage.failed.push({ ...r.manifest.coverage.completed.pop(), classification, reason: "Stopped before completion." });
  }, /failed coverage/);
}
for (const classification of ["input", "configuration", "timeout", "cancelled", "budget", "internal", "unknown", "future-class"]) {
  rejects(`run failure after full coverage: ${classification}`, (r) => { r.manifest.run_failure = { classification }; }, /run_failure/);
}
for (const value of [null, false, {}]) {
  rejects("malformed run_failure still fails closed", (r) => { r.manifest.run_failure = value; }, /run_failure/);
}
for (const classification of ["budget", "cancelled"]) {
  rejects(`real-shaped partial ${classification} result`, (r) => {
    r.status = r.manifest.terminal_state = "partial";
    r.manifest.coverage.failed.push({ ...r.manifest.coverage.completed.pop(), classification, reason: "Main task stopped before completing." });
    if (classification === "budget") r.summary.budget_exceeded = true;
  }, /partial or failed/);
}

test("CLI success for findings and legitimate empty selection", () => withTemp((dir) => {
  const file = path.join(dir, "result.json");
  for (const result of [completeResult(), emptyResult()]) {
    fs.writeFileSync(file, JSON.stringify(result));
    assert.strictEqual(validateReviewResultFile(file).status, result.status);
    const output = cli([file]);
    assert.strictEqual(output.status, 0);
    assert.strictEqual(output.stderr, "");
  }
}));

test("CLI rejects empty, malformed, truncated, concatenated, and non-UTF-8 files safely", () => withTemp((dir) => {
  const file = path.join(dir, "result.json");
  const secret = "SECRET_DO_NOT_LOG";
  for (const content of ["", `not-json ${secret}`, `{"secret":"${secret}",`, JSON.stringify(completeResult()).slice(0, -1), "{}\n{}", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
    fs.writeFileSync(file, content);
    const output = cli([file]);
    assert.strictEqual(output.status, 1);
    assert.match(output.stderr, /not valid UTF-8 JSON/);
    assert(!output.stderr.includes(secret));
  }
}));

test("CLI cannot leak paths, parser excerpts, status values, or reasons", () => withTemp((dir) => {
  const secret = "SECRET_DO_NOT_LOG";
  const file = path.join(dir, secret);
  const result = completeResult();
  result.manifest.terminal_state = `${secret}\n::error::injected`;
  fs.writeFileSync(file, JSON.stringify(result));
  const invalid = cli([file]);
  assert.strictEqual(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown manifest.terminal_state/);
  result.manifest.terminal_state = "complete";
  result.manifest.run_failure = { classification: "cancelled", reason: secret };
  fs.writeFileSync(file, JSON.stringify(result));
  const stopped = cli([file]);
  assert.strictEqual(stopped.status, 1);
  assert.match(stopped.stderr, /run_failure/);
  fs.unlinkSync(file);
  const missing = cli([file]);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /Cannot read review result/);
  for (const output of [invalid, stopped, missing]) {
    assert(!output.stderr.includes(secret));
    assert(!output.stderr.includes(dir));
    assert(!output.stderr.includes("::error::injected"));
  }
}));

test("CLI rejects malformed findings with safe indexed diagnostics", () => withTemp((dir) => {
  const secret = "SECRET_DO_NOT_LOG";
  const file = path.join(dir, secret);
  const valid = completeResult().comments[0];
  for (const entry of [
    {}, secret,
    { ...valid, path: secret, content: { private: secret } },
    { ...valid, content: secret, suggestion_code: { private: secret } },
    { ...valid, path: secret, start_line: secret },
  ]) {
    const result = completeResult();
    result.comments.push(entry);
    result.summary.comments = 2;
    fs.writeFileSync(file, JSON.stringify(result));
    const output = cli([file]);
    assert.strictEqual(output.status, 1);
    assert.match(output.stderr, /comments\[1\]/);
    assert(!output.stderr.includes(secret));
    assert(!output.stderr.includes(dir));
  }
}));

test("CLI accepts unresolved no-line findings without a severity gate", () => withTemp((dir) => {
  const file = path.join(dir, "result.json");
  const result = completeResult();
  Object.assign(result.comments[0], { start_line: 0, end_line: 0, severity: "future-severity" });
  fs.writeFileSync(file, JSON.stringify(result));
  const output = cli([file]);
  assert.strictEqual(output.status, 0);
  assert.strictEqual(output.stderr, "");
}));

test("CLI requires exactly one file and rejects directories", () => withTemp((dir) => {
  assert.strictEqual(cli([]).status, 2);
  assert.strictEqual(cli(["one", "two"]).status, 2);
  const output = cli([dir]);
  assert.strictEqual(output.status, 1);
  assert.match(output.stderr, /regular JSON file/);
}));

test("file-size boundary permits exactly 16 MiB and refuses oversized reports", () => withTemp((dir) => {
  const file = path.join(dir, "result.json");
  const json = JSON.stringify(completeResult());
  assert.strictEqual(MAX_RESULT_BYTES, 16 * 1024 * 1024);
  fs.writeFileSync(file, json + " ".repeat(MAX_RESULT_BYTES - Buffer.byteLength(json)));
  assert.strictEqual(validateReviewResultFile(file).status, "complete");
  const fd = fs.openSync(file, "r+");
  try { fs.ftruncateSync(fd, MAX_RESULT_BYTES + 1); } finally { fs.closeSync(fd); }
  const output = cli([file]);
  assert.strictEqual(output.status, 1);
  assert.match(output.stderr, /16 MiB limit/);
}));

test("file growth after fstat remains bounded and fails closed", () => withTemp((dir) => {
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify(completeResult()));
  const original = fs.fstatSync;
  fs.fstatSync = (fd) => {
    const stat = original(fd);
    fs.appendFileSync(file, "extra bytes");
    return stat;
  };
  try {
    assert.throws(() => validateReviewResultFile(file), /changed while reading/);
  } finally {
    fs.fstatSync = original;
  }
}));

process.stdout.write(`validate-review-result: ${passed} tests passed\n`);
