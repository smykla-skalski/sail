# Sail patches

This is `portable-pty` 0.9.0 from crates.io. Sail adds a Windows
`CommandBuilder::set_job_handle` option that passes
`PROC_THREAD_ATTRIBUTE_JOB_LIST` to `CreateProcessW`. This assigns owned
terminal shells to their Job Object atomically, before the shell can launch
descendants. The upstream PTY API does not expose process creation attributes.

Sail does not request `PSEUDOCONSOLE_INHERIT_CURSOR`: each pane creates a fresh
terminal and does not need cursor state from a parent console. That flag requires
the host to handle cursor-position requests asynchronously on the PTY streams.
