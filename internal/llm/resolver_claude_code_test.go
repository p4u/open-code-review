// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveClaudeCodeExplicitProviderWithoutConfig(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	path := filepath.Join(t.TempDir(), "missing.json")
	for _, model := range []string{"", "default", "sonnet", "sonnet[1m]", "custom-model-id"} {
		t.Run(model, func(t *testing.T) {
			ep, err := ResolveEndpointWithOptions(path, ResolveOptions{Provider: "claude-code", Model: model})
			if err != nil {
				t.Fatal(err)
			}
			wantModel := model
			if wantModel == "" {
				wantModel = "default"
			}
			if ep.Protocol != ProtocolClaudeCode || !ep.AmbientAuth || ep.Model != wantModel || ep.Provider != "claude-code" {
				t.Fatalf("unexpected endpoint: %+v", ep)
			}
			if ep.Token != "" || ep.URL != "" || ep.AuthHeader != "" || ep.ClaudeCommand != "" {
				t.Fatal("a CLI endpoint must not populate HTTP settings or override the executable by default")
			}
		})
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("resolving the CLI preset created a configuration file")
	}
	if _, err := ResolveEndpointWithOptions(path, ResolveOptions{Provider: "anthropic"}); err == nil {
		t.Fatal("the missing-config exception must not apply to HTTP providers")
	}
}

func TestResolveClaudeCodeConfigSources(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	for _, tc := range []struct {
		name        string
		cfg         configFile
		opts        ResolveOptions
		wantModel   string
		wantCommand string
	}{
		{name: "preset without entry", cfg: configFile{Provider: "claude-code"}, wantModel: "default"},
		{name: "empty preset entry", cfg: configFile{Provider: "claude-code", Providers: map[string]providerEntryConfig{"claude-code": {}}}, wantModel: "default"},
		{name: "global model", cfg: configFile{Provider: "claude-code", Model: "opus"}, wantModel: "opus"},
		{name: "entry model and executable", cfg: configFile{Provider: "claude-code", Model: "opus", Providers: map[string]providerEntryConfig{"claude-code": {Model: "sonnet", ClaudeCommand: "/opt/Claude Code/claude"}}}, wantModel: "sonnet", wantCommand: "/opt/Claude Code/claude"},
		{name: "custom model override", cfg: configFile{Provider: "claude-code", Model: "opus"}, opts: ResolveOptions{Model: "future-custom-model[1m]"}, wantModel: "future-custom-model[1m]"},
		{name: "custom provider", cfg: configFile{Provider: "local", CustomProviders: map[string]providerEntryConfig{"local": {Protocol: "  CLAUDE-CODE  ", ClaudeCommand: "custom-claude"}}}, wantModel: "default", wantCommand: "custom-claude"},
		{name: "HTTP preset protocol override", cfg: configFile{Provider: "anthropic", Providers: map[string]providerEntryConfig{"anthropic": {Protocol: ProtocolClaudeCode}}}, wantModel: "default"},
		{name: "legacy block", cfg: configFile{Llm: llmFileConfig{Protocol: "  Claude-Code  ", ClaudeCommand: "local-claude"}}, wantModel: "default", wantCommand: "local-claude"},
		{name: "legacy model override", cfg: configFile{Llm: llmFileConfig{Protocol: ProtocolClaudeCode, Model: "opus"}}, opts: ResolveOptions{Model: "sonnet[1m]"}, wantModel: "sonnet[1m]"},
		{name: "explicit selection drops unrelated global model", cfg: configFile{Provider: "openai", Model: "gpt-example", Providers: map[string]providerEntryConfig{"openai": {APIKey: "fixture-key"}}}, opts: ResolveOptions{Provider: "claude-code"}, wantModel: "default"},
		{name: "explicit selection ignores legacy endpoint", cfg: configFile{Model: "gpt-example", Llm: llmFileConfig{URL: "https://unused.invalid", AuthToken: "fixture-token", Model: "old-model"}}, opts: ResolveOptions{Provider: "claude-code"}, wantModel: "default"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, before := writeResolverConfig(t, tc.cfg)
			ep, err := ResolveEndpointWithOptions(path, tc.opts)
			if err != nil {
				t.Fatal(err)
			}
			if ep.Protocol != ProtocolClaudeCode || !ep.AmbientAuth || ep.Model != tc.wantModel || ep.ClaudeCommand != tc.wantCommand {
				t.Fatalf("unexpected endpoint: %+v", ep)
			}
			if ep.URL != "" || ep.Token != "" || ep.AuthHeader != "" {
				t.Fatal("CLI configuration inherited HTTP fields")
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != string(before) {
				t.Fatal("resolution mutated configuration")
			}
		})
	}
}

