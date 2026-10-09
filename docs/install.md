# Install Sail

## Requirements

Sail is a desktop front end for coding agents. To use OpenCode, install **OpenCode v2.0.24** separately; the app detects common executable locations and lets you select a binary in **Settings → OpenCode**. Open Settings with **⌘,** or the gear at the bottom of the project sidebar. Sail runs OpenCode as `opencode acp`; it does not start an OpenCode server. Keep the same OpenCode profile when reopening the app so sessions remain available. The supported revision is listed in [validation.md](validation.md).

Install the tested CLI with npm and check its version:

```sh
npm install --global @opencode/cli@2.0.24
opencode --version
```

On Windows, use the native `opencode.exe` from the installed npm package if the app does not detect the npm shim. In OpenCode settings, choose that executable. If no executable is found, Settings shows why OpenCode is unavailable.

## Choose a package

Download the matching development package from the [GitHub release](https://github.com/smykla-skalski/sail/releases), together with `SHA256SUMS` and `release-manifest.json`. Compare its SHA-256 against the manifest before installation. A release tag also has a GitHub build attestation for each package.

| System                             | Package              | Install                                                           |
| ---------------------------------- | -------------------- | ----------------------------------------------------------------- |
| macOS Apple Silicon                | `macos-arm64.dmg`    | Open DMG; drag Sail to Applications.                              |
| macOS Intel                        | `macos-x64.dmg`      | Open DMG; drag Sail to Applications.                              |
| Ubuntu/Debian x64                  | `linux-x64.deb`      | `sudo apt install ./Sail-*.deb`                                   |
| Other supported Linux x64 desktops | `linux-x64.AppImage` | `chmod +x Sail-*.AppImage` then run it.                           |
| Windows x64                        | `windows-x64.exe`    | Run the NSIS installer. WebView2 may need an internet connection. |

The macOS development DMGs use ad-hoc signing when no Developer ID credentials were supplied, so macOS may require an explicit **Open Anyway** choice in Privacy & Security. The Windows development installer is unsigned and may show a SmartScreen warning. Only install artifacts whose checksum and source revision you trust. Linux AppImage compatibility starts from an Ubuntu 22.04 build baseline; it still needs a graphical desktop and WebKitGTK support.

## First project

1. Open the app. Sail detects an installed OpenCode automatically. If detection fails, select its absolute executable path in **OpenCode settings** and save it.
2. Select an existing Git repository.
3. In OpenCode, run `/connect` to connect a provider and `/models` to select a model.
4. Start an agent thread, or **New plan** for an OpenCode thread in plan mode. Review permissions, questions, plan revisions, execution, history, and diffs in the app.

Use the sidebar to create named project groups and save repositories. The **+** button beside a repository creates a worktree and a branch from the repository's default branch, then opens it. Sail stores these checkouts under `~/sail/worktrees/<repository>/<name>` by default. Choose another parent folder in the creation form if needed.

## Troubleshooting and updates

- **OpenCode not found:** Run `opencode --version` in a terminal; select the native executable in OpenCode settings. GUI apps may not inherit your shell's `PATH`.
- **Provider missing:** Connect a provider and enable a model in OpenCode. The desktop app does not store provider credentials.
- **Agent stopped:** Sail restarts `opencode acp` on the next message; existing sessions are stored by OpenCode.
- **Windows installer fails:** Ensure WebView2 is installed or allow the installer to download its bootstrapper.
- **Linux app does not open:** Install your distribution's WebKitGTK 4.1 runtime and check its desktop session; AppImage may also require FUSE 2.
- **Update:** Quit Sail, verify the next release's hashes and source revision, install the new package, and reopen your project. No automatic update or migration of OpenCode versions is performed.

Before publishing a release, complete the [release checklist](validation.md#release-checklist).
