# Sail development build

These installers are development builds. macOS artifacts use ad-hoc signing unless a Developer ID certificate and notarization secrets were configured for the workflow. Windows and Linux artifacts are unsigned. Check `release-manifest.json` for the signing mode, source commit, target, and SHA-256 of each package before installing. The tag workflow also records GitHub artifact attestations for the packages.

OpenCode v2.0.24 is a separate prerequisite; it is not bundled. Install the tested plan-review plugin revision before starting an Architect plan. See [installation and first project](https://github.com/smykla-skalski/sail/blob/main/docs/install.md) and [validation limits](https://github.com/smykla-skalski/sail/blob/main/docs/validation.md).

There is no automatic updater. To update, download the next package for your platform and install it over the previous version after quitting the app. Verify the new manifest and run the first-project checks again.

## Ship status

- Ship shows "Fixing · round N" while a worker repairs NEEDS_FIXES or FAIL findings, and "Fixing (CI)" while it repairs failing checks. Only a blocked worker report or a BLOCKED verdict shows "Needs input", with the checkpoint blocker as the reason.
- A pull request with no required checks can reach "Ready to merge". A pull request closed without merging shows "Closed without merge". An issue closed before its worker launched shows "Closed" instead of failed.
- Dependent issues show "Waiting on #N", or "Waiting on #N (needs input)" when that dependency has failed.
- Settings has a new "Who merges Ship PRs" choice. "You" is the default: workers stop at a mergeable pull request and report `awaiting_merge`. "Agent, per repository release policy" leaves merging to the worker. Repository instructions that say who merges take precedence.
- Stored `blockedReason` text from earlier fix rounds is ignored while a NEEDS_FIXES or FAIL verdict is current.
