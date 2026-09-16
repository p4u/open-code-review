// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"fmt"
	"strings"
)

// Canonical protocol identifiers understood by the LLM client factory and
// resolver. These are the only values produced by NormalizeProtocol for known
// protocols; downstream code (NewLLMClient switch, resolver branches) compares
// against these constants exclusively.
//
// Naming convention: <vendor>-<flavor>. New built-in protocols should add a
// constant here, extend ValidateProtocol's whitelist, and add a case to
// NewLLMClient.
const (
	// ProtocolAnthropic is the Anthropic Messages API spoken directly to
	// api.anthropic.com (or a compatible gateway).
	ProtocolAnthropic = "anthropic"
	// ProtocolOpenAIChatCompletions is the OpenAI Chat Completions API
	// (/v1/chat/completions). The value "openai" is kept for full backward
	// compatibility with existing config files.
	ProtocolOpenAIChatCompletions = "openai"
	// ProtocolOpenAIResponses is the OpenAI Responses API (/v1/responses),
	// used by GPT-5.x / o-series models.
	ProtocolOpenAIResponses = "openai-responses"
	// ProtocolAnthropicBedrock is the Anthropic Messages API served by AWS
	// Bedrock. The request body is the same as ProtocolAnthropic — the
	// difference is transport: requests are SigV4-signed from the ambient AWS
	// credential chain rather than carrying an API key, the model moves from
	// the body into the URL path, and the region determines the host. The
	// official SDK's bedrock middleware performs that rewriting, so this
	// shares the Anthropic client rather than reimplementing the protocol.
	ProtocolAnthropicBedrock = "anthropic-bedrock"
	// ProtocolClaudeCode runs the Claude Code CLI as a subprocess. The CLI owns
	// authentication and model defaults; OCR does not configure an HTTP endpoint.
	ProtocolClaudeCode = "claude-code"
)

// NormalizeProtocol canonicalizes protocol names. It is case-insensitive and
// trims whitespace. Empty string is returned as-is (the caller decides the
// default). Known protocol names are mapped to their canonical constants;
// unknown values are lowercased and trimmed so that ValidateProtocol can
// surface a precise error message rather than silently swallowing a typo.
func NormalizeProtocol(raw string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "":
		return ""
	case ProtocolAnthropic:
		return ProtocolAnthropic
	case ProtocolOpenAIChatCompletions:
		return ProtocolOpenAIChatCompletions
	case ProtocolOpenAIResponses:
		return ProtocolOpenAIResponses
	case ProtocolAnthropicBedrock:
		return ProtocolAnthropicBedrock
	case ProtocolClaudeCode:
		return ProtocolClaudeCode
	default:
		return normalized
	}
}

// ValidateProtocol accepts the canonical protocol names and rejects everything else.
func ValidateProtocol(p string) error {
	switch p {
	case ProtocolAnthropic, ProtocolOpenAIChatCompletions, ProtocolOpenAIResponses, ProtocolAnthropicBedrock, ProtocolClaudeCode:
		return nil
	default:
		return fmt.Errorf("unsupported protocol %q; supported protocols are %q, %q, %q, %q, %q", p, ProtocolAnthropic, ProtocolOpenAIChatCompletions, ProtocolOpenAIResponses, ProtocolAnthropicBedrock, ProtocolClaudeCode)
	}
}

// ValidateClaudeCodeConfig rejects settings the subprocess transport cannot
// honor. Errors name fields, never their values: an HTTP credential must not
// leak while explaining that authentication belongs to the Claude CLI.
func ValidateClaudeCodeConfig(cfg ClientConfig) error {
	var unsupported []string
	for _, field := range []struct {
		name string
		set  bool
	}{
		{"url", cfg.URL != ""},
		{"api_key/auth_token", cfg.APIKey != ""},
		{"auth_header", cfg.AuthHeader != ""},
		{"extra_body", len(cfg.ExtraBody) > 0},
		{"extra_headers", len(cfg.ExtraHeaders) > 0},
		{"retry_codes", len(cfg.RetryCodes) > 0},
		{"aws_profile", cfg.AWSProfile != ""},
		{"aws_region", cfg.AWSRegion != ""},
	} {
		if field.set {
			unsupported = append(unsupported, field.name)
		}
	}
	if len(unsupported) > 0 {
		return fmt.Errorf("claude-code does not support %s; configure authentication and transport in the Claude CLI instead", strings.Join(unsupported, ", "))
	}
	if cfg.ClaudeCommand != "" && (strings.TrimSpace(cfg.ClaudeCommand) == "" || strings.ContainsAny(cfg.ClaudeCommand, "\x00\r\n")) {
		return fmt.Errorf("claude_command must be an executable name or path, not a shell command or a value containing control characters")
	}
	if cfg.Timeout < 0 {
		return fmt.Errorf("claude-code timeout must be non-negative")
	}
	return nil
}
