#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("fs");
const { TextDecoder } = require("util");

const MANIFEST_SCHEMA_VERSION = "ocr.run-manifest/v1";
// Results contain findings and coverage, not the session conversation. 16 MiB
// leaves room for large PR reports while bounding read, decode, and JSON memory.
// Oversized reports fail explicitly; never truncate them into apparent success.
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

class ReviewResultError extends Error {}

function check(condition, message) {
  if (!condition) throw new ReviewResultError(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function counter(value, field) {
  check(Number.isSafeInteger(value) && value >= 0,
    `${field} must be a non-negative safe integer.`);
}

function finding(comment, index) {
  const field = `comments[${index}]`;
  check(isObject(comment), `${field} must be a finding object.`);
  for (const key of ["path", "content"]) {
    check(nonemptyString(comment[key]), `${field}.${key} must be a non-empty string.`);
  }
  for (const key of ["suggestion_code", "existing_code", "thinking", "category", "severity"]) {
    check(!has(comment, key) || typeof comment[key] === "string",
      `${field}.${key} must be a string when present.`);
  }
  // Go always emits both line fields. Zero means unresolved, not invalid; the
  // publisher also accepts a single known endpoint. Metadata remains advisory.
  counter(comment.start_line, `${field}.start_line`);
  counter(comment.end_line, `${field}.end_line`);
  check(comment.start_line === 0 || comment.end_line === 0 || comment.start_line <= comment.end_line,
    `${field}.start_line must not exceed end_line when both are known.`);
}

function coverageItem(item, field) {
  check(isObject(item) && nonemptyString(item.item_id) && nonemptyString(item.path),
    `${field} entries must have non-empty item_id and path strings.`);
  for (const key of ["old_path", "fingerprint"]) {
    check(!has(item, key) || typeof item[key] === "string",
      `${field} entries have an invalid ${key}.`);
  }
  check(!has(item, "classification") && !has(item, "reason"),
    `${field} entries must not carry failure or waiver metadata.`);
}

/**
 * Validate the parsed OCR review JSON, returning only safe completion counts.
 * Throws ReviewResultError with a static diagnostic (never input text).
 *
 * Contract: cmd/opencodereview/output.go and internal/session/manifest.go.
 * Coverage, not finding severity or diagnostic warnings/tool/retry reports,
 * decides completion. This is not a validator for those auxiliary payloads.
 * Waivers count as complete to OCR, but do not satisfy strict CI coverage.
 */
function validateReviewResult(result) {
  check(isObject(result), "Expected one OCR review result JSON object.");
  const manifest = result.manifest;
  check(isObject(manifest), "Missing review manifest; use this fork's OCR review --format json output.");
  check(manifest.schema_version === MANIFEST_SCHEMA_VERSION,
    "Unsupported manifest.schema_version; use a compatible OCR binary and validator.");
  check(manifest.operation === "review", "manifest.operation must be review (not scan or preview).");
  check(nonemptyString(manifest.run_id), "manifest.run_id must be a non-empty string.");
  check(!has(result, "session_id") || result.session_id === manifest.run_id,
    "session_id must match manifest.run_id.");
  check(isObject(manifest.repository) && isObject(manifest.execution),
    "manifest.repository and manifest.execution must be objects.");
  check(isObject(manifest.input) && ["range", "commit", "workspace"].includes(manifest.input.mode),
    "manifest.input.mode must be range, commit, or workspace.");
  counter(manifest.elapsed_ms, "manifest.elapsed_ms");
  check(!has(manifest, "parent_run_id") || nonemptyString(manifest.parent_run_id),
    "manifest.parent_run_id must be a non-empty string when present.");

  check(["complete", "partial", "failed", "skipped"].includes(manifest.terminal_state),
    "Unknown manifest.terminal_state; use a compatible OCR binary and validator.");
  check(result.status === manifest.terminal_state,
    "Result status must match manifest.terminal_state.");
  check(!has(manifest, "run_failure"),
    "Review has a run_failure; inspect the saved result and OCR stderr, then rerun.");
  check(result.status === "complete" || result.status === "skipped",
    "Review is partial or failed; inspect coverage.failed and OCR stderr, then rerun.");

  const coverage = manifest.coverage;
  check(isObject(coverage), "Missing manifest.coverage object.");
  for (const key of ["selected", "completed", "reused", "failed", "waived"]) {
    check(Array.isArray(coverage[key]), `manifest.coverage.${key} must be an array.`);
  }
  check(coverage.failed.length === 0, "Review has failed coverage; inspect coverage.failed and rerun.");
  check(coverage.waived.length === 0, "Review has waived coverage; rerun without waiving selected files.");
  check(coverage.reused.length === 0 || nonemptyString(manifest.parent_run_id),
    "Reused coverage requires manifest.parent_run_id.");

  const selected = new Map();
  for (const item of coverage.selected) {
    coverageItem(item, "coverage.selected");
    check(!selected.has(item.item_id), "coverage.selected contains duplicate item_id values.");
    selected.set(item.item_id, item);
  }
  const covered = new Set();
  for (const key of ["completed", "reused"]) {
    for (const item of coverage[key]) {
      coverageItem(item, `coverage.${key}`);
      const original = selected.get(item.item_id);
      check(original !== undefined, `coverage.${key} contains an unselected item.`);
      check(!covered.has(item.item_id), "Completed and reused coverage must be disjoint, without duplicates.");
      check(["path", "old_path", "fingerprint"].every((field) => item[field] === original[field]),
        `coverage.${key} item identity differs from coverage.selected.`);
      covered.add(item.item_id);
    }
  }
  check(covered.size === selected.size, "Review coverage is incomplete; not every selected item has a completed or reused outcome.");
  check(result.status === (selected.size === 0 ? "skipped" : "complete"),
    "Only a zero-selection review may be skipped; non-empty coverage must be complete.");

  const summary = result.summary;
  check(isObject(summary), "Missing review summary object.");
  for (const key of ["files_reviewed", "comments", "input_tokens", "output_tokens", "total_tokens"]) {
    counter(summary[key], `summary.${key}`);
  }
  for (const key of ["cache_read_tokens", "cache_write_tokens"]) {
    if (has(summary, key)) counter(summary[key], `summary.${key}`);
  }
  check(!has(summary, "budget_exceeded") || typeof summary.budget_exceeded === "boolean",
    "summary.budget_exceeded must be a boolean when present.");
  check(summary.budget_exceeded !== true,
    "Review budget was exhausted; increase the budget or narrow the review and rerun.");
  // FilesReviewed counts dispatchable selected files, not successful subtasks.
  check(summary.files_reviewed === selected.size, "summary.files_reviewed must equal the selected coverage count.");
  check(summary.total_tokens - summary.output_tokens === summary.input_tokens,
    "summary.total_tokens must equal input_tokens plus output_tokens.");
  // Go can encode a nil []LlmComment as null. Missing comments is not equivalent.
  check(result.comments === null || Array.isArray(result.comments), "comments must be an array or null.");
  const findings = result.comments === null ? 0 : result.comments.length;
  check(summary.comments === findings, "summary.comments must equal the findings count.");
  check(selected.size !== 0 || findings === 0, "A zero-selection review cannot contain findings.");
  for (let index = 0; index < findings; index++) finding(result.comments[index], index);

  return {
    status: result.status,
    selectedFiles: selected.size,
    completedFiles: coverage.completed.length,
    reusedFiles: coverage.reused.length,
    findings,
  };
}

function validateReviewResultFile(filePath) {
  let fd;
  let bytes;
  try {
    // Nonblocking open prevents a mistakenly supplied FIFO from hanging CI.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile(), "Result path must name a regular JSON file.");
    check(stat.size <= MAX_RESULT_BYTES, "Review result exceeds the 16 MiB limit; narrow the review and rerun.");
    // Read at most the observed size plus one byte, even if the file grows after
    // fstat. readFileSync after a size check alone would leave an unbounded race.
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    check(used === stat.size, "Review result changed while reading; wait for OCR to finish and rerun validation.");
    bytes = buffer.subarray(0, used);
  } catch (error) {
    if (error instanceof ReviewResultError) throw error;
    // Filesystem errors can contain private paths; do not forward their text.
    throw new ReviewResultError("Cannot read review result; confirm OCR wrote the result file and it is readable.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let result;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    result = JSON.parse(text);
  } catch (_) {
    // JSON.parse errors may include a source snippet, even on newer Node releases.
    throw new ReviewResultError("Result is not valid UTF-8 JSON (possibly empty or truncated); inspect OCR stderr and rerun.");
  }
  return validateReviewResult(result);
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    process.stderr.write("Usage: node scripts/github-actions/validate-review-result.js <result.json>\n");
    process.exitCode = 2;
  } else {
    try {
      validateReviewResultFile(process.argv[2]);
    } catch (error) {
      const message = error instanceof ReviewResultError
        ? error.message
        : "Unable to validate review result; check the result file and rerun validation.";
      process.stderr.write(`Review result validation failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { validateReviewResult, validateReviewResultFile, MANIFEST_SCHEMA_VERSION, MAX_RESULT_BYTES };
