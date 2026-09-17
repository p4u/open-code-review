// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func assertClaudeCodeSafeDiagnostic(t *testing.T, detail string) {
	t.Helper()
	if len(detail) > claudeCodeStderrLimit || !utf8.ValidString(detail) {
		t.Fatal("diagnostic exceeds its presentation limit or contains invalid UTF-8")
	}
	for _, r := range detail {
		if !strconv.IsPrint(r) {
			t.Fatalf("diagnostic contains unescaped control character %U", r)
		}
	}
}

func TestClaudeCodeDiagnosticPresentation(t *testing.T) {
	if presentClaudeCodeError(nil) != nil {
		t.Fatal("successful completion acquired an error")
	}
	secret := "fake-diagnostic-secret"
	t.Setenv("OCR_CLAUDE_TEST_SECRET", secret)
	sentinel := errors.New(secret + "\n::error::untrusted\r\t\x1b[31m\x00" + string([]rune{0x85, 0x2028, 0x2029, 0x202e}))
	err := presentClaudeCodeError(fmt.Errorf("completion: %w", sentinel))
	if !errors.Is(err, sentinel) || presentClaudeCodeError(err) != err {
		t.Fatal("presentation lost the original cause or was wrapped repeatedly")
	}
	assertClaudeCodeSafeDiagnostic(t, err.Error())
	if strings.Contains(err.Error(), secret) {
		t.Fatal("diagnostic leaked the synthetic credential")
	}
	for _, escaped := range []string{"[REDACTED]", `\n::error::untrusted`, `\r`, `\t`, `\x1b`, `\x00`, "u0085", "u2028", "u2029", "u202e"} {
		if !strings.Contains(err.Error(), escaped) {
			t.Fatalf("diagnostic lost escaped detail %q", escaped)
		}
	}
	for _, tt := range []struct {
		text      string
		truncated bool
	}{
		{strings.Repeat("x", claudeCodeStderrLimit), false},
		{strings.Repeat("x", claudeCodeStderrLimit+1), true},
		{strings.Repeat("\x1b", claudeCodeStderrLimit), true},
		{strings.Repeat(string(rune(0x754c)), claudeCodeStderrLimit), true},
		{strings.Repeat("x", claudeCodeStderrLimit-len(secret)/2) + secret, false},
	} {
		got := redactClaudeCodeError(tt.text)
		assertClaudeCodeSafeDiagnostic(t, got)
		if strings.HasSuffix(got, " [truncated]") != tt.truncated {
			t.Fatal("diagnostic has an incorrect truncation marker")
		}
		if strings.Contains(got, "fake-diagnostic") || redactClaudeCodeError(got) != got {
			t.Fatal("redaction occurred after truncation or presentation was not idempotent")
		}
	}
}

func TestClaudeCodeDiagnosticsRedactEveryParsePath(t *testing.T) {
	for _, secret := range []string{"fake-parse-secret", "fake-quoted-\"secret\\\n<value>"} {
		t.Run(strconv.Quote(secret), func(t *testing.T) {
			t.Setenv("ANTHROPIC_AUTH_TOKEN", secret)
			for _, tt := range []struct {
				name   string
				mutate func(*ChatRequest, map[string]any)
				want   string
			}{
				{"result subtype", func(_ *ChatRequest, r map[string]any) { r["subtype"] = secret }, "Claude Code result"},
				{"result errors", func(_ *ChatRequest, r map[string]any) {
					r["subtype"], r["errors"] = "error_max_turns", []string{secret}
				}, "error_max_turns"},
				{"result text", func(_ *ChatRequest, r map[string]any) { r["is_error"], r["result"] = true, secret }, "Claude Code result"},
				{"unknown function", func(_ *ChatRequest, r map[string]any) {
					r["structured_output"] = map[string]any{"content": "", "tool_calls": []any{map[string]any{"name": secret, "arguments": map[string]any{}}}}
				}, "unknown function"},
				{"unknown output field", func(_ *ChatRequest, r map[string]any) {
					r["structured_output"] = map[string]any{"content": "done", "tool_calls": []any{}, secret: true}
				}, "unknown field"},
				{"null arguments", func(req *ChatRequest, r map[string]any) {
					req.Tools[0].Function.Name = secret
					r["structured_output"] = map[string]any{"content": "", "tool_calls": []any{map[string]any{"name": secret, "arguments": nil}}}
				}, "JSON argument object"},
				{"invalid argument type", func(req *ChatRequest, r map[string]any) {
					req.Tools[0].Function.Name = secret
					r["structured_output"] = map[string]any{"content": "", "tool_calls": []any{map[string]any{"name": secret, "arguments": []any{}}}}
				}, "JSON argument object"},
				{"schema validation", func(req *ChatRequest, r map[string]any) {
					req.Tools[0].Function.Parameters = map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "integer"}}}
					r["structured_output"] = map[string]any{"content": "", "tool_calls": []any{map[string]any{"name": "lookup", "arguments": map[string]any{"name": secret}}}}
				}, "invalid arguments"},
			} {
				t.Run(tt.name, func(t *testing.T) {
					req, result := claudeCodeTestRequest(), claudeCodeTestResult()
					req.Tools = []ToolDef{claudeCodeTestTool()}
					tt.mutate(&req, result)
					for _, exitCode := range []int{0, 7} {
						t.Run(strconv.Itoa(exitCode), func(t *testing.T) {
							command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Output: string(claudeCodeTestJSON(t, result)), ExitCode: exitCode})
							writer, holder := &recordingRawWriter{}, NewRawHolder()
							holder.Set(writer)
							resp, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command, rawHolder: holder}).CompletionsWithCtx(context.Background(), req)
							claudeCodeTestError(t, err, tt.want)
							assertClaudeCodeSafeDiagnostic(t, err.Error())
							if resp != nil || strings.Contains(err.Error(), "fake-parse") || strings.Contains(err.Error(), "fake-quoted") || !strings.Contains(err.Error(), "[REDACTED]") {
								t.Fatal("parse failure returned a response or leaked a synthetic credential")
							}
							if writer.one(t).Error != err.Error() {
								t.Fatal("raw error metadata differs from the safe completion diagnostic")
							}
							if exitCode != 0 {
								var exitErr *exec.ExitError
								if !errors.As(err, &exitErr) || exitErr.ExitCode() != exitCode {
									t.Fatal("diagnostic lost its subprocess exit status")
								}
							}
						})
					}
				})
			}
		})
	}
}

