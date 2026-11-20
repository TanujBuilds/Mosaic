# Mosaic Beta for Apple Silicon Macs

Mosaic Beta connects your selected coding host to a local coordinator. Setup offers Codex, Claude Code, Cursor and Antigravity, one or more explicitly configured API workers, specialty routing and optional API review. Review defaults to the selected host. The initial archive targets native Apple Silicon macOS and includes its coordinator Node.js runtime and dependencies. The separate native check artifact supports protected checks without Codex. A clean Mac may prompt you to install Apple Command Line Tools when coding checks first need Git. Actual host versions and clean-account installation remain separate release gates; see [release evidence](PORTABLE_BETA_RELEASE.md).

## Install

For a local macOS Installer candidate, open the Apple Silicon `.pkg` and install for the current user. In Finder, open your Home folder, then **Mosaic Setup**, the candidate version and **Finish Installing Mosaic.command**. That step verifies the archive and activates Mosaic for your account. Follow the setup prompt or run `~/.local/bin/mosaic setup`. See [the installer build and recovery guide](PORTABLE_BETA_INSTALL.md) for the unsigned candidate and the remaining public download checks.

### Install from an archive

From the directory containing the matching archive and SHA256 file, substitute the version you received:

```sh
shasum -a 256 -c mosaic-beta-VERSION-darwin-arm64.tar.gz.sha256
(
  umask 022
  tar -xzf mosaic-beta-VERSION-darwin-arm64.tar.gz
)
cd mosaic-beta-VERSION-darwin-arm64
./install
~/.local/bin/mosaic setup
```

The subshell keeps the archive's packaged file permissions during extraction. If the installer reports a mode mismatch, extract the verified archive into an empty directory with the command above and retry.

The installer checks package integrity and offers to append a managed PATH block to `~/.zshrc` when needed. Use `./install --no-path` to skip that prompt. Open a fresh terminal after accepting a PATH change. Setup previews the selected host, profiles, review source, routing, concurrency and exact native artifact identity. Private configuration lives under `~/Library/Application Support/Mosaic Beta/config`; bearer values use a separate owned `0600` credentials file. Existing schema-1 settings remain readable until explicit preview/cancel/apply migration. Migration does not rewrite saved goal identities or approvals.

First interactive setup opens with a blue tiled Mosaic wordmark using your Terminal profile’s background. The mark compacts to a tiled M in narrower windows. Use Up/Down and Enter to choose an app, pick a worker, skip or run optional checks, and confirm the save. Esc goes back from the worker and save menus. Press q in a menu or Ctrl+C during setup to exit. Before saving, you can restart with `~/.local/bin/mosaic setup`. With `NO_COLOR`, `TERM=dumb` or redirected input/output, setup offers numbered prompts.

First setup asks for your coding app and an existing worker on this Mac, another computer, or a hosted API; you can also choose no worker yet. For a hosted worker, choose OpenAI Platform, Kimi Platform or Z.ai GLM, or supply the base URL of a custom OpenAI-compatible endpoint. Enter the exact Chat Completions model ID your account can access. The named services use their own Platform API keys and billing. Enter a key only at the hidden prompt.

