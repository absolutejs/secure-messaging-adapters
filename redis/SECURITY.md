# Security

Redis must be treated as a database, not a cache: enable authenticated TLS,
persistence, replication, backups, and `noeviction`. Monitor rejected writes,
persistence health, replication lag, memory pressure, failovers, and restores.

Lua guarantees an atomic in-server transition but does not by itself guarantee
disk durability or synchronous replica acknowledgement. Select and test those
operational guarantees explicitly. PostgreSQL remains the recommended backend
when losing up to one AOF fsync interval is unacceptable.

All keys for one tenant share a Redis Cluster slot. Do not let untrusted callers
control the key prefix, tenant binding, or device binding.
