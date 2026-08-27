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
  tenantId: authenticatedTenant.id,
});
```

An ioredis wrapper is also exported. Configure AOF and RDB persistence,
replication, backups, and `maxmemory-policy noeviction`. A cache or evicting Redis
deployment is unsafe for MLS state. PostgreSQL is the default recommendation.

Inbound replay receipts use absolute expiry. Tenant and device IDs jointly bind
the Redis Cluster namespace because each device has distinct MLS state.
Conversation state and outbox entries do not expire and must never be evicted.
Run the shared conformance suite after failover and restore drills.

Licensed under Apache-2.0.
