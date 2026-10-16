# Bundled workflow skills

`ship-it`, `adversarial-review` and `adversarial-test` are complete copies based on [smykla-skalski/sai at 5af55d8](https://github.com/smykla-skalski/sai/tree/5af55d8fd9c03d9fa1ccaa58bfa64f34ad0f04c0/plugins). `sai-pin.json` records the immutable commit, plugin versions, source paths and SHA-256 of every copied file. The two telemetry files listed in `upstreamOverrides` are unmodified copies from the specific later upstream commit recorded for each file; the remaining bundle stays at the base revision. sai publishes plugin versions without Git tags or GitHub releases, so the commit identifies the exact release contents.

Git attributes preserve the pinned bytes across checkouts, including Windows CRLF settings. Both `npm run build` and the native Cargo build reject missing, added or changed source files. Generated `.pyc` files inside `__pycache__` are ignored. Run `npm run check:skills` for a focused offline check. The root `plugin.json` is unchanged upstream ship-it metadata required by the telemetry helper; it is also bundled as an offline reference. The upstream file-delivery inventory omits this dependency, so Sail host instructions specify its materialized location. Do not format or edit these three directories or the metadata. Sail-specific tool schemas and behavior belong in the Sail host instructions (`sail/SKILL.md`); the upstream entry loads its optional `references/sail.md` only when Sail tools are connected. Installed native skills retain precedence over these fallback copies.

To update the pin:

1. Download the desired immutable sai commit and verify its plugin versions.
2. Replace each entire skill directory from the corresponding source path in the manifest, preserving bytes and all files.
3. Regenerate the manifest's revision, versions and complete SHA-256 file inventory from that downloaded source.
4. Update the reference inventories in `src/lib/bundled-skill-catalog.ts` and `src-tauri/src/browser_agent.rs` to include every reference and helper.
5. Run `npm run check:skills`, the bundled-skill tests and the repository quality checks. Inspect the host contract against the upstream optional Sail reference before shipping.

For a focused upstream fix, copy only its complete affected files byte for byte from an immutable sai commit, record each source revision and path in `upstreamOverrides`, and refresh only those file hashes. Keep the base revision and versions unchanged; remove an override when a later complete bundle update includes it. The same inventory and hash checks apply to every overridden file.
