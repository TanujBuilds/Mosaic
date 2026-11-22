# Portable beta installation and recovery

This is a local Darwin arm64 candidate. An archive checksum detects changed
bytes; it is not a signature or an authenticated download channel. See the
candidate's `unpassedGates` and the separate release matrix before distribution.

The ordinary coordinator uses the pinned official Node 24.22.3 distribution at
`payload/runtime/bin/node`. Native protected checks use a separate artifact at
`payload/runtime/check-artifact/`, containing exactly `node` (0755),
`mosaic-check-supervisor` (0755), `NODE-LICENSE` (0644), and
`artifact-manifest.json` (0600). The artifact directory is 0700. The complete Node
license includes upstream third-party notices. The archive also carries the supplemental runtime notices in `payload/runtime/notices/`. Use the patched Node artifact for protected checks. Stock Node fails the native spawn preflight.

## Build a local candidate

First build the check artifact using [the native build guide](NATIVE_CHECK_ARTIFACT.md).
Use a canonical, owned output directory outside checkout/credential directories;
check artifacts must not execute from `.data`, `.codex`, or another denied root.
The builder compiles only the candidate's reviewed C supervisor. Release packaging
rejects check-runtime bytes containing the current owner's home or private
`.data`/`.codex` build paths. Use a neutral build root and reverify a rebuilt
binary; never edit bytes inside an accepted artifact to remove paths. Rehash the
explicit input binary, complete license, reviewed patch and source provenance.

With the official coordinator Node and license already obtained and verified:

```sh
node scripts/package-beta.mjs --version 0.1.0-beta.204 \
  --output "$CANDIDATE_OUTPUT" \
  --node "$OFFICIAL_NODE/bin/node" --node-license "$OFFICIAL_NODE/LICENSE" \
  --check-artifact "$CHECK_ARTIFACT" --offline
```

Omitting `--node` downloads only the immutable pinned official distribution and
checks its archive/binary/license hashes. Dependency installation uses the exact
lockfile with scripts and binary links disabled. `--offline` requires these
explicit Node inputs and npm's already populated immutable cache. Installation
itself performs no downloads. A build host needs Node, npm, Git, the native
Apple toolchain for the separately built artifact, and the actual Darwin native
sandbox. Runtime packages contain their npm dependencies and require no global
module cache. `--fixture` is developer-only and is marked in both manifests;
it permits a fixture coordinator binary/license and is not a real release.

The package builder performs a real native kernel/spawn preflight from a fresh
owned canonical temporary directory. It writes private durable probe ownership
and quiescence receipts. If cleanup is uncertain, the build fails and preserves
that directory for inspection; elapsed time cannot authorize deleting the owner.

An archive, `.tar.gz.sha256`, and adjacent `.candidate.json` are emitted. The
candidate manifest follows `scripts/lib/beta-candidate.schema.json`; it records
source HEAD/tree and dirty status, source closure hash, inventory and archive
hashes, dependency/runtime versions, build input hashes, optional
`--verification-ref` repository-relative evidence hash, and unpassed gates.
`package-manifest.json` independently inventories exact payload bytes, sizes and
modes, including the C source, reviewed patch, builder, provenance guide,
adapter modules, recipe definitions and schemas. Archive/inventory/candidate
hashes have no self-reference. Source HEAD/tree describes committed input;
`source.dirty` and `closureHash` disclose uncommitted packaged source.

Archives normalize file order, uid/gid, timestamps, ustar headers, gzip header
and extended metadata. Two builds with identical source, dependencies, pinned
binaries, modes, version and build-tool bytes must produce identical archives
and candidate manifests. This proves deterministic packaging of pinned binaries;
it does not prove that compiling upstream Node on a different toolchain produces
identical binary bytes. Final verification references and source commit must be
regenerated for the final frozen source candidate.

## macOS Installer package

The local Apple Silicon `.pkg` uses macOS Installer to stage an existing
archive in your home folder. To build the package, supply the exact archive,
its version and the SHA-256 from its trusted candidate record:

