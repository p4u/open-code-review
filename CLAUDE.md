# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Build and test commands

Run these from the repository root. The Go module requires Go **1.25.5+**; Git **2.41+** and Make are also required. The Make workflow uses Bash/Unix utilities, and the race-enabled test target needs CGO and a working C compiler. Node.js is not required for the Go CLI.

| Command | Purpose |
| --- | --- |
| `make build` | Build `./dist/opencodereview` from `./cmd/opencodereview`, including version metadata. The installed CLI is named `ocr`. |
| `make check` | Check license headers and English-only source, run `go mod tidy`, format Go files in place, and run vet. **Modifies files; does not run tests or build.** |
| `make test` | Run Go tests with `LC_ALL=C`, race detection, verbose output, and test caching disabled. |
| `make coverage` | Write `coverage.out` and enforce the 90% coverage gate. This target does not enable the race detector. |
| `make license-add` | Add missing source license headers. |
| `go tool cover -func=coverage.out` | Inspect an existing coverage report. |

Use the existing `PACKAGES` override to narrow tests; there is no `TEST_ARGS` or `TEST_FLAGS` variable:

```bash
# All tests in one package
make test PACKAGES='./internal/diff'

# Exactly one test
make test PACKAGES='./internal/diff -run=^TestParseDiffText_Rename$$'

# Multiple packages
make test PACKAGES='./internal/diff ./internal/tool'
```

Keep the single quotes and doubled `$$` in the single-test example: Make converts `$$` to the literal `$` regex anchor. `PACKAGES` is also used by vet and coverage. Its default is evaluated with `go list`, so even a Make dry run can fetch uncached dependencies.

Go tests use temporary Git repositories and fake/local LLM servers rather than requiring real API credentials. They still need subprocess execution, writable temporary directories, and local TCP listeners.

To exercise the local binary after building:

```bash
./dist/opencodereview --help
./dist/opencodereview review --preview   # File selection only; no LLM runtime
./dist/opencodereview delegate preview   # Prepare work for a host coding agent

# Configure an LLM before an actual OCR-managed review
./dist/opencodereview config provider
./dist/opencodereview config model
./dist/opencodereview review
```

Prefer explicit subcommands on the built binary over `make run`; that target currently passes `--staged` to the root command. `make help` builds the binary and shows CLI help, not Make target help.

## Architecture

### Execution flow

- **CLI composition root:** `cmd/opencodereview/` uses Cobra. Command handlers wire configuration, mode-aware file readers, LLM clients, tools, sessions, and output. `shared.go` separates local input/config preparation (`loadCommonContext`) from LLM construction (`loadLLMRuntime`), so preview and delegation can operate without credentials or creating review sessions.
- **Diff review:** `internal/diff/` supplies changes; `internal/agent/` owns deterministic selection, rule resolution, grouping, concurrency, and review rounds. Related files are reviewed as isolated group subtasks, not necessarily one request per file. The pipeline selects files, seals review coverage, applies resume reuse, groups pending work, then runs optional planning and tool-use review rounds with comment filtering. All provider-returned diffs remain available as context even when not selected for review.
- **Shared conversation engine:** `internal/llmloop.Runner` drives LLM/tool exchanges, context compression, usage accounting, and comment collection for both review and scan. `task_done` and `code_comment` are special control paths in this loop; comments go through location validation/relocation rather than merely executing a registered tool. Shared conversation behavior belongs here; scheduling belongs in the respective agent.
- **Full-file scanning:** `internal/scan/` has its own agent and scan template. It enumerates whole files, including outside Git repositories, and runs sequential batches with concurrent file subtasks, batch deduplication, and a project summary. It shares the conversation engine and comment machinery, but does not advertise `file_read_diff` or initialize review's MCP clients.
- **Delegation:** `internal/delegate/` and `delegate_cmd.go` expose file selection and resolved rules for another coding agent to perform the review. They do not construct an OCR LLM runtime; the host owns the model and context budget.
- **Persistence and output:** `internal/session/` records conversations and checkpoints incrementally in `~/.opencodereview/sessions/<encoded-repository-path>/<uuid>.jsonl`. Command-level rendering consumes the shared `ResultProvider` interface to emit text, JSON, or SARIF. Progress uses `internal/stdout.Writer` separately from result output so machine-readable results remain clean.

### Important boundaries when changing behavior