func TestClaudeCodeDiagnosticsBoundCombinedFailure(t *testing.T) {
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "fake-combined-secret")
	result := claudeCodeTestResult()
	result["subtype"] = "error_max_turns"
	result["errors"] = []string{"fake-combined-secret\n::error::untrusted\r\x1b[31m" + strings.Repeat("x", claudeCodeStderrLimit*2)}
	command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{
		Output: string(claudeCodeTestJSON(t, result)), ExitCode: 3,
		Stderr: "fake-combined-secret\n::warning::untrusted" + strings.Repeat("x", claudeCodeStderrLimit),
	})
	_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command}).CompletionsWithCtx(context.Background(), claudeCodeTestRequest())
	claudeCodeTestError(t, err, `Claude Code result "error_max_turns"`)
	claudeCodeTestError(t, err, "exit status 3")
	claudeCodeTestError(t, err, `[REDACTED]\n::error::untrusted\r\x1b[31m`)
	assertClaudeCodeSafeDiagnostic(t, err.Error())
	if strings.Contains(err.Error(), "fake-combined-secret") || !strings.HasSuffix(err.Error(), " [truncated]") {
		t.Fatal("combined failure was not redacted and truncated")
	}
}

func TestClaudeCodeDiagnosticsOmitTruncatedStderr(t *testing.T) {
	const secret = "fake-straddling-stderr-secret"
	const exposedPrefix = "fake-straddling"
	t.Setenv("ANTHROPIC_AUTH_TOKEN", secret)
	result := claudeCodeTestResult()
	result["subtype"], result["errors"] = "error_max_turns", []string{"turn limit reached"}
	command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{
		Output: string(claudeCodeTestJSON(t, result)), ExitCode: 7,
		Stderr: strings.Repeat("x", claudeCodeStderrLimit-len(exposedPrefix)) + secret,
	})
	_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command}).CompletionsWithCtx(context.Background(), claudeCodeTestRequest())
	claudeCodeTestError(t, err, "stderr omitted: exceeds 65536-byte capture limit")
	claudeCodeTestError(t, err, `Claude Code result "error_max_turns"`)
	claudeCodeTestError(t, err, "turn limit reached")
	claudeCodeTestError(t, err, "exit status 7")
	assertClaudeCodeSafeDiagnostic(t, err.Error())
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), exposedPrefix) || strings.Contains(err.Error(), strings.Repeat("x", 32)) {
		t.Fatal("oversized stderr exposed captured output or a partial credential")
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatal("omitting oversized stderr lost the process cause")
	}
}

