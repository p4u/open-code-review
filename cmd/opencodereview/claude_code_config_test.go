// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/alibaba/open-code-review/internal/llm"
)

func claudeCodeConfigTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, key := range []string{
		"OCR_LLM_URL", "OCR_LLM_TOKEN", "OCR_LLM_MODEL", "OCR_LLM_PROTOCOL", "OCR_LLM_AUTH_HEADER",
		"OCR_LLM_EXTRA_HEADERS", "OCR_LLM_TIMEOUT", "OCR_USE_ANTHROPIC",
		"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY",
	} {
		t.Setenv(key, "")
	}
	path := filepath.Join(home, ".opencodereview", "config.json")
	t.Setenv("OCR_CONFIG_PATH", path)
	return path
}

func TestClaudeCodeConfigRoundTrip(t *testing.T) {
	path := claudeCodeConfigTestHome(t)
	cfg := &Config{
		Provider:        "claude-code",
		Providers:       map[string]ProviderEntry{"claude-code": {ClaudeCommand: "/opt/Claude Code/claude", Model: "default"}},
		CustomProviders: map[string]ProviderEntry{"local": {Protocol: llm.ProtocolClaudeCode, ClaudeCommand: "custom-claude"}},
		Llm:             LlmConfig{Protocol: llm.ProtocolClaudeCode, ClaudeCommand: "legacy-claude"},
	}
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	captureStdout(t, func() {
		if err := runConfigSet("language", "en"); err != nil {
			t.Fatal(err)
		}
	})
	reloaded, err := loadOrCreateConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Providers["claude-code"].ClaudeCommand != "/opt/Claude Code/claude" || reloaded.CustomProviders["local"].ClaudeCommand != "custom-claude" || reloaded.Llm.ClaudeCommand != "legacy-claude" {
		t.Fatal("unrelated config write discarded claude_command")
	}
	ep, err := llm.ResolveEndpoint(path)
	if err != nil || ep.ClaudeCommand != "/opt/Claude Code/claude" || ep.Model != "default" || !ep.AmbientAuth {
		t.Fatalf("resolver did not read the persisted executable: %+v, %v", ep, err)
	}
	cloned := cloneProviderEntry(reloaded.Providers["claude-code"])
	if cloned.ClaudeCommand != reloaded.Providers["claude-code"].ClaudeCommand {
		t.Fatal("TUI clone lost executable configuration")
	}
}

func TestClaudeCodeConfigSetAndResolve(t *testing.T) {
	for _, tc := range []struct {
		name     string
		prefix   string
		provider string
	}{
		{"preset", "providers.claude-code", "claude-code"},
		{"custom", "custom_providers.local", "local"},
		{"legacy", "llm", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := claudeCodeConfigTestHome(t)
			cfg := &Config{}
			if tc.provider != "" {
				if err := setConfigValue(cfg, "provider", tc.provider); err != nil {
					t.Fatal(err)
				}
			}
			for _, field := range []struct{ key, value string }{
				{"protocol", "  Claude-Code  "}, {"claude_command", "/opt/Claude Code/claude"},
				{"model", "future-model[1m]"}, {"timeout_sec", "19"},
			} {
				if err := setConfigValue(cfg, tc.prefix+"."+field.key, field.value); err != nil {
					t.Fatalf("set %s: %v", field.key, err)
				}
			}
			if err := saveConfig(path, cfg); err != nil {
				t.Fatal(err)
			}
			ep, err := llm.ResolveEndpoint(path)
			if err != nil || ep.Protocol != llm.ProtocolClaudeCode || ep.ClaudeCommand != "/opt/Claude Code/claude" || ep.Model != "future-model[1m]" {
				t.Fatalf("round trip failed: %+v, %v", ep, err)
			}
			if ep.URL != "" || ep.Token != "" || ep.AuthHeader != "" {
				t.Fatal("subprocess configuration unexpectedly contains HTTP fields")
			}
			if cfg.Llm.Protocol == llm.ProtocolClaudeCode && cfg.Llm.UseAnthropic != nil {
				t.Fatal("CLI transport must not claim to have a legacy HTTP equivalent")
			}
		})
	}
}

