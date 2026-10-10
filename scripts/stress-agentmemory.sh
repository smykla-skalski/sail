#!/usr/bin/env bash
set -euo pipefail

repetitions="${1:-1000}"
if [[ ! "$repetitions" =~ ^([1-9][0-9]{0,2}|1000)$ ]]; then
  echo "usage: $0 [repetition-count-1-to-1000]" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$(mktemp "${TMPDIR:-/tmp}/sail-agentmemory-stress.XXXXXX")"
trap 'rm -f "$log"' EXIT

if ! cargo test --manifest-path "$root/src-tauri/Cargo.toml" --locked \
  --lib agentmemory_loopback_ -- --list >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
test_count="$(grep -c '^memory_provider::tests::agentmemory_loopback_.*: test$' "$log" || true)"
if [[ "$test_count" -ne 2 ]]; then
  echo "expected exactly two AgentMemory loopback tests, found $test_count" >&2
  cat "$log" >&2
  exit 1
fi

for ((run = 1; run <= repetitions; run++)); do
  if ! cargo test --manifest-path "$root/src-tauri/Cargo.toml" --locked \
    --lib agentmemory_loopback_ -- --quiet >"$log" 2>&1; then
    echo "AgentMemory loopback repetition $run/$repetitions failed" >&2
    cat "$log" >&2
    exit 1
  fi
  if ((run % 100 == 0 || run == repetitions)); then
    echo "AgentMemory loopback repetitions passed: $run/$repetitions"
  fi
done
