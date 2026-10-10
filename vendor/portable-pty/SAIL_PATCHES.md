# Sail patches

This is `portable-pty` 0.9.0 from crates.io. Sail adds a Windows
`CommandBuilder::set_job_handle` option that passes
`PROC_THREAD_ATTRIBUTE_JOB_LIST` to `CreateProcessW`. This assigns owned
terminal shells to their Job Object atomically, before the shell can launch
descendants. The upstream PTY API does not expose process creation attributes.
