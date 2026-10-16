# Context handoff threshold

- The default is **100,000 tokens**, with a checkpoint request 10,000 tokens earlier. Settings accepts an absolute threshold from 20,000 to 10,000,000 tokens. Handoff occurs at the configured threshold or the reported window, whichever is smaller.
- Claude, Codex, and OpenCode expose context through ACP `usage_update.used` and `usage_update.size`. Sail retains both values. The thread header displays used tokens, window size, and their rounded percentage; the denominator is the provider-reported window for that thread, not an assumed advertised model maximum. Missing or invalid usage remains unknown and never triggers a handoff.
- Threshold comparisons use the unrounded token count. A 1,000,000-token window therefore reaches the default at 10%, while a 200,000-token window reaches it at 50%. Each thread retains independent pressure history, including across restarts.
- Existing percentage settings are replaced by the absolute default; the old `sai-context-handoff-threshold` value is never reinterpreted as tokens. The new setting is `sai-context-handoff-tokens`.

## Default evidence

The prerequisite [sai issue 289](https://github.com/smykla-skalski/sai/issues/289) delivered cost reporting, but its [merged-run report](https://github.com/smykla-skalski/sai/pull/298#issuecomment-6201216483) records all four cost observations as unknown. It supplies no measured cost optimum; 100,000 tokens is an explicit conservative override, not a claimed billing optimum.

The [source investigation](https://github.com/smykla-skalski/sai/issues/288) observed 89 worker runs growing from about 40,000 to over 500,000 context tokens, with 4% of calls responsible for 79% of cache writes, mostly after pauses longer than five minutes. The 100,000-token default bounds retained context well below those largest calls and the previous 850,000-token trigger on a 1M window, while leaving 60,000 tokens beyond the observed starting context. Compare future measured cost per merged PR and retry/lost-state outcomes before tuning this default. Users can override it in Settings.
