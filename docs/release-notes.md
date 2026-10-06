# Sail development build

These installers are development builds. macOS artifacts use ad-hoc signing unless a Developer ID certificate and notarization secrets were configured for the workflow. Windows and Linux artifacts are unsigned. Check `release-manifest.json` for the signing mode, source commit, target, and SHA-256 of each package before installing. The tag workflow also records GitHub artifact attestations for the packages.

OpenCode v2.0.24 is a separate prerequisite; it is not bundled. Install the tested plan-review plugin revision before starting an Architect plan. See [installation and first project](https://github.com/smykla-skalski/sail/blob/main/docs/install.md) and [validation limits](https://github.com/smykla-skalski/sail/blob/main/docs/validation.md).

There is no automatic updater. To update, download the next package for your platform and install it over the previous version after quitting the app. Verify the new manifest and run the first-project checks again.
