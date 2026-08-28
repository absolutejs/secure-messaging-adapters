# `@absolutejs/secure-messaging-postgres`

The recommended production `SecureMessagingStore` for AbsoluteJS. One database
transaction atomically commits sealed MLS state, an inbound replay receipt, and
encrypted outbox entries. Conversation updates use revision compare-and-swap.

```ts
import postgres from "postgres";
import {
  createPostgresJsSecureMessagingClient,
  createPostgresSecureMessagingStore,
} from "@absolutejs/secure-messaging-postgres";

const sql = postgres(process.env.DATABASE_URL!);
const store = createPostgresSecureMessagingStore({
  client: createPostgresJsSecureMessagingClient(sql),
  deviceId: authenticatedDevice.id,
  durability: "local-wal",
  tenantId: authenticatedTenant.id,
});
```

`createNodePostgresSecureMessagingClient(pool)` supports `pg` pools without
making either driver a runtime dependency.

`durability` is mandatory. `local-wal` forces `synchronous_commit=on` for every
adapter transaction, regardless of a weaker session or database default.
`synchronous-replica` forces `synchronous_commit=remote_apply` and must only be
used with an intentionally configured synchronous standby. It can block when
that standby is unavailable, so rehearse failover and define an operator-owned
availability policy instead of weakening durability silently.
Both modes fail closed when PostgreSQL reports `fsync=off`; the replica mode
also rejects an empty `synchronous_standby_names` setting.

Apply the exported `SECURE_MESSAGING_POSTGRES_MIGRATION` or the packaged
`./migrations/postgres.sql` through your migration system. The migration is
idempotent. Call `deleteExpiredInbound()` repeatedly from a maintenance job
until it returns zero.

Tenant/device scope, conversation, message, and queue identifiers are SHA-256
digested before use as keys. Device scope is mandatory because two devices hold
different MLS state for the same conversation. Delivery routing metadata and
encrypted frames remain visible to the database; message plaintext and unsealed
MLS state do not.

Run `@absolutejs/secure-messaging-store-conformance` against an isolated tenant
after database upgrades and restore drills.

This release accepts the `@absolutejs/secure-messaging@0.6` store contract and
classifies mutation response loss as `SecureMessagingDurabilityUncertainError`.
Reconnect to the authoritative database and call
`resolveSecureMessagingStoreCommit()` before retrying a conversation commit.

Licensed under Apache-2.0.