| Preset | API base URL | Account to use |
| --- | --- | --- |
| OpenAI Platform | `https://api.openai.com/v1` | [OpenAI Platform API](https://developers.openai.com/api/reference/overview) |
| Kimi Platform | `https://api.moonshot.ai/v1` | [Kimi Platform API](https://www.kimi.ai/help/kimi-api/api-overview) |
| Z.ai GLM | `https://api.z.ai/api/paas/v4` | [Z.ai general API](https://docs.z.ai/api-reference/llm/chat-completion) |

For a worker on this Mac, another computer or a custom endpoint, enter its API base URL, exact model ID and any required bearer key. Internal profile/planner/capacity identifiers are generated with one task slot. On another computer, localhost still means the computer running Mosaic. The readable summary offers optional technical details. Choose Guided setup for two or three workers: enter each URL, manual model ID and optional hidden key; use numbered choices for specialties, default worker and planner. Conflicting specialties require an explicit choice. These are chosen routes, not measured model quality. Total concurrency, worker slots and shared-service slots default to one; explicitly choose up to four if appropriate. Canonical endpoint aliases share capacity automatically. Group different URLs explicitly when they reach the same physical server; extra worker names do not create slots. The summary shows each worker’s roles, routes, target, key status and shared limits. Discovery and inference consent are separate for each numbered worker. Advanced retains full technical configuration, larger pools and separate API review. Existing schema-2 settings use that advanced configuration path; cancellation preserves them.

Mosaic does not install models, discover endpoints or change model servers. Approved context goes to the worker endpoint you supplied; remote/hosted endpoints send it off the Mac. The coding app reviews by default and may use its cloud service even when the worker is local. A separately configured API reviewer uses its own authentication and billing; a closed app has no automatic wakeup or paid fallback. Setup offers independent default-no model-discovery and inference choices after validating credentials. Discovery sends GET to the supplied worker base URL plus `/models`, with configured authentication. Unsupported listing or an unlisted manual model still permits saving that explicit configuration. Inference discloses its exact fixed setup-only message, target and possible provider cost; it sends no repository data, task evidence or review request. The limit is 16 output tokens and one total 10-second deadline per worker. Some reasoning models use the short budget for internal reasoning and return no visible response. You can skip the optional inference test and save the exact model as untested. Advertised-model profiles also require a fresh membership GET before POST within that same deadline, including when standalone discovery was declined. Skipping both checks or choosing no worker sends zero provider requests. Failed inference leaves saved settings unchanged. Success establishes that fixed transport request; coding quality, context capacity and the actual app connection remain unverified.

After setup, Mosaic shows the connection steps for the selected coding app. Run `mosaic connect` to see them again, or `mosaic connect --host codex|claude-code|cursor|antigravity` to see the steps for another app. Register through the app’s controls and preserve any existing entry with the same name. The connection guide leaves your app settings untouched. Disposable-home tests use a private fixture registration adapter. Only unchanged installer-owned bindings can be removed; manual and unrelated host entries are preserved. Historical schema-1 Codex setup remains a separate compatibility path. See [host compatibility](HOST_COMPATIBILITY.md) and [installation and recovery](PORTABLE_BETA_INSTALL.md).

## Run

Reopen or refresh the selected host after reviewing its manual registration.
First inspect the actual app/profile's discovered **mosaic-beta** tools and call
**registry_list** with `{}` through that connection. This bounded connection-only
call reads the Mosaic registry without preparing a goal or dispatching a worker. The coding app may use its own model if you ask it to make the call in chat. Preserve any error
and resolve registration, discovery or the call before continuing. The terminal
viewer's `tools_list`, fixture registration and worker probes do not prove that
the coding app discovered or called Mosaic. Once the connection works, start a
chat in the intended repository and use this prompt:

> Use Mosaic Beta in this repository. Inspect the mosaic-beta registry, ask me to choose a workflow if needed, then prepare an exact goal and show me its scope and limits for approval before activation.

The four available workflow policies are collaborative, API-worker-only (`deepseek_only` in the MCP protocol), host-only (`codex_only`) and overnight review. Confirm the approved manifest, Git base, literal file/check scope, provider pool, routing and budgets in the host. Host review waits durably when the app closes; an inactive chat is not guaranteed to wake. Use `mosaic` to observe activity in another terminal. Press ↑ or ↓ to select an assignment, Enter to see bounded saved evidence, g to choose a goal, and q or Ctrl-C to close the observer. Press **a** from any screen to jump to the current project. It prefers running work, then the most recently worked project, and says when nothing is running or native activity is unconfirmed. The result is labeled as the last check; press a again to refresh the selection. This shortcut only changes your view. Approvals stay in the host.

Use **[** for older handoffs and **]** for newer handoffs. In goal selection and details, these keys page up and down. Page Up/Down (Fn + ↑/↓ on a Mac keyboard) still work.

If the existing Mosaic coding core is installed in its standard user location, the terminal also discovers its read-only viewer connection. A chat using `frontier-harness` writes to that existing service; a chat using `mosaic-beta` writes to the separate beta service. The terminal labels the service it is watching, follows work when the current service is empty or another service becomes active, and retains the selected service when both have active work. Use `mosaic --source core` or `mosaic --source beta` to choose explicitly. No goals, approvals or settings are migrated between services. Older core versions load saved handoffs in bounded pages; the terminal shows a loading message while catching up. If the watched service disconnects, its last saved view stays visible as stale.

```sh
mosaic status --once
mosaic doctor
mosaic doctor --providers
mosaic connect
mosaic setup
mosaic off
mosaic on
mosaic uninstall
```

Plain doctor checks saved configuration and local capabilities without contacting schema-2 workers. `doctor --providers` explicitly adds bounded GET-only model discovery, with separate endpoint/listing evidence and inference, coding and host limitations. Authentication, transport or protocol failures fail that diagnostic; unsupported listing for a manual model remains usable. Legacy schema-1 doctor preserves its existing read-only discovery. Neither doctor path sends a completion. The status command also works when redirected to a file. `off` stops new dispatch while retaining recoverable state and execution ownership; `on` resumes the service's admission policy. Uninstall removes only owned, unchanged beta bindings and retains versions, private settings and evidence. Existing core, manual or modified registrations are preserved. Resolve active or prepared beta work in its host before maintenance. If a prepared worker-bound revision blocks maintenance, stop its goal and finalize it as partial to retire the revision. Native uncertainty cannot be cleared merely by timeout, process exit or switching a version pointer. Setup can resume an approved interrupted change. Relocation or a different native artifact needs a new exact approval; saved literal check paths are never rewritten silently.

To revisit setup, run `mosaic setup`. Existing schema-2 settings enter an
explicit advanced replacement: re-enter all profiles you intend to retain and
inspect the exact catalog, review, routes and limits before confirming. The
existing execution backend, native artifact identity and Codex executable stay
as configured by default. For each profile, `k` at the key question explicitly
retains a saved key for the same identifier, canonical URL and API protocol;
`y` requires a nonempty hidden replacement and `n` makes that profile keyless.
Rotating a shared credential reference affects every profile using it; unused
keys are retained. A different endpoint requires a new key or keyless choice.
A full private `mosaic setup --config /absolute/path/to/settings.json` remains
available for an explicit schema-2 replacement. Keys belong in the separate
credential store. Cancellation, EOF and Ctrl-C before approval preserve saved
bytes and return nonzero. Rerun `mosaic setup` to resume an already approved
interrupted change. Concurrent edits and retained approval/owner conflicts stay
preserved; follow the reported resolution instead of clearing state.

Setup and doctor report saved instructions separately from actual registration,
discovery and successful calls. `UNVERIFIED` host stages are neutral; doctor
keeps its existing local-check exit behavior and supplies one `Next action`.
Real portable setup cannot observe app discovery or calls, so those stages
remain unverified in doctor even after you check them in the app. They do not
imply a transport failure. See the [connection steps and safe reconfiguration
instructions](PORTABLE_BETA_INSTALL.md#verify-the-selected-coding-app-connection).

For isolated local verification, use `./install --home /absolute/disposable/directory --no-path`, run the installed `mosaic setup`, then start the isolated coordinator with `mosaic serve`. Select a non-Codex host to exercise the native check path with Codex absent. This mode uses a private fixture registration and dummy loopback credentials. It does not certify an actual host app, account, login startup or clean-machine installation.

## Validation scope

November 12, 2026: both generation-3 extracted-package lifecycles passed on product source `9f251552`, with recorded test-only fixture corrections. Host-SDK and optional API review each accepted two routed CSV changes using actual native checks, Chromium download, Git integration, restart and maintenance. The inference/review replies were scripted on loopback; the sample project's inventoried browser dependencies were separate from Mosaic's runtime. [Release evidence](PORTABLE_BETA_RELEASE.md) records the exact scope and archive hashes. The final candidate's checksummed handoff supplies its final source/full-suite disposition. Real host/account versions, live two-provider operation, clean-machine setup, signing/notarization, public license/source audit and publication remain NOT RUN for this candidate unless a distinct dated receipt records them.

On November 9, 2026, the Apple Silicon package `0.1.0-beta.102` (`fb368a1`) completed a live overnight coding task in an isolated home on the development Mac. The existing Spark service handled one planning request and one coding request. The protected check passed, Codex accepted the candidate in one independent review, and the coordinator integrated the change and finalized the goal. The fixture processes shut down after the run.

The full test suite passed 690 tests at `4372a38`. The beta and harness observer suites passed 26 tests at `f931136`, including the 20-column renderer change made after the live-tested build.

Setup and LaunchAgent registration on a separate clean macOS account or VM and a live hosted-provider coding task remain unverified.
