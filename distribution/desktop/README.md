# Publish Mosaic Desktop 0.1.2

Use an Apple silicon Mac running macOS 26 or later. The release owner needs the project’s Developer ID Application identity, its independently known Apple Team ID and a configured `notarytool` Keychain profile. Keep the identity’s private key and profile credentials in Keychain. Use a reviewed source checkout and the portable archive pinned in the packager.

1. Build the public disk image in a new output directory. The packager signs, notarizes and staples the app and the final disk image. A local build can exercise the app but cannot activate the public installer.

   ```sh
   node desktop/macos/package.mjs --mode public \
     --archive "$PORTABLE_ARCHIVE" --output "$RELEASE_DIR" \
     --identity "$DEVELOPER_ID_APPLICATION" --notary-profile "$NOTARY_PROFILE"
   ```

2. Generate the installer and README promotion patch from the released bytes. Supply the expected Apple Team ID from the publisher’s account. The tool checks the receipt, runs the Mac verifier against the disk image and mounted app and writes the patch to stdout.

   ```sh
   node distribution/desktop/promote.mjs \
     --dmg "$RELEASE_DIR/Mosaic-Desktop-arm64.dmg" \
     --receipt "$RELEASE_DIR/Mosaic-Desktop-release.json" \
     --team-id "$APPLE_TEAM_ID" > "$RELEASE_DIR/desktop-release.patch"
   git apply --check "$RELEASE_DIR/desktop-release.patch"
   ```

3. Test the DMG on a clean supported Mac through Finder with ordinary Gatekeeper settings. Stage the exact `Mosaic-Desktop-arm64.dmg` and `Mosaic-Desktop-release.json` in a draft GitHub release tagged `v0.1.2-desktop` at the reviewed build revision. Review the draft and publish it with immutable release assets. This is the release owner’s publication step.
4. Download the asset anonymously into a new temporary directory and recheck those public bytes against the reviewed local receipt. The verifier checks the byte count, SHA-256, signatures and tickets.

   ```sh
   PUBLIC_CHECK_DIR=$(mktemp -d)
   curl -q --fail --location --proto '=https' --proto-redir '=https' \
     --output "$PUBLIC_CHECK_DIR/Mosaic-Desktop-arm64.dmg" \
     'https://github.com/TanujBuilds/Mosaic/releases/download/v0.1.2-desktop/Mosaic-Desktop-arm64.dmg'
   node desktop/macos/package.mjs \
     --verify-dmg "$PUBLIC_CHECK_DIR/Mosaic-Desktop-arm64.dmg" \
     --receipt "$RELEASE_DIR/Mosaic-Desktop-release.json" --team-id "$APPLE_TEAM_ID"
   ```
5. Apply the prepared patch only once the public asset is accessible and verified. Review the diff, run the installer regressions, and publish the source change to `main`. That change activates both the README download and the one-line installer’s desktop choice. Test the public one-liner in a real terminal on a clean Mac and complete each setup path in a separate account.

   ```sh
   git apply "$RELEASE_DIR/desktop-release.patch"
   node --test test/release-bootstrap.test.mjs
   ```

The desktop choice verifies and caches the pinned disk image, requests a Gatekeeper assessment and opens it in Finder. Finder handles copying the app to Applications or the user’s personal Applications folder. A rerun opens a verified current or newer installed app. The Terminal choice keeps the existing Beta setup and recovery workflow.
