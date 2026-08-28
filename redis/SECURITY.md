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

Redis replication is asynchronous. Configure a minimum writable replica count,
but still treat every mutation transport failure or insufficient `WAIT`/`WAITAOF`
response as `SecureMessagingDurabilityUncertainError`. Resolve the authoritative
primary and compare the complete intended conversation before retrying. Never
trust state read from an isolated former primary and never retry blindly.

Provision application ACL users with `createSecureMessagingRedisAclRules()`.
Do not add command categories, broad key patterns, or Pub/Sub channels. Use
separate identities for application access, replication, Sentinel monitoring,
Sentinel peers, and administration. Disable the default user and rotate with a
second named user before revoking and disconnecting the first.
