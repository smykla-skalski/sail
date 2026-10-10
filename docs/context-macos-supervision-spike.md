# macOS local-provider supervision spike

## Decision

GO for #497 only under the user's explicit waiver of the genuine user-denied registration trial. That path was not tested and remains unknown. A signed private-app fixture passed successful registration, cross-instance reuse, project separation, containment, crash recovery, cancellation, and cleanup on one macOS host. The fixture socket has no caller authentication or peer pairing, and its cancellation result does not authorize production cancellation semantics. Linux, Windows, remote providers, and credentials remain untested.

This is issue #497's bounded research result. It does not change production Sail code or close #301. A future implementation must add project-bound caller authorization and approval UI before another app or agent can call a provider. If a non-waived mandatory trial is unavailable, inconclusive, or lacks an attributable denial, the probe exits nonzero and reports NO-GO.

## Reproduce

Run only on a private macOS host with at least 20 GB free in the temporary volume. The script does not touch an installed Sail app, existing worktrees, or an existing launchd label. It builds a unique app bundle and launch agent under one caller-created scratch root, ad-hoc signs the bundle, calls `SMAppService.agent(plistName:).register()` and `unregister()`, and never uses `launchctl bootstrap` or overrides a user approval decision.

```sh
df -Pk "${TMPDIR:-/tmp}"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/sail-497-spike.XXXXXX")
node scripts/macos-provider-supervision-probe.mjs --scratch-root "$scratch" --sdk /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk --waive-registration-denial
```

The `--sdk` value is host-specific. On the evidence host, the active Command Line Tools SDK was incompatible with its Swift compiler, so the installed 15.4 SDK was selected explicitly. The `--waive-registration-denial` flag records the user's waiver for #497; it does not run or pass the denial trial. Without that flag, the untested trial remains mandatory and the probe reports NO-GO. The script prints the full JSON report and stores it in its unique `probe-*/report.json` directory. It exits 0 only when every non-waived mandatory finding passes. Review the report's `cleanup` and `preserve` fields before removing the scratch root. If `preserve` is true, retain the root and investigate manually; never kill a sampled PID or process group from the driver. Only the run owner removes its own root after confirming cleanup and retaining the needed report.

## Evidence on 2026-10-09

- Host: macOS 26.6.2 (25G83), arm64; Apple Swift 6.3.3; Command Line Tools SDK 15.4 selected; no valid Developer ID signing identity, so the private app was ad-hoc signed. `codesign --verify --deep --strict` passed.
- The generated bundle identifier and launchd label were unique to the run. `SMAppService.register()` returned `enabled`; two separate signed app executable instances reached one per-user service and one live provider generation for the same project. A second project received a distinct live provider generation.
- The project key mirrored `context::project_key` in `src-tauri/src/context.rs`: SHA-256 of canonical Git common directory bytes, a NUL byte, and canonical requested-directory bytes. An exact path and its symlink matched; a subdirectory and sibling worktree did not.
- Each Seatbelt operation had an unconfined positive control. Each project provider received its own deny-by-default profile allowing only that project's source and private state directory. Project read and private state write passed in their own profiles. Cross-project source and private-state reads, outside write, outbound local TCP, `fork`, `posix_spawn`, and `exec` failed. The macOS Sandbox log recorded a denial for the same provider PID and operation or target; a nonzero process exit alone did not pass a denial.
- One long-lived signed app fixture self-`SIGKILL` left the other app process on the same service and provider. A provider fixture self-`SIGKILL` was reaped and replaced. Fixture-only cancellation reaped its direct child and rejected an actual queued file effect from its stale generation; a fresh generation's queued effect executed. A service fixture self-`SIGKILL` was restarted by launchd with a valid new service generation; a deliberately failed socket response could not satisfy the restart check. The prior provider's heartbeat stopped and its executable was absent before new admission. The surviving app then obtained a new live provider.
- The generated launch agent used `RunAtLoad=true`, `KeepAlive=true`, and `AbandonProcessGroup=false`. Final `SMAppService.unregister()` returned `notRegistered`; `launchctl print` found no service under the unique label, no observed provider executable remained, and all observed heartbeats stopped. The historical report recorded `cleanup: unregistered`, `preserve: false`, and `verdict: GO` under a mandatory list that omitted registration denial. That result predates both the pre-waiver NO-GO and the current conditional GO under the explicit waiver.

## Crash-exit follow-up on 2026-10-10

The signed private-app probe recorded exit evidence in the crash trials. The service reaped the self-`SIGKILL` provider and recorded its PID, generation, raw `waitpid` status `9`, and signal `9` before replacement. For the service crash, `launchctl print` reported `last terminating signal = Killed: 9` for the unique launchd label; the new service had a different PID. The window crash recorded `SIGKILL`, and cancellation recorded child status `15`. The exercised trials passed and cleanup completed. The pre-waiver probe marked registration denial `NO-GO`, making the overall verdict `NO-GO`. The waiver changes that finding to `WAIVED`, never `PASS`, and permits GO only if all other mandatory findings pass.

The probe uses direct signed app executable invocations, not full Sail GUI windows. Its fixture Unix socket is deliberately unauthenticated and must never be reused for production. The result establishes this host's launchd and Seatbelt behavior only; it does not establish durable service authorization, production protocol safety, or cross-platform parity.

## Failure policy

- Registration denied or requiring System Settings approval: stop, unregister only this fixture if registered, report NO-GO. Do not use `launchctl bootstrap` as a shortcut.
- Successful registration leaves the user-denial criterion untested. The overall verdict remains NO-GO without the explicit waiver flag; with it, the report records `WAIVED`, not `PASS`. A malformed plist or sandbox error is not evidence of a genuine user-denied approval.
- Missing Seatbelt logs, failed positive controls, unexpected file/network/process access, or provider liveness ambiguity: report NO-GO. Do not weaken the forbidden scopes to make a test pass.
- Unregister failure, a continuing heartbeat, or a remaining private provider executable: preserve the scratch root and report NO-GO for manual recovery. The driver never sends a signal to an observed numeric PID or PGID.