func TestResolveClaudeCodeEnvironmentAndPrecedence(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	t.Setenv(envOCRLLMProtocol, "  CLAUDE-CODE  ")
	// Claude CLI environment belongs to the child; never translate it into an
	// OCR HTTP endpoint when the subprocess backend was selected.
	t.Setenv(envCCBaseURL, "https://unused.invalid")
	t.Setenv(envCCToken, "fixture-token")
	t.Setenv(envCCModel, "cli-managed-model")
	path := filepath.Join(t.TempDir(), "missing.json")
	ep, err := ResolveEndpoint(path)
	if err != nil || ep.Protocol != ProtocolClaudeCode || ep.Model != "default" || ep.Source != "OCR environment" {
		t.Fatalf("resolve environment: %+v, %v", ep, err)
	}
	t.Setenv(envOCRLLMModel, "haiku")
	ep, err = ResolveEndpoint(path)
	if err != nil || ep.Model != "haiku" {
		t.Fatalf("environment model not used: %+v, %v", ep, err)
	}
	ep, err = ResolveEndpointWithModelOverride(path, "custom-model[1m]")
	if err != nil || ep.Model != "custom-model[1m]" {
		t.Fatalf("model override not preserved: %+v, %v", ep, err)
	}

	// Existing config-first precedence remains unchanged for both directions.
	path, _ = writeResolverConfig(t, configFile{Llm: llmFileConfig{
		URL: "https://configured.invalid", AuthToken: "configured-fixture", Model: "configured-model", Protocol: ProtocolOpenAIResponses,
	}})
	ep, err = ResolveEndpoint(path)
	if err != nil || ep.Protocol != ProtocolOpenAIResponses || ep.Model != "configured-model" {
		t.Fatalf("saved HTTP config must precede environment: protocol=%q, model=%q, err=%v", ep.Protocol, ep.Model, err)
	}
	t.Setenv(envOCRLLMProtocol, ProtocolAnthropic)
	t.Setenv(envOCRLLMURL, "https://environment.invalid")
	t.Setenv(envOCRLLMToken, "environment-fixture")
	path, _ = writeResolverConfig(t, configFile{Provider: "claude-code"})
	ep, err = ResolveEndpoint(path)
	if err != nil || ep.Protocol != ProtocolClaudeCode || ep.Model != "default" || ep.Token != "" || ep.URL != "" {
		t.Fatalf("saved CLI config must precede HTTP environment: protocol=%q, err=%v", ep.Protocol, err)
	}
}

func TestResolveClaudeCodeRejectsHTTPConfiguration(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	for _, tc := range []struct {
		field string
		value any
	}{
		{"url", "https://sensitive.invalid"},
		{"api_key", "sensitive-fixture-key"},
		{"api_key_cmd", "sensitive-command"},
		{"auth_header", "sensitive-header"},
		{"extra_body", map[string]any{"field": "sensitive-body"}},
		{"extra_headers", map[string]string{"X-Example": "sensitive-header"}},
		{"retry_codes", []int{429}},
		{"aws_region", "sensitive-region"},
		{"aws_profile", "sensitive-profile"},
	} {
		t.Run(tc.field, func(t *testing.T) {
			path := writeConfig(t, map[string]any{
				"provider": "claude-code", "providers": map[string]any{"claude-code": map[string]any{tc.field: tc.value}},
			})
			_, err := ResolveEndpoint(path)
			if err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("expected error naming %s, got %v", tc.field, err)
			}
			if strings.Contains(err.Error(), "sensitive") {
				t.Fatal("validation error exposed a configuration value")
			}
		})
	}
}

