# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OpenClaw** is a theoretically infinite memory gateway for AI agents with support for 25+ messaging channels (Telegram, Discord, Slack, Signal, iMessage, WhatsApp, and many more) plus native macOS and iOS apps.

- **Repo**: https://github.com/openclaw/openclaw
- **Type**: TypeScript monorepo (CLI + multiple platform apps)
- **Runtime**: Node 22+ (Bun also supported for local dev)
- **Package Manager**: pnpm (with Bun patching in sync)

## Quick Start Commands

- **Install**: `pnpm install`
- **Dev CLI**: `pnpm dev` or `pnpm openclaw ...`
- **Build**: `pnpm build`
- **Type-check**: `pnpm tsgo`
- **Lint/format**: `pnpm check` (combines lint, format check, typecheck)
- **Format fix**: `pnpm format:fix`
- **Tests**: `pnpm test` (use `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test` for low-memory hosts)
- **Tests with coverage**: `pnpm test:coverage` (V8, 70% threshold)
- **Single test**: `pnpm test -- file.test.ts`

## Project Structure

```
openclaw/
├── src/               # Core CLI/gateway logic (TypeScript)
│   ├── cli/          # Command entry points
│   ├── commands/     # Command implementations
│   ├── agents/       # Agent runtime (Pi embedded, CLI runner)
│   ├── channels/     # Built-in messaging channels (Telegram, Discord, Slack, Signal, iMessage, Web/WhatsApp)
│   ├── routing/      # Channel routing logic
│   ├── provider-web.ts  # Web provider
│   ├── infra/        # Infrastructure, security policies
│   └── media/        # Media processing pipeline
├── extensions/       # Plugin channels (e.g., msteams, matrix, voice-call, zalo)
│   ├── */package.json       # Plugin-only deps here (not root)
│   └── */openclaw.plugin.json  # Plugin metadata
├── apps/             # Native apps
│   ├── macos/        # SwiftUI macOS app + launcher agent
│   ├── ios/          # SwiftUI iOS app
│   └── android/      # Android app
├── docs/             # Mintlify documentation (docs.openclaw.ai)
│   ├── channels/     # Per-channel configuration docs
│   ├── cli/          # CLI command docs
│   └── .i18n/        # Internationalization (zh-CN)
├── test/             # Test fixtures and utilities
├── ui/               # Web UI (browser-based dashboard)
├── skills/           # Agent skills / custom tools
└── dist/             # Build output (generated)
```

### Key Architectural Patterns

- **Colocated tests**: `*.test.ts` files live next to source (not in separate test directories)
- **Plugin system**: Extensions in `extensions/*` must use `workspace:*` in devDependencies only (not dependencies). Runtime resolves via jiti alias to `openclaw/plugin-sdk`.
- **Channels**: All built-in channels (Telegram, Discord, etc.) are in `src/` with their own subdirectories. Extensions provide additional channels.
- **Agent runtime**: Pi-compatible embedded agent runner with sandboxing, tool allowlisting, and LLM model integration.
- **Docs hosting**: Mintlify-hosted at docs.openclaw.ai; internal links are root-relative without `.md` extension.

## Development Guidelines

### Code Style

- **Language**: TypeScript (ESM, strict typing, no `any`)
- **Linting/formatting**: Oxlint + Oxfmt (run `pnpm check` before commits)
- **File size**: Aim for ~500 LOC; extract helpers instead of creating "V2" copies
- **Comments**: Brief notes for non-obvious logic only
- **Naming**: "OpenClaw" for product/docs; `openclaw` for CLI command, packages, paths, config keys

### Testing Requirements

- **Framework**: Vitest (with V8 coverage, 70% threshold)
- **Coverage**: Run `pnpm test:coverage` before pushing when you touch logic
- **Memory**: If local Vitest runs cause memory issues, use `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`
- **Live tests**: Real API keys → `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider tests)
- **Mobile preference**: Before using simulators, check for connected real devices (iOS + Android) and prefer them

### No Prototype Mutation

- Never use `applyPrototypeMixins`, `Object.defineProperty` on `.prototype`, or export `Class.prototype` for merges
- Use explicit inheritance/composition instead (`A extends B extends C`)
- In tests, prefer per-instance stubs over prototype-level patching unless documented

### Plugin Dependencies

- Core deps → `package.json` at repo root
- Plugin-only deps → extension's `package.json` (e.g., `extensions/discord/package.json`)
- Never put `workspace:*` in plugin dependencies (breaks npm install); use `devDependencies` or `peerDependencies`
- Runtime resolves `openclaw/plugin-sdk` via jiti alias

## Building & Platforms

### CLI & Gateway

```bash
pnpm build               # Full build (includes plugin SDK, hooks, canvas, CLI entry)
pnpm tsgo              # TypeScript type-checking
pnpm check:loc         # Check max lines of code (default ~500)
```

### macOS App

```bash
pnpm mac:package       # Build app (defaults to current architecture)
pnpm mac:open          # Open app
pnpm mac:restart       # Restart gateway via launcher agent
./scripts/clawlog.sh   # Query unified logs for OpenClaw subsystem
```

See `docs/platforms/mac/release.md` for full release checklist.

### iOS/Android

```bash
pnpm ios:gen           # Generate Xcode project (runs signing config)
pnpm ios:run           # Build and run on simulator
pnpm android:run       # Build and install on device/emulator
```

## Commit & PR Workflow

- **Commit**: Use `scripts/committer "<msg>" <file...>` to avoid manual `git add`/`git commit`
- **Message style**: Concise, action-oriented (e.g., `CLI: add verbose flag to send`)
- **Template**: `.github/pull_request_template.md`
- **Strategy**: Group related changes; avoid bundling unrelated refactors
- **Changelog**: User-facing changes only (not internal/meta notes); pure test fixes typically don't need entries

### PR Maintainer Workflow (Optional)

If using the full maintainer workflow (triage order, rebase rules, commit conventions, co-contributor policy), see `.agents/skills/PR_WORKFLOW.md`. Otherwise, default PR process is fine.

## Release Channels & Versions

- **stable**: Tagged releases only (e.g., `vYYYY.M.D`), npm `latest` dist-tag
- **beta**: Prerelease tags `vYYYY.M.D-beta.N`, npm `beta` dist-tag
- **dev**: Moving head on `main` (no tag; `git checkout main`)

**Version locations** (bump all for releases):
- `package.json` (CLI)
- `apps/android/app/build.gradle.kts` (versionName/versionCode)
- `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist`
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md` (pinned npm version)
- `docs/platforms/mac/release.md` (examples)
- Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION)

