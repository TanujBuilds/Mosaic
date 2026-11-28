# Mosaic Desktop for Mac

Use Mosaic Desktop to configure your coding app, see what it handed off, and follow projects. Start tasks, approve work, and request revisions in your coding app. The shared workspace reads the same coordinator as Mosaic’s Terminal Beta.

## First launch

Open the disk image on an Apple silicon Mac running macOS 26 or later. Drag **Mosaic Desktop** to Applications and open it. You can also use your personal Applications folder. To keep it in the Dock, choose **Options → Keep in Dock** from its Dock menu.

If you already configured Terminal Beta .240, open **Connections** to see your saved host and provider. Existing keys stay on your Mac. With a fresh installation, choose your coding app and save your connections. The first save downloads the verified runtime and installs the same launcher used by Terminal. This step requires an internet connection. A host-only Codex setup can leave the worker model empty.

Choose **Install in Codex** or **Install in Claude Code** to register Mosaic. Open a chat in your project and say “Use Mosaic to fix the failing test.” Choose the workflow when your app asks. Connections shows the first successful MCP call. **Test saved worker** checks the worker endpoint separately. A handoff created in that chat appears on its project board. Recent projects appear on the home screen. Pin a project for a sidebar shortcut, or browse the full project directory.

Use **Settings → Dashboard source** to open available history from the separate coding core or the earlier Mosaic Preview. Connection edits apply to the shared workspace. Older Terminal Beta versions and setup options the app cannot safely edit show their Terminal instructions in Connections.

## Building and verifying the Mac image

Run on an Apple silicon Mac with Xcode Command Line Tools and the .240 darwin-arm64 portable archive. Use a fresh output folder.

```sh
node desktop/macos/package.mjs --archive /path/to/portable.tar.gz --output /path/to/output
```

This builds a local app and disk image with an ad-hoc signature. For public distribution, add `--mode public --identity "$SIGNING_IDENTITY" --notary-profile "$NOTARY_PROFILE"` using your Developer ID Application identity and a configured Keychain profile. The packager verifies the portable archive, builds the app, notarizes and staples both the app and DMG, and verifies the mounted copy before emitting a public receipt. See the [desktop publication instructions](../../distribution/desktop/README.md) to activate the download.

## Desktop bridge

The native app loads bundled UI and forwards allowlisted JSON requests to `desktop/macos/bridge.mjs` over stdin. The bridge emits one JSON reply. Only a dedicated native action can copy text to the clipboard.

- `settings.get` returns shared setup, capabilities and service readiness. Secrets appear only as presence flags. `readOnlyReason` explains configurations requiring Terminal.
- `settings.save` applies explicit host and provider edits against the saved revision. Omit a key to retain it for its existing endpoint.
- `host.connect` registers the saved host. `worker.test` tests its worker without sending project data.
- `observer.board` and `observer.detail` read one selected viewer connection. Wire source `preview` selects the shared Terminal Beta, `installed` the original coding core, and `legacy` the earlier desktop preview. Cards and detail use the same saved goal ID.