func TestResolveClaudeCodeNeverRunsCredentialCommands(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	marker := filepath.Join(t.TempDir(), "credential-command-ran")
	command := "touch '" + marker + "'"
	for _, cfg := range []configFile{
		{Provider: "claude-code", Providers: map[string]providerEntryConfig{"claude-code": {APIKeyCmd: command}}},
		{Provider: "local", CustomProviders: map[string]providerEntryConfig{"local": {Protocol: ProtocolClaudeCode, APIKeyCmd: command}}},
		{Llm: llmFileConfig{Protocol: ProtocolClaudeCode, AuthTokenCmd: command}},
	} {
		path, _ := writeResolverConfig(t, cfg)
		if _, err := ResolveEndpoint(path); err == nil || !strings.Contains(err.Error(), "does not support") {
			t.Fatalf("expected credential-command rejection, got %v", err)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("credential command ran for the subprocess backend")
	}
}

func TestResolveClaudeCodeRejectsHTTPEnvironmentWithoutFallback(t *testing.T) {
	for _, key := range []string{envOCRLLMURL, envOCRLLMToken, envOCRLLMAuthHeader, envOCRLLMExtraHeaders} {
		t.Run(key, func(t *testing.T) {
			clearAllEnv(t)
			t.Setenv(envOCRLLMExtraHeaders, "")
			t.Setenv(envOCRLLMTimeout, "")
			t.Setenv(envOCRLLMProtocol, ProtocolClaudeCode)
			value := "sensitive-value"
			if key == envOCRLLMExtraHeaders {
				value = "X-Example=sensitive-value"
			}
			t.Setenv(key, value)
			t.Setenv(envCCBaseURL, "https://unused.invalid")
			t.Setenv(envCCToken, "fixture-token")
			t.Setenv(envCCModel, "fixture-model")
			_, err := ResolveEndpoint(filepath.Join(t.TempDir(), "missing.json"))
			if err == nil || !strings.Contains(err.Error(), "claude-code") {
				t.Fatalf("expected CLI validation error, not an HTTP fallback: %v", err)
			}
			if strings.Contains(err.Error(), "sensitive-value") {
				t.Fatal("validation error exposed an environment value")
			}
		})
	}
}

func TestResolveClaudeCodeTimeoutAndGlobalHeaders(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	path, _ := writeResolverConfig(t, configFile{Provider: "claude-code", Providers: map[string]providerEntryConfig{
		"claude-code": {TimeoutSec: 17, ClaudeCommand: "not-launched-during-resolution"},
	}})
	ep, err := ResolveEndpoint(path)
	if err != nil || ep.Timeout != 17*time.Second {
		t.Fatalf("configured timeout: %+v, %v", ep, err)
	}
	t.Setenv(envOCRLLMTimeout, "23")
	ep, err = ResolveEndpoint(path)
	if err != nil || ep.Timeout != 23*time.Second {
		t.Fatalf("global timeout override: %+v, %v", ep, err)
	}
	t.Setenv(envOCRLLMExtraHeaders, "X-Example=fixture")
	if _, err := ResolveEndpoint(path); err == nil || !strings.Contains(err.Error(), envOCRLLMExtraHeaders) {
		t.Fatalf("global HTTP headers must be rejected: %v", err)
	}
}

func TestValidateClaudeCodeConfig(t *testing.T) {
	for _, cfg := range []ClientConfig{{}, {ClaudeCommand: "claude"}, {ClaudeCommand: "/opt/Claude Code/claude", Timeout: time.Second}} {
		if err := ValidateClaudeCodeConfig(cfg); err != nil {
			t.Fatalf("valid subprocess config rejected: %v", err)
		}
	}
	for _, cfg := range []ClientConfig{
		{URL: "sensitive"}, {APIKey: "sensitive"}, {AuthHeader: "sensitive"},
		{ExtraBody: map[string]any{"field": "sensitive"}}, {ExtraHeaders: map[string]string{"field": "sensitive"}},
		{RetryCodes: []int{408}}, {AWSRegion: "sensitive"}, {AWSProfile: "sensitive"},
		{ClaudeCommand: " "}, {ClaudeCommand: "sensitive\ncommand"}, {ClaudeCommand: "sensitive\x00command"},
		{Timeout: -time.Second},
	} {
		err := ValidateClaudeCodeConfig(cfg)
		if err == nil {
			t.Fatal("invalid subprocess config was accepted")
		}
		if strings.Contains(err.Error(), "sensitive") {
			t.Fatal("validation error exposed a configuration value")
		}
	}
}

func TestResolveClaudeCommandRequiresCLIProtocol(t *testing.T) {
	clearAllEnv(t)
	t.Setenv(envOCRLLMExtraHeaders, "")
	t.Setenv(envOCRLLMTimeout, "")
	for _, cfg := range []configFile{
		{Provider: "openai", Providers: map[string]providerEntryConfig{"openai": {ClaudeCommand: "claude"}}},
		{Llm: llmFileConfig{ClaudeCommand: "claude"}},
		{Provider: "claude-code", Providers: map[string]providerEntryConfig{"claude-code": {TimeoutSec: -1}}},
		{Llm: llmFileConfig{Protocol: ProtocolClaudeCode, URL: "https://invalid-for-cli.invalid"}},
	} {
		path, _ := writeResolverConfig(t, cfg)
		if _, err := ResolveEndpoint(path); err == nil {
			t.Fatal("expected invalid CLI configuration to fail before fallback")
		}
	}
}

func TestNewLLMClientClaudeCodeDispatch(t *testing.T) {
	client := NewLLMClient(ResolvedEndpoint{
		Protocol: ProtocolClaudeCode, Model: "sonnet", ClaudeCommand: "fixture-claude", Timeout: time.Second,
	}, nil, nil)
	if _, ok := client.(*ClaudeCodeClient); !ok {
		t.Fatalf("factory returned %T, want *ClaudeCodeClient", client)
	}
}