## Security & Configuration

- **Web provider creds**: `~/.openclaw/credentials/` (re-run `openclaw login` if logged out)
- **Pi sessions**: `~/.openclaw/sessions/` (not configurable)
- **Config/env**: See `~/.profile`
- **Never commit**: Real phone numbers, videos, live config values, API keys
- **Placeholders**: Use obviously fake values in docs/tests/examples

Before reviewing security advisories, read `SECURITY.md`.

## Documentation (Mintlify)

- **Hosted at**: https://docs.openclaw.ai
- **Source**: `docs/**/*.md` (Mintlify format)
- **Links**: Root-relative, no `.md` extension (e.g., `[Config](/configuration)`)
- **Anchors**: Use hyphens, avoid em dashes/apostrophes in headings (breaks Mintlify links)
- **I18n**: `docs/zh-CN/**` is generated; edit English docs + glossary (`docs/.i18n/glossary.zh-CN.json`) instead
- **Generic content**: No personal hostnames/paths; use placeholders like `user@gateway-host`

## Important Agent Notes

- **Smart dependency install**: If deps are missing after clone, run `pnpm install` again, then retry your exact command once
- **Pre-commit hooks**: `prek install` (runs same checks as CI)
- **SwiftUI state**: Prefer `@Observable` / `Observation` framework over `ObservableObject`/`@StateObject`
- **Gateway on macOS**: Runs only as menubar app (no separate LaunchAgent); start/stop via OpenClaw app or `scripts/restart-mac.sh`
- **Device checks**: Verify connected real iOS/Android devices before reaching for simulators/emulators
- **Token budget**: Work efficiently; context auto-compresses as you approach limits
- **Multi-agent safety**:
  - Do **not** create/apply/drop `git stash` unless explicitly requested
  - Do **not** create/remove/modify `git worktree` unless explicitly requested
  - Do **not** switch branches unless explicitly requested
  - When committing, scope to your changes only
- **Formatting churn**: Auto-resolve formatting-only diffs if already requested; only ask for semantic changes
- **Bug investigations**: Read npm dependency source + all related local code before concluding
- **Tool schemas**: Avoid `Type.Union`, `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` for string lists, `Type.Optional(...)` for optional fields. Keep top-level as `type: "object"` with `properties`.
- **CLI progress**: Use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts`); don't hand-roll spinners
- **Status output**: Use `src/terminal/table.ts` for tables + ANSI-safe wrapping; `--all` = read-only, `--deep` = probes

## When to Use GitHub Search

Before proposing new work or duplicating fixes, use targeted searches:

```bash
# PRs and issues
gh search prs --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"
gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "auto-update"

# Structured output
gh search issues --repo openclaw/openclaw --match title,body --limit 50 --json number,title,state,url,updatedAt -- "auto update"
```

## Special Operations

### Manual Message Send (with shell syntax)

For `openclaw message send` messages containing `!`, use heredoc to avoid Bash tool escaping:

```bash
openclaw message send --channel ... --message "$(cat <<'EOF'
message with ! here
EOF
)"
```

### GitHub Comment Best Practices

- **Multiline strings**: Use literal multiline or `-F - <<'EOF'` (never embed `\n` strings)
- **Backticks in comments**: Use `gh issue/pr comment -F - <<'EOF'` (not `-b "..."`) to avoid escaping
- **Auto-linking refs**: Use plain `#24643` (not backticks) for auto-linking

### exe.dev VM Operations

```bash
ssh exe.dev
ssh vm-name              # SSH key already configured
openclaw config set gateway.mode=local
```

Restart gateway:
```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`

## When You're Stuck

- Run `openclaw doctor` for common rebrand/migration/legacy config issues
- Check `docs/testing.md` for full test coverage info
- Read `SECURITY.md` before security advisory triage
- See `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` for release questions
- Always verify in code before answering questions—don't guess

## Additional Resources

- **Vision**: [`VISION.md`](VISION.md)
- **Contributing**: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Status**: [`PR_STATUS.md`](PR_STATUS.md)
- **Changelog**: [`CHANGELOG.md`](CHANGELOG.md)
- **Security**: [`SECURITY.md`](SECURITY.md)
- **Full maintainer workflow** (optional): `.agents/skills/PR_WORKFLOW.md`

---

**Last updated**: 2026-02-25

For questions, refer to the comprehensive `AGENTS.md` which contains additional context for specialized tasks (security, release operations, platform-specific dev, etc.).
