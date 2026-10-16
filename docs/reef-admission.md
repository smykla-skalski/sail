# Reef admission

Enable **Let Reef admit new agent turns and browser tabs** under Settings →
Agents to share Reef's workstation budget. Install a Reef version supporting
`reef admission-protocol` and start `reef serve` before enabling the setting.
Restart Sail to apply admission changes. Settings shows the active policy and
any saved change awaiting restart; reloading a window does not change the policy.

Each queued agent turn or browser tab reserves capacity before starting. Sail
shows Reef's queue reason and starts work only after admission. Cancelling queued
work releases its request. Finished work releases its reservation. Pressure
changes, scheduler loss and changing this setting never stop running work.

When Reef is missing, incompatible or unavailable, queued work shows the error
and retries discovery every three seconds. Work stays queued until Reef recovers
or the request is cancelled. Sail never falls back to unscheduled execution.

While enabled, Reef replaces Sail's memory, swap and disk pressure gate for agent
turns and browser tabs. Sail's per-kind concurrency limits still apply, and
validation jobs retain their existing policy. Disabling the setting restores
Sail's machine-pressure settings after restarting Sail.

The separate Reef canary setting measures selected commands launched by agent
adapters. It does not enable turn or browser admission. While turn admission is
active, adapters start without command canary wrapping, preventing a second
scheduler reservation inside an admitted turn. The saved canary percentage is
preserved and applies again when Sail starts with turn admission disabled. External admission uses
Reef's supported [protocol v1](https://github.com/smykla-skalski/reef/blob/main/docs/external-admission.md),
with one CPU and 1024 MiB reserved per agent turn, or one CPU and 512 MiB per tab.
