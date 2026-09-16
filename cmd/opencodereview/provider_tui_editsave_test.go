// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alibaba/open-code-review/internal/llm"
)

// TestApplyEditCustomProviderSave_Guards covers the two early-return guards:
// a nil config and an empty config path.
func TestApplyEditCustomProviderSave_Guards(t *testing.T) {
	t.Run("nil config", func(t *testing.T) {
		m := &providerTUIModel{}
		if err := m.applyEditCustomProviderSave(); err == nil {
			t.Fatal("expected error when config is nil")
		}
		if m.formError == "" {
			t.Error("formError should be set when config is nil")
		}
	})

	t.Run("empty config path", func(t *testing.T) {
		m := &providerTUIModel{existingCfg: &Config{}}
		if err := m.applyEditCustomProviderSave(); err == nil {
			t.Fatal("expected error when config path is empty")
		}
		if m.formError == "" {
			t.Error("formError should be set when config path is empty")
		}
	})
}

// TestApplyEditCustomProviderSave_RenameReassignsActiveProvider covers the
// name-change branch where the edited provider is also the active provider: the
// old key is deleted, and the active Provider/Model are re-pointed at the new
// name.
func TestApplyEditCustomProviderSave_RenameReassignsActiveProvider(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	cfg := &Config{
		Provider: "oldname",
		Model:    "some-model",
		CustomProviders: map[string]ProviderEntry{
			"oldname": {URL: "https://example.com/v1", Protocol: "openai"},
		},
	}
	m := newProviderTUI(cfg, configPath)
	m.activeTab = tabCustom
	m.editingCustom = true
	m.editTargetName = "oldname"
	m.cpProtocolIdx = 1 // openai
	m.cpNameInput.SetValue("newname")
	m.cpURLInput.SetValue("https://example.com/v1")

	if err := m.applyEditCustomProviderSave(); err != nil {
		t.Fatalf("applyEditCustomProviderSave: %v", err)
	}
	if _, ok := cfg.CustomProviders["oldname"]; ok {
		t.Error("old provider key should be deleted after rename")
	}
	if _, ok := cfg.CustomProviders["newname"]; !ok {
		t.Error("new provider key should exist after rename")
	}
	if cfg.Provider != "newname" {
		t.Errorf("active Provider = %q, want newname", cfg.Provider)
	}
	if cfg.Model != "" {
		t.Errorf("active Model = %q, want cleared", cfg.Model)
	}
}

// TestApplyEditCustomProviderSave_SaveFailureRestoresBackup covers the
// save-failure path where the reload also fails (config path is a directory, so
// both save and reload error) and the in-memory backup is restored.
func TestApplyEditCustomProviderSave_SaveFailureRestoresBackup(t *testing.T) {
	dir := t.TempDir()
	// A directory path makes both saveConfig and the reload fallback fail.
	blockPath := filepath.Join(dir, "blocked")
	if err := os.Mkdir(blockPath, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{
		CustomProviders: map[string]ProviderEntry{
			"aaa": {URL: "https://example.com/v1", Protocol: "openai", Models: []string{"m1"}},
		},
	}
	m := newProviderTUI(cfg, blockPath)
	m.activeTab = tabCustom
	m.editingCustom = true
	m.editTargetName = "aaa"
	m.cpProtocolIdx = 1
	m.cpNameInput.SetValue("aaa")
	m.cpURLInput.SetValue("https://changed.example.com/v1")

	if err := m.applyEditCustomProviderSave(); err == nil {
		t.Fatal("expected save error when config path is a directory")
	}
	if m.formError == "" {
		t.Error("formError should be set on save failure")
	}
	if m.savedInSession {
		t.Error("savedInSession must stay false on save failure")
	}
	// Backup restored: the URL edit should not have stuck.
	if got := cfg.CustomProviders["aaa"].URL; got != "https://example.com/v1" {
		t.Errorf("URL = %q, want original restored", got)
	}
}

func TestApplyEditCustomProviderSave_ClaudeCodeProtocolTransitions(t *testing.T) {
	protocols := append(append([]string(nil), cpProtocols...), "  CLAUDE-CODE  ")
	for _, from := range protocols {
		for _, to := range cpProtocols {
			previous := llm.NormalizeProtocol(from)
			changed := previous != to
			if changed && previous != llm.ProtocolClaudeCode && to != llm.ProtocolClaudeCode {
				continue
			}
			t.Run(from+"_to_"+to, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "config.json")
				original := ProviderEntry{
					Protocol: from, Model: "kept-model", Models: []string{"kept-model", "custom[1m]"}, TimeoutSec: 23,
				}
				if previous == llm.ProtocolClaudeCode {
					original.ClaudeCommand = "/opt/Fixture CLI/claude"
				} else {
					original.ExtraBody = map[string]any{"fixture": "body"}
					original.ExtraHeaders = map[string]string{"X-Fixture": "header"}
					original.RetryCodes = []int{400}
					if previous == llm.ProtocolAnthropicBedrock {
						original.AWSRegion = "us-west-2"
						original.AWSProfile = "fixture-profile"
					} else {
						original.URL = "https://original.invalid"
						original.AuthHeader = "x-api-key"
						original.APIKey = "fixture-original-key"
						original.APIKeyCmd = "fixture-credential-command"
					}
				}
				cfg := &Config{CustomProviders: map[string]ProviderEntry{"local": original}}
				m := newProviderTUI(cfg, path)
				m.activeTab = tabCustom
				m.customIdx = 0
				m.enterEditCustomProvider()
				m.cpProtocolIdx = cpProtocolIndex(to)

				want := cloneProviderEntry(original)
				want.Protocol = to
				if changed && !ambientProviderProtocol(to) {
					m.cpURLInput.SetValue("https://replacement.invalid")
					m.cpAuthInput.SetValue("authorization")
					m.beginAPIKeyReplace()
					m.apiKeyInput.SetValue("fixture-new-key")
					want.URL = "https://replacement.invalid"
					want.AuthHeader = "authorization"
					want.APIKey = "fixture-new-key"
				}
				if ambientProviderProtocol(to) {
					m.cpStep = cpStepProtocol
					want.URL, want.APIKey, want.AuthHeader = "", "", ""
				} else {
					m.cpStep = cpStepAuthHeader
				}
				if changed && to == llm.ProtocolClaudeCode {
					want.APIKeyCmd, want.AWSProfile, want.AWSRegion = "", "", ""
					want.ExtraBody, want.ExtraHeaders, want.RetryCodes = nil, nil, nil
				}
				if changed && previous == llm.ProtocolClaudeCode {
					want.ClaudeCommand = ""
				}

				view := stripANSI(m.View().Content)
				if changed {
					notice := "Switching to claude-code clears saved HTTP credentials/options and AWS region/profile."
					if previous == llm.ProtocolClaudeCode {
						notice = "Switching away from claude-code clears the saved claude_command executable path."
					}
					if !strings.Contains(view, notice) {
						t.Fatalf("form did not preview the transport cleanup: %s", view)
					}
				} else if strings.Contains(view, "Switching ") {
					t.Fatal("unchanged protocol displayed a cleanup notice")
				}
				for _, secret := range []string{"fixture-original-key", "fixture-new-key", "fixture-credential-command"} {
					if strings.Contains(view, secret) {
						t.Fatal("form notice exposed a credential value")
					}
				}

				updated, _ := m.Update(enterKey())
				m = updated.(providerTUIModel)
				if m.formError != "" || m.editingCustom || m.step != stepModel || !m.savedInSession {
					t.Fatalf("edit did not finish at the model picker: step=%v, error=%s", m.step, m.formError)
				}
				if got := cfg.CustomProviders["local"]; !reflect.DeepEqual(got, want) {
					t.Fatalf("saved entry = %+v, want %+v", got, want)
				}
				diskCfg, err := loadOrCreateConfig(path)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(diskCfg.CustomProviders["local"], want) {
					t.Fatal("persisted entry did not retain the expected transport settings")
				}
			})
		}
	}
}

