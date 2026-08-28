# `@absolutejs/secure-messaging-store-conformance`

Framework-neutral, repeatable drills for every `SecureMessagingStore` adapter.
The runner checks atomic state/replay/outbox commits, revision compare-and-swap,
replay conflicts, rollback, concurrent writers, idempotent outbox acknowledgement,
revision rollback rejection, revision-checked deletion, cloning, and ambiguous
commit retries.

```ts
await runSecureMessagingStoreConformance({
  createStore: (scenario) => createStoreForIsolatedTenant(scenario),
});
```

Use an isolated tenant or freshly reset database for every scenario. Run this
suite in adapter CI, before PaaS releases, and during scheduled durability drills.

Backup drills can call `seedSecureMessagingStoreRecovery`, capture an
operator-controlled backup, call `mutateSecureMessagingStoreAfterRecoveryPoint`
against the source, restore into an isolated target, and then call
`verifySecureMessagingStoreRecovery` against that target. The fixture contains
only synthetic identifiers and encrypted bytes, so drill evidence never needs
tenant data or key material.

Licensed under Apache-2.0.
