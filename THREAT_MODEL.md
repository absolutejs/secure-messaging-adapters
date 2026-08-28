# Secure messaging store threat model

Status: maintainer pre-audit model for the 0.x adapter line. This document does
not represent an independent security assessment.

## Assets and trust boundaries

The stores hold sealed MLS provider state, replay receipts, encrypted delivery
frames, and minimum routing metadata. Unsealed MLS state, message plaintext, and
identity private keys remain outside the adapter. The authenticated application
is responsible for binding each store to the exact tenant and device; the
database, its administrators, backup system, replication transport, and metrics
pipeline are not trusted with plaintext.

## Required invariants

- A conversation state transition advances exactly one revision and commits
  atomically with its replay receipt and outbox entries.
- Tenant and device namespaces cannot collide, including for two devices in one
  conversation.
- Replay conflicts and stale writers make no partial writes.
- A rejected Welcome receipt survives without creating conversation state.
- Acknowledgement policy is explicit. A timeout or disconnect after a mutation
  is reported as typed durability uncertainty and forces authoritative reload
  and exact intended-conversation comparison before retry.
- Backup restoration preserves the state, replay barrier, and encrypted outbox
  from one consistent recovery point. Recovery targets are isolated.
- Stored identifiers are bounded and one-way digested; stored payloads are
  bounded and parsed with an exact schema.

## Threats and controls

| Threat                                              | Primary control                                                                                      | Residual risk                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stale process overwrites newer MLS state            | Compare-and-swap plus exact next-revision enforcement                                                | Database administrator can still alter ciphertext or rows, causing denial of service   |
| Crash splits state, replay, and delivery writes     | PostgreSQL transaction or single-slot Redis Lua script                                               | Client timeout can hide whether the atomic commit completed                            |
| Same tenant has two device-local MLS states         | Namespace digest binds canonical tenant and device tuple                                             | Compromised application authentication can select the wrong device                     |
| Replay receipt expires or disappears early          | Absolute expiry, non-evicting storage, backup drills                                                 | Operator-selected retention can still be too short                                     |
| Redis acknowledges volatile or unreplicated state   | Mandatory durability mode, minimum-replica admission, typed uncertainty, and `WAIT`/`WAITAOF` checks | Redis replication is not strongly consistent and failover can lose acknowledged writes |
| Cluster router acknowledges on another shard        | Built-in wrappers are limited to direct standalone/Sentinel primary clients                          | Cluster needs a custom same-shard client and independent validation                    |
| PostgreSQL session weakens commit durability        | Per-transaction `synchronous_commit=on` or `remote_apply`                                            | Synchronous standby loss can block availability                                        |
| Backup exists but is unusable or from a mixed point | Two-phase synthetic seed/mutate/isolated-restore verifier                                            | Operator backup tooling and encryption remain outside the package                      |
| Oversized or malformed stored data exhausts memory  | Identifier/payload bounds, canonical base64url, exact-key parsing                                    | Database-level storage growth still needs quotas and monitoring                        |
| Secrets leak through telemetry or drill evidence    | Generic errors and synthetic recovery fixtures                                                       | Driver/database logs remain operator-controlled                                        |

## Audit targets

An independent reviewer should prioritize PostgreSQL transaction ambiguity,
Redis Lua key/argument indexing, `WAIT`/`WAITAOF` connection affinity, Redis
Cluster/Sentinel reconnection behavior, identifier-domain separation, parser
failure behavior, migration permissions, backup confidentiality, and denial of
service bounds. Review findings should identify the exact package version and
commit and be published or linked from a GitHub Security Advisory after fixes.

## Operational references

- PostgreSQL backup and restore: <https://www.postgresql.org/docs/current/backup.html>
- PostgreSQL point-in-time recovery: <https://www.postgresql.org/docs/current/continuous-archiving.html>
- PostgreSQL failover: <https://www.postgresql.org/docs/current/warm-standby-failover.html>
- Redis persistence: <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
- Redis replication: <https://redis.io/docs/latest/operate/oss_and_stack/management/replication/>
- Redis Sentinel: <https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/>
- Redis `WAIT`: <https://redis.io/docs/latest/commands/wait/>
- Redis `WAITAOF`: <https://redis.io/docs/latest/commands/waitaof/>
