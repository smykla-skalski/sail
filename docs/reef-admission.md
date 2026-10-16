# Reef admission

Enable **Let Reef admit new agent turns and browser tabs** under Settings →
Agents to share Reef's workstation budget. Install a Reef version supporting
`reef admission-protocol` and start `reef serve` before enabling the setting.

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
Sail's machine-pressure settings for new work.

The separate Reef canary setting measures selected commands launched by agent
adapters. It does not enable turn or browser admission. External admission uses
Reef's supported [protocol v1](https://github.com/smykla-skalski/reef/blob/main/docs/external-admission.md),
with one CPU and 1024 MiB reserved per agent turn, or one CPU and 512 MiB per tab.
