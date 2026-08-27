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
  tenantId: authenticatedTenant.id,
});
```

`createNodePostgresSecureMessagingClient(pool)` supports `pg` pools without
making either driver a runtime dependency.

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

Licensed under Apache-2.0.
