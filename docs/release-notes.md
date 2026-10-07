# Sail development build

These installers are development builds. macOS artifacts use ad-hoc signing unless a Developer ID certificate and notarization secrets were configured for the workflow. Windows and Linux artifacts are unsigned. Check `release-manifest.json` for the signing mode, source commit, target, and SHA-256 of each package before installing. The tag workflow also records GitHub artifact attestations for the packages.

OpenCode v2.0.24 is a separate prerequisite; it is not bundled. Install the tested plan-review plugin revision before starting an Architect plan. See [installation and first project](https://github.com/smykla-skalski/sail/blob/main/docs/install.md) and [validation limits](https://github.com/smykla-skalski/sail/blob/main/docs/validation.md).

There is no automatic updater. To update, download the next package for your platform and install it over the previous version after quitting the app. Verify the new manifest and run the first-project checks again.

## Changes in this build

- The top bar keeps the project and thread path, **Inbox**, **New agent ▾**, **Changes**, and a **⋯** menu. Task overview, thread switching, commands, **Run project**, agent terminals, agent browser access, and thread actions are in **⋯**, so the top bar no longer overlaps or clips at 1280 px with panes open.
- **Delete thread…** asks before removing a thread from Sail, and cancelling keeps it. Delete confirmations use a red button.
- Text, input borders, and buttons meet WCAG 2.2 AA contrast in the light and dark themes. Buttons keep the right colors when the theme changes while Sail is in the background.
- The selected thread in the sidebar shows an accent bar and a bold title.
- **Ship runs** shows the repository name; hover it for the full path.
- A new thread shows **Connecting** until its agent session starts, and an OpenCode thread without a model shows **Model setup needed** instead of **Needs input**, so the thread header and the status bar agree on whether an agent is running.