- **Git input semantics:** branch review uses `merge-base(from,to)..to`; commit review compares against the first parent; workspace review includes staged, unstaged, and untracked changes. File read/find/search tools must read the reviewed ref in committed modes, not whatever happens to be on disk. Review anchors paths at the Git root, whereas scan preserves its requested subtree. `internal/gitcmd/` bounds Git subprocess concurrency separately from agent concurrency.
- **Tools:** model-visible definitions live in `internal/config/toolsconfig/`; executable implementations satisfy `internal/tool.Provider` and are registered by the command. A new built-in tool may require changes to both surfaces and the built-in name list. `internal/mcp/` adapts external tools to the same provider interface. Finish registration and diff-map injection before `Registry.Freeze`, which is the boundary for concurrent use.
- **LLM adapters:** `internal/llm.LLMClient` presents shared request/response types over OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Bedrock, and the `claude-code` subprocess transport. Provider presets and wire protocols are distinct: a compatible provider generally needs a preset/config change, not another protocol implementation. Preserve `Message.Native` payloads opaquely in the matching API adapter; display text cannot replace signed thinking or encrypted reasoning. The Claude CLI adapter instead sends fresh OCR conversation snapshots with CLI tools disabled and translates structured actions back into OCR tool calls; it must not resume hidden CLI history after OCR rewrites its context.
- **Provider-specific review rules:** `.opencodereview/rule.json` requires registry changes to update the provider tables in `en`, `zh`, `ja`, and `ru` configuration docs, and new providers to have `TestLookupProvider_<Name>Details` coverage in `internal/llm/providers_test.go`.
- **Configuration and prompts:** user settings live at `~/.opencodereview/config.json`; workflow prompts/manifests are embedded under `internal/config/template/`, tool definitions are separate, and review rules live under `internal/config/rules/`. Review and scan use different template types. Do not assume environment variables override saved app configuration: consult `internal/llm/resolver.go`. Persisted settings have separate write-side structs in `config_cmd.go` and read-side structs in the resolver; new fields must survive both paths.
- **Rule and selection precedence:** rule text is first-match across custom `--rule`, project, global, then embedded rules; merging system rules is opt-in. Include/exclude filters instead come from the highest-priority layer that defines filters, not a merge of every layer. Include patterns override ordinary filtering rather than exclusively restricting scope; binary and built-in secret-path exclusions still win. Preview and review share selection logic, and deleted files are context only.
- **Coverage and resume:** review coverage is a persisted execution manifest, separate from Go test coverage. Seal the selected denominator before dispatch and publish the same frozen outcome snapshot to CLI JSON and `session_end`. Resume validates input/config identity and reuses completed work into a **new** session; it does not reopen an old conversation, and workspace review cannot resume. Validate admission before constructing the agent, since construction starts persistence. Join background compression/comment work before finalization.

## Website, viewer, and integrations

These are separate surfaces with separate build/test workflows; `make check` and `make test` do not validate their JavaScript/TypeScript code.

- **Session viewer:** `internal/viewer/` embeds its own HTML, CSS, and JavaScript into the Go binary and reads saved session JSONL. It is **not** built from `pages/`. Fixed/ignored comment marks are browser-local state, not mutations to persisted sessions.
- **Public website and docs:** `pages/` is a React/TypeScript/Webpack/Tailwind app. From that directory, run `npm install`, then `npm run dev` (port 3030). Validate with `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, then `npm run size`; output is `pages/dist/`. Use the supported Node versions in `pages/README.md` (Pages CI uses Node 24). That README also requires before/after screenshots for affected views in Pages PRs. Preserve `pages/go.mod`: it is a module boundary keeping Go files inside frontend dependencies out of root Go tooling, not another Go application.
- **VS Code extension:** `extensions/vscode/` is a Preact WebView plus a thin extension host that invokes `ocr`. Shared `postMessage` types connect the two sides. From that directory, use `yarn install --frozen-lockfile`, `yarn watch`, and F5 in VS Code for development; CI runs `yarn lint`, `yarn compile`, and `yarn test`. See its README for WebView/host reload behavior.
- **npm distribution and agent plugins:** root `bin/ocr.js` launches a platform-specific Go binary; it is not the review implementation. Root checks are `npm run test:github-actions`, `npm run test:launcher`, and `npm run test:update`, not a generic `npm test`. These use Node built-ins and do not need root `npm install` (whose postinstall downloads a binary). Coding-agent integrations live under `plugins/open-code-review/`; the OpenCode adapter has its own `npm run check` in `opencode/`.

User-facing CLI, rules, configuration, and integration documentation lives in `pages/src/content/docs/en/` with localized counterparts. See `README.md` for usage and `CONTRIBUTING.md` for contribution details; contributor policies remain in the imported `AGENTS.md` rather than being duplicated here.