func TestClaudeCodeConfigRejectsUnsupportedFields(t *testing.T) {
	for _, field := range []struct{ name, value string }{
		{"url", "https://sensitive.invalid"}, {"api_key", "sensitive-fixture"}, {"api_key_cmd", "sensitive-command"},
		{"auth_header", "authorization"}, {"extra_body", `{"fixture":"sensitive-value"}`},
		{"extra_headers", "X-Fixture=sensitive-value"}, {"retry_codes", "400"},
		{"aws_profile", "fixture-profile"}, {"aws_region", "us-west-2"}, {"claude_command", "sensitive\ncommand"},
	} {
		t.Run(field.name, func(t *testing.T) {
			cfg := &Config{}
			err := setConfigValue(cfg, "providers.claude-code."+field.name, field.value)
			if err == nil || !strings.Contains(err.Error(), field.name) {
				t.Fatalf("want error naming %s, got %v", field.name, err)
			}
			if strings.Contains(err.Error(), "sensitive") {
				t.Fatal("config validation exposed a value")
			}
			if entry, ok := cfg.Providers["claude-code"]; ok && !reflect.DeepEqual(entry, ProviderEntry{}) {
				t.Fatal("failed config edit changed the provider entry")
			}
		})
	}
	for _, key := range []string{"providers.openai.claude_command", "custom_providers.local.claude_command", "llm.claude_command"} {
		if err := setConfigValue(&Config{}, key, "claude"); err == nil || !strings.Contains(err.Error(), "requires protocol") {
			t.Fatalf("%s accepted an executable for a non-CLI protocol: %v", key, err)
		}
	}
	for _, key := range []string{"llm.auth_token", "llm.auth_token_cmd", "llm.url", "llm.extra_headers"} {
		cfg := &Config{Llm: LlmConfig{Protocol: llm.ProtocolClaudeCode}}
		before := cfg.Llm
		value := "sensitive-fixture"
		if key == "llm.extra_headers" {
			value = "X-Fixture=sensitive-value"
		}
		if err := setConfigValue(cfg, key, value); err == nil {
			t.Fatalf("%s accepted for the CLI protocol", key)
		}
		if !reflect.DeepEqual(cfg.Llm, before) {
			t.Fatalf("rejected %s edit changed the legacy block", key)
		}
	}
}

func TestClaudeCodeConfigProtocolSwitchValidation(t *testing.T) {
	cfg := &Config{Providers: map[string]ProviderEntry{"openai": {APIKey: "fixture-key"}}}
	if err := setConfigValue(cfg, "providers.openai.protocol", llm.ProtocolClaudeCode); err == nil {
		t.Fatal("HTTP fields must be cleared before switching to CLI")
	}
	if cfg.Providers["openai"].Protocol != "" {
		t.Fatal("failed protocol change was applied")
	}
	for _, field := range []struct{ key, value string }{
		{"api_key", ""}, {"protocol", llm.ProtocolClaudeCode}, {"claude_command", "fixture-claude"},
	} {
		if err := setConfigValue(cfg, "providers.openai."+field.key, field.value); err != nil {
			t.Fatal(err)
		}
	}
	if err := setConfigValue(cfg, "providers.openai.protocol", llm.ProtocolOpenAIChatCompletions); err == nil {
		t.Fatal("switching to HTTP must reject a leftover claude_command")
	}
	if err := setConfigValue(cfg, "providers.openai.claude_command", ""); err != nil {
		t.Fatal(err)
	}
	if err := setConfigValue(cfg, "providers.openai.protocol", llm.ProtocolOpenAIChatCompletions); err != nil {
		t.Fatal(err)
	}
	if err := setConfigValue(cfg, "providers.openai.api_key", "fixture-key"); err != nil {
		t.Fatal("HTTP provider behavior changed after switching back")
	}
}