```sh
node scripts/package-macos-installer.mjs --version "$VERSION" \
  --archive "$ARCHIVE" --sha256 "$TRUSTED_SHA256" --output "$PACKAGE_OUTPUT"
```

To try an approved local candidate, open the `.pkg` in Finder and complete the
Installer screens. In Finder, choose **Go → Home** and open **Mosaic Setup**.
Open the folder for the version you installed, then double-click **Finish
Installing Mosaic**. Terminal verifies the archive and runs the same per-user
installation as the standalone archive.

On a first installation, answer **y** at **Open Mosaic setup now?** to start
setup. You can also run `"$HOME/.local/bin/mosaic" setup` later. After setup,
run `"$HOME/.local/bin/mosaic" connect` to reopen the instructions for your
selected coding app. See [coding app compatibility](HOST_COMPATIBILITY.md).

To update, open the new `.pkg` and run **Finish Installing Mosaic** from its
version folder.
Mosaic keeps the same configuration and retained versions; the existing rollback
and recovery commands apply. After activation finishes, the **Mosaic Setup**
version folder is only needed if you want to run that staged installer again.

The builder creates an unsigned local candidate. Gatekeeper qualification of a
public download requires a separately signed, notarized and stapled package,
followed by a browser download and Finder install on a clean Apple Silicon Mac
or VM. Record the downloaded package hash, macOS build, user permissions,
activation, setup across login, and update and rollback results. See
[release gates](PORTABLE_BETA_RELEASE.md) and [Apple's packaging
guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

## Install outside the checkout

Verify the published checksum by a separately trusted channel when one exists,
then follow the [manual extraction steps](TERMINAL_BETA.md#install) to preserve
the packaged file permissions. Extract under a directory you own. Spaces in the
path are supported. After extraction, run:

```sh
./mosaic-beta-0.1.0-beta.160-darwin-arm64/install --no-path
"$HOME/.local/bin/mosaic" setup
```

The bootstrap verifies pinned payload checksums before starting its bundled
ordinary Node. Installation rechecks the complete inventory and file modes and
places immutable versions under `~/Library/Application Support/Mosaic Beta/versions`.
A new launcher uses its installed runtime and the caller's PATH; it does not add
hidden global host executable directories. Prior exact installer-owned launchers
are accepted using their original receipt and historical template.

First setup explains the coordinator, coding app and worker, then asks you to
choose Codex, Claude Code, Cursor or Antigravity. Choose an existing model on
this Mac, another computer, a hosted API, or no worker yet. For one worker,
enter its API base URL and model ID from the server's configuration, then an
optional hidden bearer key. Mosaic generates the internal identifiers and
uses one concurrent task slot. On another computer, localhost means the Mac
running Mosaic. Use HTTPS for remote worker or API-reviewer URLs, including
private-network endpoints. An encrypted forward terminating at a loopback
listener on the Mac can use a loopback HTTP URL.

Review defaults to the selected app. Approved task context goes to the supplied
worker endpoint; remote/hosted workers send it off the Mac, and app review may
use a cloud service even with a local worker. The summary shows the exact
endpoint/model and capacity; technical settings are optional. Choose Guided setup for two or three workers to give each its own URL, manual
model ID and optional hidden key. Numbered choices select general, backend,
frontend, tests, docs or design routes, plus the default and planner workers.
Resolve conflicting specialties explicitly; these are your routing choices,
not measured model quality. Mosaic generates neutral internal worker IDs.

Total concurrency stays one unless you explicitly choose up to four tasks.
Worker limits and shared-service limits also default to one. Canonical URL
aliases share capacity automatically; use the numbered shared-service choice
when different URLs reach the same physical server. The summary shows worker
roles, routes, targets, key status, and shared limits. Extra profiles do not
create inference slots. Guided setup asks discovery and inference consent
separately for each numbered worker. Advanced setup retains the full technical
configuration, larger pools and separate API review.
Existing schema-2 settings use the advanced path and are replaced only after
the exact preview and confirmation. Model discovery and inference each require
a separate default-no opt-in after private credential validation. Discovery sends
GET to each supplied worker base URL plus `/models`; configured authentication
goes to that endpoint. An unsupported list or unlisted manual model can still be
saved explicitly. Inference may incur provider cost and sends only the displayed
fixed message, with at most 16 output tokens and one total 10-second deadline per
worker. Advertised-model profiles require a fresh membership GET before the POST
within that same deadline, even when standalone discovery was declined. A failed
inference test aborts before saving. These transient checks do not establish
coding quality, context capacity or an actual app connection. Review-only APIs
remain untested; no-worker setup sends zero provider requests. Setup does not install a model,
scan the network, change server settings, or require Tailscale. Follow the
interactive preview for migration; cancel leaves existing settings intact.
Secrets are held separately in owned 0600 credential storage. The existing core
Mosaic installation, its state and unrelated host entries remain independent.

`mosaic doctor` leaves schema-2 worker endpoints untouched. `mosaic doctor --providers`
explicitly checks their model lists with GET only; it never sends inference.
Authentication, transport and protocol failures fail that diagnostic; unsupported
listing for a manually configured model is reported without claiming a coding
failure. Legacy schema-1 doctor retains its existing discovery behavior.

## Revisit configuration safely

Run `mosaic setup` again to review an explicit advanced replacement of existing
schema-2 profiles, models, review, routing and limits. Re-enter every profile you
intend to keep; this flow replaces the catalog after confirmation. It retains the
exact existing execution backend, native artifact path/fingerprint and configured
Codex executable by default. Use a separately reviewed private
`mosaic setup --config /absolute/path/to/settings.json` for a full explicit
schema-2 replacement, including any deliberate execution change. Keep keys in
the private credential store, never in that settings file.

For each advanced profile, enter the same identifier and API base URL to keep
its identity. At the bearer-key question, `k` explicitly keeps its saved key for
that same profile, canonical URL and API protocol. Choose `y` to enter a new
hidden key. Enter a value to replace it. A reference shared by profiles at the
same canonical URL and API protocol can rotate together. A different URL
or API protocol gets a distinct credential reference when a saved alias
shares the old reference. Choose `n` to make the new profile
keyless; unused private keys are retained. New advanced profiles receive an unused
credential reference so they cannot replace another saved key. Changing the endpoint requires a new
key or an explicit keyless choice. Inspect the exact replacement before saving;
model discovery and inference remain separate default-no choices.

Before switching versions, the installer checks saved worker and reviewer URLs
against the target's transport policy. If the target requires HTTPS for remote
URLs, the installer leaves the current version, settings and service in place.
Use the current version to update remote HTTP profiles to HTTPS or to a loopback
URL backed by an operator-managed encrypted forward, then retry the upgrade.
End or resolve work bound to the previous provider identity before changing its
URL. Existing approval hashes and credentials are preserved.

Declining the final confirmation, EOF or Ctrl-C before approval preserves the
last saved settings, credentials and host entries. The CLI returns a nonzero
status for cancellation/interruption. If an approved change was interrupted,
run `mosaic setup` to resume its exact intent without recollecting profiles or
repeating provider checks. A concurrent settings/key change or a customized
managed fixture binding is preserved and reported as a conflict; inspect the
retained setup rather than deleting its intent or credentials. Resolve prepared,
active or retained owners in their host before conflicting maintenance. For a
stopped approval, resume and finish it or finalize it as partial first. Keep the
exact runtime directories and literal check paths referenced by saved work.

## Verify the selected coding app connection

Setup and doctor distinguish configuration selected/saved, registration
instructions generated/saved, registration saved, tools discovered and a
successful tool call. Real portable setup records manual instructions and does
not inspect or change the real host registration. A disposable fixture can
verify its own saved entry; that says nothing about an actual app. `UNVERIFIED`
host discovery/call rows are neutral information: doctor retains its local
check/boolean and CLI exit behavior. Follow its single `Next action` after
resolving any reported local issue. Doctor cannot certify host events it has
not observed or import a successful app call as durable proof.

1. Run `mosaic host-preview --host codex` (or `claude-code`, `cursor`,
   `antigravity`). Review the exact launcher/argv or snippet, preserve unrelated
   entries and any existing core Mosaic registration, then apply it manually
   using the selected app's supported configuration mechanism.
2. Load or refresh that MCP connection in the actual coding app. Inspect that
   app's discovered **mosaic-beta** tools. A terminal viewer's `tools_list`, a
   fixture adapter or a successful worker probe does not establish this step.
3. In that same app/profile, call **registry_list** with `{}` through
   **mosaic-beta**. Confirm the bounded registry response before preparing any
   goal. This connection-only call performs no model inference or task dispatch.

If registration, discovery or the call fails, retain its error and fix that step
before preparing work. A selected host, saved snippet or successful registry
call does not establish sign-in, coding quality, model capacity, live provider
qualification or clean-Mac readiness. Closed or inactive hosts still wait
durably for pull-based review; there is no automatic wakeup or fallback.

## Update, rollback and interrupted maintenance

Run a newer verified archive's installer with the same home to update. Before
switching versions, the installer checks maintenance guards for prepared, active,
unresolved or owned work. It verifies incoming state compatibility against the
private settings schema and SQLite `user_version`. Read-only maintenance checks
briefly wait for a busy state database. Incompatible settings/database versions
or incompatible retained native-supervisor source block the switch.

Private configuration and saved approvals retain the exact original native
artifact path and fingerprint. A code pointer switch does not rewrite checks,
goal hashes or runtime approvals. Older immutable version directories, settings,
credentials and job/evidence state remain available.

For a release carrying Node 24.22.3, fresh setup selects the bundled check runtime. Updating an existing 24.22.0 installation keeps its original check artifact and approval hashes. When resuming a saved goal, refresh native preflight against the exact saved approval in your coding app before dispatching checks. Retain the older version directory while its artifact is configured. Rollback checks compatibility with the configured artifact before changing the launcher. The tested retention path covers a stopped goal without queued worker assignments. An already queued worker task can be blocked if it reaches dispatch before its proof is refreshed.

Moving an installation or
selecting a different runtime/backend requires explicit fresh approval; stopped
or uncertain work may still pin an old artifact. Resolve that work before a
conflicting migration. Do not delete old versions manually while approvals or
execution owners refer to them.

After any interrupted installation, update, or recovery attempt, rerun the
installer from the same verified target archive. It handles the pending
transaction before attempting another version switch. This also works when the
installed launcher still belongs to the previous version or when a first
installation has yet to create a launcher.

A private `config/install-transaction.json` records the prior and target
pointers, receipts and durable phases. Recovery before commit restores the
prior compatible pointer and restarts its registered coordinator. After
commit, recovery verifies and retains the new pointer. If a busy database
blocks recovery, wait for it to become available and retry the same installer.
If active work blocks shutdown, resolve it in the coding app before retrying.

Recovery preserves modified pointers, modified receipts and private state for
inspection. Use `mosaic rollback VERSION` to select a compatible retained
version. Incompatible live schemas block rollback.

`mosaic uninstall` removes only unchanged owned host/launcher/PATH bindings.
It preserves custom/unrelated entries, private settings, credentials, installed
versions and retained evidence. Disable/off must stop new dispatch and retain
recoverable owners; it does not discard a running or uncertain native owner.

## Verification boundary

Package and maintenance tests use disposable homes and local processes, including
actual native enforcement, bytes/modes, relocation and interruption probes.
Scripted loopback provider/host tests establish installed composition, not live
account compatibility or model quality. A clean macOS account/VM, real host
versions and accounts, live providers with explicit limits, other platforms,
signing/notarization, authenticated distribution, public-source/license audit
and publication remain separate gates until individually evidenced.
