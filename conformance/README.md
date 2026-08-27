# `@absolutejs/secure-messaging-store-conformance`

Framework-neutral, repeatable drills for every `SecureMessagingStore` adapter.
The runner checks atomic state/replay/outbox commits, revision compare-and-swap,
replay conflicts, rollback, concurrent writers, idempotent outbox acknowledgement,
revision-checked deletion, cloning, and ambiguous commit retries.

```ts
await runSecureMessagingStoreConformance({
  createStore: (scenario) => createStoreForIsolatedTenant(scenario),
});
```

Use an isolated tenant or freshly reset database for every scenario. Run this
suite in adapter CI, before PaaS releases, and during scheduled durability drills.

Licensed under Apache-2.0.