func TestClaudeCodeProviderTUINoAPIKeyStep(t *testing.T) {
	for _, custom := range []bool{false, true} {
		t.Run(map[bool]string{false: "preset", true: "custom"}[custom], func(t *testing.T) {
			cfg := &Config{Provider: "claude-code"}
			if custom {
				cfg.Provider = "local"
				cfg.CustomProviders = map[string]ProviderEntry{"local": {Protocol: llm.ProtocolClaudeCode, Models: []string{"default"}}}
			}
			m := newProviderTUI(cfg, "")
			// Returning from another provider's key screen must not leak its key
			// into the CLI result when the credential screen is skipped.
			m.apiKeyOriginal = "unrelated-fixture"
			m.apiKeyMasked = true
			result, _ := m.Update(enterKey())
			m = result.(providerTUIModel)
			if m.step != stepModel {
				t.Fatal("provider selection did not open the model picker")
			}
			view := m.View().Content
			if !strings.Contains(view, "Claude CLI") || strings.Contains(view, "AWS chain") {
				t.Fatalf("model picker lacks CLI-specific guidance: %s", view)
			}
			result, cmd := m.Update(enterKey())
			done := result.(providerTUIModel)
			if done.step == stepAPIKey || !done.confirmed || cmd == nil {
				t.Fatal("CLI model selection must finish without asking for a key")
			}
			if r := done.result(); r.apiKey != "" || r.resolvedModel() != "default" {
				t.Fatal("CLI selection should use the default model and have no key")
			}
		})
	}
}

func TestClaudeCodeCustomProviderForm(t *testing.T) {
	path := claudeCodeConfigTestHome(t)
	m := newProviderTUI(&Config{}, path)
	m.activeTab = tabCustom
	m.creatingCustom = true
	m.cpStep = cpStepProtocol
	m.cpProtocolIdx = cpProtocolIndex(llm.ProtocolClaudeCode)
	m.cpNameInput.SetValue("local")
	m.cpURLInput.SetValue("https://unused.invalid")
	m.apiKeyInput.SetValue("unrelated-fixture")
	m.cpAuthInput.SetValue("authorization")
	view := m.View().Content
	if !strings.Contains(view, "Claude CLI") || !strings.Contains(view, "claude_command") || strings.Contains(view, "AWS chain") || strings.Contains(view, "Base URL:") {
		t.Fatalf("incorrect CLI custom-provider form: %s", view)
	}
	updated, _ := m.handleCustomFormEnter()
	m = updated.(providerTUIModel)
	if m.formError != "" || m.step != stepModel || m.creatingCustom {
		t.Fatalf("CLI form did not skip URL/authentication fields: %s", m.formError)
	}
	entry := m.existingCfg.CustomProviders["local"]
	if entry.Protocol != llm.ProtocolClaudeCode || entry.URL != "" || entry.APIKey != "" || entry.AuthHeader != "" || len(entry.Models) == 0 || entry.Models[0] != "default" {
		t.Fatal("custom CLI form saved inappropriate defaults")
	}
	updated, _ = m.Update(enterKey())
	if !updated.(providerTUIModel).confirmed {
		t.Fatal("new custom CLI provider still requested an API key")
	}
}

func TestClaudeCodeTUIHonorsEffectiveProtocol(t *testing.T) {
	cfg := &Config{Provider: "claude-code", Providers: map[string]ProviderEntry{"claude-code": {Protocol: llm.ProtocolOpenAIChatCompletions}}}
	m := newProviderTUI(cfg, "")
	updated, _ := m.Update(enterKey())
	updated, _ = updated.(providerTUIModel).Update(enterKey())
	if updated.(providerTUIModel).step != stepAPIKey {
		t.Fatal("a preset overridden to HTTP still requires a key")
	}
	preset, _ := llm.LookupProvider("claude-code")
	if err := checkAPIKeyRequirement(preset.Name, "", "", preset, true); err != nil {
		t.Fatal(err)
	}
	if providerAcceptsAWSSettings("claude-code", &ProviderEntry{}) {
		t.Fatal("ambient CLI authentication is not the AWS credential chain")
	}
}

