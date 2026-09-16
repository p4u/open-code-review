//go:build !windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestClaudeCodeProcessCancelAfterExit(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
	cmd := exec.CommandContext(context.Background(), self, "-test.run=^$")
	configureClaudeCodeProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("CLI was not assigned its own process group")
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Cancel(); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("cancel after process exit = %v, want os.ErrProcessDone", err)
	}
}

func TestClaudeCodeSubprocessCancellationKillsDescendants(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux /proc to distinguish killed orphan zombies from running processes")
	}
	command, records := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Mode: "descendant"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command, Timeout: 10 * time.Second}).CompletionsWithCtx(ctx, claudeCodeTestRequest())
		done <- err
	}()
	pid := claudeCodeTestDescendantPID(t, records)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled process group: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("descendant holding stdout prevented cancellation")
	}
	claudeCodeTestProcessExited(t, pid)
	claudeCodeTestCleaned(t, claudeCodeTestInvocations(t, records, 1))
}

func TestClaudeCodeSubprocessParentExitKillsDescendants(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux /proc to distinguish killed orphan zombies from running processes")
	}
	command, records := newClaudeCodeTestCLI(t, claudeCodeHelperConfig{Mode: "orphan"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := NewClaudeCodeClient(ClientConfig{ClaudeCommand: command, Timeout: 10 * time.Second}).CompletionsWithCtx(ctx, claudeCodeTestRequest())
		done <- err
	}()
	pid := claudeCodeTestDescendantPID(t, records)
	select {
	case err := <-done:
		// The parent exits normally without waiting for its pipe-holding child.
		// WaitDelay, not context cancellation, must bound this invocation.
		if !errors.Is(err, exec.ErrWaitDelay) {
			t.Fatalf("parent-exits-first error = %v, want exec.ErrWaitDelay", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("orphan holding stdout prevented bounded completion")
	}
	claudeCodeTestProcessExited(t, pid)
	claudeCodeTestCleaned(t, claudeCodeTestInvocations(t, records, 1))
}

func claudeCodeTestDescendantPID(t *testing.T, records string) int {
	t.Helper()
	var pid int
	claudeCodeTestWait(t, func() bool {
		data, err := os.ReadFile(filepath.Join(records, "descendant.pid"))
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(string(data))
		return err == nil && pid > 0
	})
	// Reclaim the fixture even if an assertion fails before production cleanup.
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	return pid
}

func claudeCodeTestProcessExited(t *testing.T, pid int) {
	t.Helper()
	claudeCodeTestWait(t, func() bool {
		data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
		if errors.Is(err, os.ErrNotExist) {
			return true
		}
		// PID 1 need not reap orphaned children promptly in containers. A zombie
		// has terminated and closed all pipes, so it is not a surviving child.
		_, state, found := strings.Cut(string(data), ") ")
		return found && strings.HasPrefix(state, "Z ")
	})
}