func TestClaudeCodeDiagnosticsPreserveParserCauses(t *testing.T) {
	for _, exitCode := range []int{0, 7} {
		for _, tt := range []struct {
			name, output string
			check        func(error) bool
		}{
			{"syntax", "not JSON", func(err error) bool { var cause *json.SyntaxError; return errors.As(err, &cause) }},
			{"type", `{"usage":42}`, func(err error) bool { var cause *json.UnmarshalTypeError; return errors.As(err, &cause) }},
		} {
			t.Run(fmt.Sprintf("%s/exit-%d", tt.name, exitCode), func(t *testing.T) {
				command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Output: tt.output, ExitCode: exitCode})
				_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command}).CompletionsWithCtx(context.Background(), claudeCodeTestRequest())
				if !tt.check(err) {
					t.Fatalf("parser cause lost: %v", err)
				}
			})
		}
	}
	t.Run("arguments", func(t *testing.T) {
		req, result := claudeCodeTestRequest(), claudeCodeTestResult()
		req.Tools = []ToolDef{claudeCodeTestTool()}
		result["structured_output"] = json.RawMessage(`{"content":"","tool_calls":[{"name":"lookup","arguments":[]}]}`)
		command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Output: string(claudeCodeTestJSON(t, result))})
		_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command}).CompletionsWithCtx(context.Background(), req)
		var cause *json.UnmarshalTypeError
		if !errors.As(err, &cause) {
			t.Fatalf("argument decoding cause lost: %v", err)
		}
	})
}

func TestClaudeCodeDiagnosticsEarlyFailures(t *testing.T) {
	secret := "fake-early-\"secret\\\nvalue"
	t.Setenv("ANTHROPIC_AUTH_TOKEN", secret)
	t.Setenv("OCR_CLAUDE_TEST_TOKEN", secret+"-longer")
	if got := redactClaudeCodeError(secret + "-longer " + secret); got != "[REDACTED] [REDACTED]" {
		t.Fatal("overlapping credential redaction left a suffix")
	}
	req := claudeCodeTestRequest()
	req.ToolChoice = secret
	_, err := NewClaudeCodeClient(ClientConfig{}).CompletionsWithCtx(context.Background(), req)
	claudeCodeTestError(t, err, "unsupported Claude Code tool_choice")
	claudeCodeTestError(t, err, "[REDACTED]")
	if strings.Contains(err.Error(), "fake-early") {
		t.Fatal("early request validation bypassed redaction")
	}
	assertClaudeCodeSafeDiagnostic(t, err.Error())
	_, err = NewClaudeCodeClient(ClientConfig{ClaudeCommand: filepath.Join(t.TempDir(), "missing-claude")}).CompletionsWithCtx(context.Background(), claudeCodeTestRequest())
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("executable lookup cause lost: %v", err)
	}
}

func TestClaudeCodeDiagnosticsContextOrigin(t *testing.T) {
	for _, tt := range []struct {
		name         string
		parentLimit  time.Duration
		requestLimit time.Duration
		wantOrigin   string
	}{
		{"earlier parent deadline", 500 * time.Millisecond, 10 * time.Second, "parent context ended (configured request limit 10s)"},
		{"earlier request deadline", 10 * time.Second, 500 * time.Millisecond, "request timeout (configured limit 500ms)"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			command, _ := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Mode: "hang"})
			parentCause := errors.New("synthetic parent deadline cause")
			ctx, cancel := context.WithTimeoutCause(context.Background(), tt.parentLimit, parentCause)
			defer cancel()
			_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command, Timeout: tt.requestLimit}).CompletionsWithCtx(ctx, claudeCodeTestRequest())
			claudeCodeTestError(t, err, tt.wantOrigin)
			if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				t.Fatalf("deadline identity lost: %v", err)
			}
			if errors.Is(err, parentCause) != (tt.parentLimit < tt.requestLimit) {
				t.Fatal("diagnostic attributed deadline to the wrong context")
			}
			assertClaudeCodeSafeDiagnostic(t, err.Error())
		})
	}
	for _, preCanceled := range []bool{false, true} {
		t.Run(fmt.Sprintf("parent cancellation/pre-canceled-%t", preCanceled), func(t *testing.T) {
			command, records := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Mode: "hang"})
			t.Setenv("ANTHROPIC_AUTH_TOKEN", "fake-parent-secret")
			cause := errors.New("fake-parent-secret\n::error::untrusted")
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			if preCanceled {
				cancel(cause)
			}
			done := make(chan error, 1)
			go func() {
				_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command, Timeout: 10 * time.Second}).CompletionsWithCtx(ctx, claudeCodeTestRequest())
				done <- err
			}()
			if !preCanceled {
				claudeCodeTestWait(t, func() bool { entries, _ := os.ReadDir(records); return len(entries) > 0 })
				cancel(cause)
			}
			select {
			case err := <-done:
				claudeCodeTestError(t, err, "parent context ended (configured request limit 10s)")
				claudeCodeTestError(t, err, `[REDACTED]\n::error::untrusted`)
				if !errors.Is(err, context.Canceled) || !errors.Is(err, cause) || errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("parent cancellation identity lost: %v", err)
				}
				assertClaudeCodeSafeDiagnostic(t, err.Error())
			case <-time.After(5 * time.Second):
				t.Fatal("parent cancellation did not stop the subprocess")
			}
		})
	}
}