func claudeCodeConfigFakeCommand(t *testing.T) (command, argsPath string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake executable uses a POSIX shell")
	}
	dir := t.TempDir()
	command = filepath.Join(dir, "fake claude")
	argsPath = filepath.Join(dir, "arguments")
	t.Setenv("OCR_TEST_CLAUDE_CONFIG_ARGS", argsPath)
	// This fixture never launches the installed CLI or contacts an LLM service.
	script := `#!/bin/sh
printf '%s\n' "$@" > "$OCR_TEST_CLAUDE_CONFIG_ARGS"
while IFS= read -r line; do :; done
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Fixture connection response.","usage":{"input_tokens":11,"output_tokens":4},"modelUsage":{"fixture-actual-model":{}}}'
`
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return command, argsPath
}

func TestClaudeCodeLLMTestUsesSubprocess(t *testing.T) {
	path := claudeCodeConfigTestHome(t)
	command, argsPath := claudeCodeConfigFakeCommand(t)
	cfg := &Config{Provider: "claude-code", Providers: map[string]ProviderEntry{"claude-code": {ClaudeCommand: command}}}
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	out := captureStdout(t, func() {
		if err := runLLMTest(); err != nil {
			t.Fatal(err)
		}
	})
	for _, text := range []string{"Backend: Claude Code CLI", "fixture-actual-model", "Fixture connection response.", "Connection test successful"} {
		if !strings.Contains(out, text) {
			t.Fatalf("llm test output lacks %q: %s", text, out)
		}
	}
	if strings.Contains(out, "URL:") || strings.Contains(out, "AWS chain") {
		t.Fatalf("llm test rendered HTTP or AWS settings for the CLI backend: %s", out)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal("configured executable was not run")
	}
	if strings.Contains(string(args), "--model\n") {
		t.Fatal("default model must not override the Claude CLI's model setting")
	}
	out = captureStdout(t, func() {
		if err := applyOfficialProviderConfig(path, cfg, providerTUIResult{provider: "claude-code", model: "custom-model[1m]"}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "Connection test successful") {
		t.Fatal("saving the official CLI preset did not run its subprocess connection test")
	}
	args, err = os.ReadFile(argsPath)
	if err != nil || !strings.Contains(string(args), "--model\ncustom-model[1m]\n") {
		t.Fatal("custom model did not reach the subprocess unchanged")
	}
	reloaded, err := loadOrCreateConfig(path)
	if err != nil || reloaded.Providers["claude-code"].ClaudeCommand != command {
		t.Fatal("official provider save lost the custom executable")
	}
}

func TestClaudeCodeCustomProviderSaveKeepsExecutable(t *testing.T) {
	path := claudeCodeConfigTestHome(t)
	command, _ := claudeCodeConfigFakeCommand(t)
	cfg := &Config{CustomProviders: map[string]ProviderEntry{"local": {Protocol: llm.ProtocolClaudeCode, ClaudeCommand: command}}}
	out := captureStdout(t, func() {
		if err := applyCustomProviderConfig(path, cfg, providerTUIResult{provider: "local", model: "default", isCustom: true, protocol: llm.ProtocolClaudeCode}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "Connection test successful") || cfg.CustomProviders["local"].ClaudeCommand != command {
		t.Fatal("custom CLI provider save did not preserve the executable and test through it")
	}
}

func TestClaudeCodeLLMProvidersListing(t *testing.T) {
	out := captureStdout(t, runLLMProviders)
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "claude-code") {
			if !strings.Contains(line, "local subprocess") || strings.Contains(line, "http") {
				t.Fatalf("incorrect CLI provider listing: %s", line)
			}
			return
		}
	}
	t.Fatal("built-in provider listing omitted claude-code")
}
