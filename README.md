# Mosaic

Mosaic coordinates bounded coding work between your coding app and an existing model API. You describe the outcome, review the scope, checks and limits, and keep one record of the plan, implementation, review and corrections.

## Install Mosaic on an Apple Silicon Mac

<!-- mosaic-desktop-release -->

On an Apple Silicon Mac running macOS 26 or later, paste this line into Terminal from any folder. It installs the [Mosaic Beta .228 release](https://github.com/TanujBuilds/Mosaic/releases/tag/v0.1.0-beta.228) for your Mac account and guides you to your first coding task.

```sh
curl -fsSL https://raw.githubusercontent.com/TanujBuilds/Mosaic/main/install.sh | /bin/sh
```

1. **Install.** Mosaic verifies the download and brings its own Node runtime. If Git needs Apple’s Command Line Tools, the guide offers to open the macOS installer and waits while you finish.
2. **Connect.** Choose your coding app and, if you want it to delegate work, a local model server or hosted provider. Setup collects provider keys privately. Follow the guide in your chosen app to confirm it can call Mosaic.
3. **Start in your project chat.** Open your Git project in the connected coding app and say “Use Mosaic to fix the failing test.” Your app opens a workflow picker or asks you to choose in chat. In Codex, you can skip the picker by saying “Use Mosaic with Codex only to fix the failing test.” Review the proposed changes, checks and limits, then approve the work in the same conversation. The Terminal guide can also prepare a first task from a local project or public GitHub URL.

The project-chat workflow uses a local MCP connection to the coding app on your Mac. For a project you usually discuss in ChatGPT, open its local folder in Codex or Claude Code and connect Mosaic there. Ordinary ChatGPT conversations do not load this local bridge.

To pick up after an interruption, run the same install command again. [Read the installer](install.sh) · [Release downloads](https://github.com/TanujBuilds/Mosaic/releases/tag/v0.1.0-beta.228)

## Try the source

Use Git and Node.js **24.22.0**. Confirm that `node --version` reports `v24.22.0`. The demo and the focused test use Node.js built-ins and can run before dependency installation.

```sh
git clone https://github.com/TanujBuilds/Mosaic.git
cd Mosaic
node --version
node src/demo.mjs "Describe a simple note-taking workflow"
node --test test/coordinator.test.mjs
```

The demo prints **FAKE MODEL DEMO**, automatically approves a scripted plan, and simulates an answer, review and revision with zero provider calls. The `accepted` result applies to that simulated handoff. The demo writes one Git-ignored JSONL event log under `.data/jobs/` and prints its path. The focused test exercises coordinator behavior in memory.

## Choose a setup path

- **Develop from source.** Install the locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund`, then use `npm test` for the portable source profile. The development guide covers prerequisites, CLI help and the Mac test profile. [Development setup](docs/DEVELOPMENT.md)
- **Use the coding core already installed in Codex.** Open a chat in your project and ask Codex to list Mosaic’s registered modes using `frontier-harness`. Confirm the tool call succeeds, then describe your coding task and review its scope, checks and limits before approving a start. [Mosaic in Codex](docs/MOSAIC_CODING_CORE.md) · [Assignment handoff](docs/MOSAIC_ASSIGNMENT_HANDOFF.md)
- **Install Mosaic Beta.** The [one-command install](#install-mosaic-on-an-apple-silicon-mac) includes the Apple Silicon runtime and dependencies and opens setup. [Terminal Beta](docs/TERMINAL_BETA.md) · [Installation and recovery](docs/PORTABLE_BETA_INSTALL.md)

## The coding workflow

Start with one worker: an already-running OpenAI-compatible API on your Mac, another computer, or a hosted service. Mosaic connects to that service; it does not install models or manage their servers.

1. Choose a coding app and workflow. The portable setup offers Codex, Claude Code, Cursor and Antigravity as host choices, with review through the selected app by default. Actual app connection remains a separate verification step.
2. Prepare an exact goal: repository revision, readable and writable paths, protected check commands, worker, review source, deadline and call limits. Review the concrete scope before activation.
3. The worker implements bounded assignments in an isolated candidate. The coordinator controls permitted edits, execution and capacity.
4. Protected checks run before review. The reviewer examines the checked diff and evidence, accepts it or requests focused corrections within the remaining limits.
5. Review acceptance and integration are separate steps. The result records what passed, what changed, and what remains blocked or unverified.

Workflows retain different roles: collaborative work allows Codex and API-worker implementation; DeepSeek-only excludes Codex implementation, review and fallback; Codex-only makes no DeepSeek calls; overnight review uses API-worker implementation with bounded review after passing checks. The historical `deepseek` actor/mode names remain protocol identifiers for the configured API worker. See [mode and lifecycle details](docs/MOSAIC_CODING_CORE.md).

You can optionally configure two or three workers with specialties, a default worker and a planner. Routes are explicit choices, not measured coding ability. Profiles that reach the same physical service must share capacity; adding profiles does not create inference slots. Two machines serving one distributed model API count as **one endpoint**. Guided setup defaults total, worker and shared-service concurrency to one; higher limits require an explicit choice.

The installed coding core and Mosaic Beta each keep their own settings, goals and approvals. Research remains parked in the coding core. For the original text-only handoff and historical observations, see the [first milestone](docs/MVP.md). For staged worktree coding with DeepSeek implementation and Codex review after protected checks, see the [legacy overnight workflow](docs/OVERNIGHT.md).

For package development, read [installation and recovery](docs/PORTABLE_BETA_INSTALL.md), [native check artifact requirements](docs/NATIVE_CHECK_ARTIFACT.md), and [release evidence](docs/PORTABLE_BETA_RELEASE.md). The [archive download prototype](distribution/README.md) requires an explicit URL and independently trusted digest. The [read-only candidate verifier](docs/PORTABLE_RELEASE_EVIDENCE.md) checks supplied bytes and bindings; it cannot authenticate a publisher or establish live readiness. Those guides also document the earlier local candidates and their verification limits.

## What is established?

The latest accepted checkpoint documented here is [the November 17 owner-workflow foundation](CHANGELOG.md#source-checkpoint--november-17-2026-owner-workflow-foundation), source `202338e0a143fef4150d1cca3ccdb49661778890`. It adds bounded provider recovery, manual-model retry eligibility without discovery requests, strict UTF-8 request intake, current-state backup consistency fixtures and preservation of primary SQLite errors when rollback cleanup fails. Its required Mac suite passed **2,555/2,555 tests**; separate portable source CI passed **2,156/2,156**. Acceptance covers source, owned native/browser fixtures and disposable installed-package composition.

Local archives `0.1.0-beta.192` and `.193` passed staging and byte/mode verification and supplied the fresh pair for the required installed-package fixtures. The [earlier November 17 checkpoint](CHANGELOG.md#source-checkpoint--november-17-2026), source `ddd922c`, retains the separate beta188/189 wrapper install → installed support → update → installed support proof. The [November 16 checkpoint](CHANGELOG.md#source-checkpoint--november-16-2026) and beta184/185 also retain their original scope. These labels identify **local artifacts, not public releases**. The dated records concern their named revisions; later source commits require their own qualification.

Read the contracts for [redacted support bundles](docs/SUPPORT_BUNDLE.md), [reviewed candidate staging](docs/REVIEWED_CANDIDATE_STAGING.md), [package verification limits](docs/PACKAGE_VERIFICATION_LIMITS.md) and [terminal qualification](docs/TERMINAL_QUALIFICATION.md). Notice inclusion preserves the dated audit and its unresolved legal/provenance questions; it does not establish distribution clearance or publisher authenticity.

Selecting an app, listing models, or passing a small inference probe does not establish an actual host connection, coding quality or usable context capacity. Actual host discovery/calls (M003), useful ordinary owner projects (M079), three independently addressable qualified workers (M063), clean-Mac use and authenticated distribution remain separate gates. M063 remains unproven. The protected native network/Postgres proof (M001) remains blocked: the accepted boundary denies TCP/Unix access and the required Postgres demonstration is absent.

Review through an app is pull-based. An inactive or disconnected app leaves a durable review wait; Mosaic does not promise to wake its chat or silently switch to an API reviewer. Explicit API review can run automatically in collaborative or overnight mode when the approved policy permits it and the reviewer is available. Legacy detached overnight review has its own configured reviewer.

## Context and authority

Approved task context goes to the configured worker endpoint. A worker on another computer or a hosted API receives that context off the Mac. Review in a coding app can use a cloud service even when the worker is local; an explicitly selected API reviewer has separate credentials and usage. Keep task logs, private settings, keys and raw evidence out of public issues and commits.

The coordinator owns exact approvals, plan versions, paths, checks, budgets and execution ownership. Reading these docs, choosing a mode or receiving model text grants no execution permission, spending allowance or mode transition. Interrupted or uncertain work retains its holds until recovery establishes ownership and quiescence.

## Explore and contribute

Start with [contributing](CONTRIBUTING.md), [development setup](docs/DEVELOPMENT.md), and [test selection](docs/TESTING.md). Read the [architecture and code map](docs/ARCHITECTURE.md), [current product context](docs/PRODUCT_CONTEXT.md), [six-stage roadmap](docs/ROADMAP.md), and [milestone history](docs/MVP.md). Dependency and native attribution records are in [third-party notices](THIRD_PARTY_NOTICES.md) and [distribution provenance](docs/DISTRIBUTION_PROVENANCE.md); unresolved distribution questions remain explicit. For a bug, provide the commit/package version, platform, expected and actual behavior, and a small redacted reproduction through [GitHub issues](https://github.com/TanujBuilds/Mosaic/issues). Pull requests should identify scope and exact checks, and distinguish fixtures from real host/model evidence. Security reporting has an unresolved private-channel gap; read [SECURITY.md](SECURITY.md) before sharing vulnerability details.

Mosaic is licensed under [MIT](LICENSE). Internal `frontier-*` package and protocol names are retained for compatibility.
