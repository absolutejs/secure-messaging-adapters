# `@absolutejs/secure-messaging-redis`

An atomic Redis `SecureMessagingStore` for operators deliberately using Redis as
durable primary storage. Lua scripts commit sealed MLS state, replay receipts,
and encrypted outbox entries as one transition. Every tenant uses a Redis Cluster
hash tag so all transaction keys occupy one slot.

```ts
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = createRedisSecureMessagingStore({
  client: createNodeRedisSecureMessagingClient(redis),
  deviceId: authenticatedDevice.id,
  durability: {
    mode: "aof",
    replicaFsyncs: 1,
    timeoutMilliseconds: 5_000,
  },
  tenantId: authenticatedTenant.id,
});
```

An ioredis wrapper is also exported. Configure AOF and RDB persistence,
replication, backups, and `maxmemory-policy noeviction`. A cache or evicting Redis
deployment is unsafe for MLS state. PostgreSQL is the default recommendation.

Durability is mandatory and explicit. `aof` uses Redis 7.2+ `WAITAOF` after
each successful mutation and fails closed unless the local AOF plus the requested
replica AOF count acknowledge it. `replicated` uses `WAIT`, which reduces but
does not eliminate failover data loss. `memory` performs no acknowledgement and
must be limited to tests or deliberately lossy development environments. A
durability timeout is an ambiguous commit: reload state before retrying.

The built-in node-redis and ioredis wrappers are for a direct standalone or
Sentinel-managed primary connection. Although the hash tag keeps Lua keys in one
Redis Cluster slot, a keyless `WAIT` or `WAITAOF` sent through a generic Cluster
router is not proven to use that same primary connection. Cluster operators must
provide a custom `SecureMessagingRedisClient` that pins `eval` and durability
acknowledgement to the same shard connection; this is an independent-review
target, not an inferred guarantee.

Inbound replay receipts use absolute expiry. Tenant and device IDs jointly bind
the Redis Cluster namespace because each device has distinct MLS state.
Conversation state and outbox entries do not expire and must never be evicted.
Run the shared conformance suite after failover and restore drills.

Licensed under Apache-2.0.
