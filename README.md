# AbsoluteJS secure-messaging adapters

Durable storage adapters and repeatable conformance drills for
`@absolutejs/secure-messaging`.

- `@absolutejs/secure-messaging-store-conformance` checks the atomic store
  contract and crash boundaries without selecting a database.
- `@absolutejs/secure-messaging-postgres` is the recommended production store.
- `@absolutejs/secure-messaging-redis` is available for operators who configure
  Redis as durable, non-evicting primary storage.

All packages are early `0.x` releases. No adapter changes the explicit E2EE
security mode or makes plaintext available to the database.

Run the real-backend drills with isolated databases:

```sh
SECURE_MESSAGING_TEST_POSTGRES_URL=postgresql://... bun run --cwd postgres test:integration
SECURE_MESSAGING_TEST_REDIS_URL=redis://... bun run --cwd redis test:integration
```

Licensed under Apache-2.0.
