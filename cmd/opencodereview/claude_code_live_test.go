// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// TestClaudeCodeEndToEnd deliberately uses the caller's normal CLI login and
// creates real OCR sessions. It is opt-in because it consumes model usage.
func TestClaudeCodeEndToEnd(t *testing.T) {
	if os.Getenv("OCR_TEST_CLAUDE_CODE") != "1" {
		t.Skip("set OCR_TEST_CLAUDE_CODE=1 to test against the authenticated Claude CLI")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	repo := initTestGitRepo(t)
	original := `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package stats

// Average returns zero for empty input and the integer mean otherwise.
func Average(values []int) int {
    if len(values) == 0 {
        return 0
    }
    sum := 0
    for _, value := range values {
        sum += value
    }
    return sum / len(values)
}
`
	gitCommitFile(t, repo, "average.go", original, "Add average calculation")
	changed := strings.Replace(original, "    if len(values) == 0 {\n        return 0\n    }\n", "", 1)
	path := filepath.Join(repo, "average.go")
	if err := os.WriteFile(path, []byte(changed), 0o600); err != nil {
		t.Fatal(err)
	}
	background := "Average must return zero for empty input. Use file_read to verify the implementation before reporting. Review only; do not edit source files."
	for _, operation := range []string{"review", "scan"} {
		t.Run(operation, func(t *testing.T) {
			outputPath := filepath.Join(t.TempDir(), "result.json")
			if operation == "review" {
				var opts reviewOptions
				registerReviewFlags(&cobra.Command{}, &opts)
				opts.repoDir, opts.provider, opts.model = repo, "claude-code", "default"
				opts.outputFormat, opts.outputPath, opts.audience = "json", outputPath, "agent"
				opts.concurrency, opts.effort, opts.background = 1, "low", background
				if err := executeReviewContext(context.Background(), opts); err != nil {
					t.Fatal(err)
				}
			} else {
				var opts scanOptions
				registerScanFlags(&cobra.Command{}, &opts)
				opts.repoDir, opts.provider, opts.model = repo, "claude-code", "default"
				opts.outputFormat, opts.outputPath, opts.audience = "json", outputPath, "agent"
				opts.concurrency, opts.paths, opts.background = 1, "average.go", background
				if err := executeScan(opts); err != nil {
					t.Fatal(err)
				}
			}
			data, err := os.ReadFile(outputPath)
			if err != nil {
				t.Fatal(err)
			}
			var result jsonOutput
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
			if result.Status != "complete" && result.Status != "success" {
				t.Fatalf("run did not complete: %s", result.Status)
			}
			if result.LLM == nil || result.LLM.Provider != "claude-code" {
				t.Fatalf("wrong backend: %+v", result.LLM)
			}
			if result.Summary == nil || result.Summary.FilesReviewed != 1 || result.Summary.TotalTokens <= 0 {
				t.Fatalf("missing review coverage or usage: %+v", result.Summary)
			}
			if result.ToolCalls == nil || result.ToolCalls.ByTool["code_comment"] == 0 || result.ToolCalls.Failure != 0 {
				t.Fatalf("OCR tools did not execute successfully: %+v", result.ToolCalls)
			}
			if len(result.Comments) == 0 || len(result.Warnings) > 0 {
				t.Fatalf("expected a finding and no warnings; findings=%d, warnings=%+v", len(result.Comments), result.Warnings)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != changed {
				t.Fatalf("review modified the input file: %v", err)
			}
			t.Logf("%s: %d findings, %d tokens, session %s", operation, len(result.Comments), result.Summary.TotalTokens, result.SessionID)
		})
	}
}