func TestApplyEditCustomProviderSave_ClaudeCodeUnchangedRejectsUnsupportedSettings(t *testing.T) {
	for _, original := range []ProviderEntry{
		{Protocol: llm.ProtocolClaudeCode, APIKeyCmd: "fixture-command"},
		{Protocol: llm.ProtocolClaudeCode, ExtraHeaders: map[string]string{"X-Fixture": "header"}},
		{Protocol: llm.ProtocolClaudeCode, AWSProfile: "fixture-profile", AWSRegion: "us-west-2"},
		{Protocol: llm.ProtocolOpenAIChatCompletions, URL: "https://fixture.invalid", ClaudeCommand: "fixture-claude"},
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		before := cloneProviderEntry(original)
		cfg := &Config{CustomProviders: map[string]ProviderEntry{"local": original}}
		m := newProviderTUI(cfg, path)
		m.activeTab = tabCustom
		m.customIdx = 0
		m.enterEditCustomProvider()
		if err := m.applyEditCustomProviderSave(); err == nil {
			t.Fatal("unchanged protocol silently discarded unsupported settings")
		}
		if !reflect.DeepEqual(cfg.CustomProviders["local"], before) {
			t.Fatal("rejected unchanged-protocol edit modified saved settings")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("rejected unchanged-protocol edit wrote configuration")
		}
	}
}

func TestApplyEditCustomProviderSave_ClaudeCodeTransitionSaveFailure(t *testing.T) {
	original := ProviderEntry{
		Protocol: llm.ProtocolOpenAIChatCompletions, URL: "https://fixture.invalid", APIKeyCmd: "fixture-command",
		ExtraBody: map[string]any{"fixture": "body"}, ExtraHeaders: map[string]string{"X-Fixture": "header"}, RetryCodes: []int{400},
	}
	before := cloneProviderEntry(original)
	cfg := &Config{CustomProviders: map[string]ProviderEntry{"local": original}}
	// A directory rejects the save and reload, exercising the rollback path.
	m := newProviderTUI(cfg, t.TempDir())
	m.activeTab = tabCustom
	m.customIdx = 0
	m.enterEditCustomProvider()
	m.cpProtocolIdx = cpProtocolIndex(llm.ProtocolClaudeCode)
	if err := m.applyEditCustomProviderSave(); err == nil {
		t.Fatal("expected save error")
	}
	if !reflect.DeepEqual(cfg.CustomProviders["local"], before) {
		t.Fatal("failed transition lost the original transport settings")
	}
}
