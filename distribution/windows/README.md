# Windows candidate packaging

The experimental Windows package targets Windows 11 x64 with native PowerShell. Build it in an x64 Visual Studio Developer PowerShell session on Windows using a clean commit, Node and Git. The builder compiles the launcher and protected-check supervisor and installs the locked production dependencies. It also compiles the Windows filesystem helper when that source is present.

~~~powershell
node scripts/package-windows-beta.mjs --version 0.1.0-beta.229 --output C:\MosaicStage\candidate
~~~

The output directory receives the ZIP, its SHA-256 sidecar, the exact bootstrap script and a candidate record with source, package and runtime hashes. Use a new version and output directory for changed bytes. Use the pinned official Node download or supply a local copy with the same checksum using the builder's Node archive option.

Stage the ZIP and bootstrap together at HTTPS URLs that serve the exact bytes without credentials. Generate the candidate's paste command from the staged file names and candidate metadata. The generator checks the local ZIP and bootstrap against that record.

~~~powershell
node scripts/package-windows-beta.mjs --candidate $CandidateFile --bootstrap-uri $BootstrapUri --archive-uri $ArchiveUri
~~~

The generated command checks the bootstrap SHA-256 before running it. The bootstrap resumes an interrupted ZIP download, checks the pinned SHA-256, validates the complete inventory and commits the selected version for the current account. It leaves existing Windows execution policy unchanged. Rerun the same command to resume. A failed upgrade can retain its previous version and the pending install receipt.

The stable launcher and active version are under the user's Local Application Data.

~~~text
Mosaic Beta/
  bin/mosaic.exe
  config/installation.json
  current-version.txt
  install-intent.json                 # while a version switch is pending
  versions/VERSION/package-manifest.json
  versions/VERSION/runtime/bin/node.exe
  versions/VERSION/runtime/check-artifact/
~~~

The installer adds the launcher to the current process PATH. In later terminals, use the stable launcher by its full path. Onboarding guides users through Git installation, authenticates the local coordinator, connects the selected app and prepares the first task. Git installation and vendor sign-in stay with the user. A candidate operator can pass a verified local ZIP, its hash, its version and the noninteractive option to the same bootstrap for artifact testing.

Before linking Windows downloads from the public README, verify the exact anonymous staging command on clean Windows 11 x64. Record interruption and recovery, both supported PowerShell versions claimed by the release, the actual signed-in coding-host journey and the reviewed integrated commit. Verify the Mac installer independently.
