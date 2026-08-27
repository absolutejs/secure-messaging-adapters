import type {
  SecureMessagingInboundReceipt,
  SecureMessagingOutboxEntry,
  SecureMessagingStore,
  SecureMessagingStoredConversation,
} from "@absolutejs/secure-messaging";

const farFuture = 4_000_000_000_000;

export type SecureMessagingStoreConformanceOptions = {
  readonly createStore: (
    scenario: string,
  ) => Promise<SecureMessagingStore> | SecureMessagingStore;
};

export type SecureMessagingStoreConformanceResult = {
  readonly scenarios: readonly string[];
};

const equal = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}`);
};

const requireValue = <Value>(
  value: Value | undefined,
  label: string,
): Value => {
  if (value === undefined) throw new Error(`${label}: value was missing`);
  return value;
};

const conversation = (
  conversationId: string,
  revision: number,
  marker = revision,
): SecureMessagingStoredConversation => ({
  conversationId,
  revision,
  sealedState: Uint8Array.of(marker, marker + 1),
  securityMode: "strict-e2ee",
  status: "active",
});

const inbound = (
  conversationId: string,
  messageId: string,
  digest = "digest-a",
): SecureMessagingInboundReceipt => ({
  conversationId,
  digest,
  expiresAt: farFuture,
  messageId,
});

const outbox = (
  conversationId: string,
  queueId: string,
  marker = 7,
): SecureMessagingOutboxEntry => ({
  message: {
    bytes: Uint8Array.of(marker, marker + 1),
    conversationId,
    id: `${queueId}:message`,
    kind: "application",
    recipientDeviceId: "recipient-device",
  },
  queueId,
});

const run = async (
  options: SecureMessagingStoreConformanceOptions,
  name: string,
  operation: (store: SecureMessagingStore) => Promise<void>,
) => {
  try {
    await operation(await options.createStore(name));
  } catch (error) {
    throw new Error(`SecureMessagingStore conformance failed: ${name}`, {
      cause: error,
    });
  }
};

export const runSecureMessagingStoreConformance = async (
  options: SecureMessagingStoreConformanceOptions,
): Promise<SecureMessagingStoreConformanceResult> => {
  const scenarios: string[] = [];
  const scenario = async (
    name: string,
    operation: (store: SecureMessagingStore) => Promise<void>,
  ) => {
    await run(options, name, operation);
    scenarios.push(name);
  };

  await scenario("atomic state, replay, and outbox commit", async (store) => {
    const state = conversation("conversation-atomic", 1);
    const receipt = inbound(state.conversationId, "message-atomic");
    const queued = outbox(state.conversationId, "queue-atomic");
    equal(
      await store.commit({
        conversation: state,
        inbound: receipt,
        outbox: [queued],
      }),
      "committed",
      "initial commit",
    );
    state.sealedState.fill(99);
    queued.message.bytes.fill(99);
    const loaded = requireValue(
      await store.loadConversation(state.conversationId),
      "loaded state",
    );
    equal([...loaded.sealedState], [1, 2], "stored state is cloned");
    equal(await store.inspectInbound(receipt), "duplicate", "atomic receipt");
    const pending = await store.listOutbox(10);
    equal(
      pending.map(({ queueId }) => queueId),
      [queued.queueId],
      "atomic outbox",
    );
    equal(
      [...requireValue(pending[0], "pending outbox").message.bytes],
      [7, 8],
      "stored frame is cloned",
    );
  });

  await scenario("revision compare-and-swap", async (store) => {
    equal(
      await store.commit({ conversation: conversation("conversation-cas", 1) }),
      "committed",
      "CAS seed",
    );
    const results = await Promise.all([
      store.commit({
        conversation: conversation("conversation-cas", 2, 20),
        expectedRevision: 1,
      }),
      store.commit({
        conversation: conversation("conversation-cas", 2, 30),
        expectedRevision: 1,
      }),
    ]);
    equal(
      [...results].sort(),
      ["committed", "state-conflict"],
      "exactly one CAS winner",
    );
    equal(
      (await store.loadConversation("conversation-cas"))?.revision,
      2,
      "CAS revision",
    );
  });

  await scenario("replay classification", async (store) => {
    const receipt = inbound("conversation-replay", "message-replay");
    equal(await store.inspectInbound(receipt), "new", "new receipt");
    equal(await store.recordInbound(receipt), "recorded", "record receipt");
    equal(await store.recordInbound(receipt), "duplicate", "duplicate receipt");
    equal(
      await store.inspectInbound({ ...receipt, digest: "digest-b" }),
      "conflict",
      "conflicting receipt",
    );
    equal(
      await store.recordInbound({ ...receipt, digest: "digest-b" }),
      "conflict",
      "conflicting record",
    );
  });

  await scenario("state conflict rolls back related writes", async (store) => {
    equal(
      await store.commit({
        conversation: conversation("conversation-rollback", 1),
      }),
      "committed",
      "rollback seed",
    );
    const receipt = inbound("conversation-rollback", "message-rollback");
    equal(
      await store.commit({
        conversation: conversation("conversation-rollback", 2),
        expectedRevision: 99,
        inbound: receipt,
        outbox: [outbox("conversation-rollback", "queue-rollback")],
      }),
      "state-conflict",
      "stale commit",
    );
    equal(await store.inspectInbound(receipt), "new", "receipt rollback");
    equal(await store.listOutbox(10), [], "outbox rollback");
  });

  await scenario(
    "replay conflict rolls back state and outbox",
    async (store) => {
      const receipt = inbound("conversation-replay-rollback", "message-shared");
      equal(await store.recordInbound(receipt), "recorded", "replay seed");
      equal(
        await store.commit({
          conversation: conversation("conversation-replay-rollback", 1),
          inbound: { ...receipt, digest: "different-digest" },
          outbox: [
            outbox("conversation-replay-rollback", "queue-replay-rollback"),
          ],
        }),
        "replay-conflict",
        "replay conflict",
      );
      equal(
        await store.loadConversation("conversation-replay-rollback"),
        undefined,
        "state rollback",
      );
      equal(await store.listOutbox(10), [], "replay outbox rollback");
    },
  );

  await scenario("outbox acknowledgement is idempotent", async (store) => {
    const entries = [
      outbox("conversation-outbox", "queue-a", 1),
      outbox("conversation-outbox", "queue-b", 2),
    ];
    equal(
      await store.commit({
        conversation: conversation("conversation-outbox", 1),
        outbox: entries,
      }),
      "committed",
      "outbox seed",
    );
    await store.removeOutbox(["queue-a"]);
    await store.removeOutbox(["queue-a"]);
    equal(
      (await store.listOutbox(10)).map(({ queueId }) => queueId),
      ["queue-b"],
      "idempotent acknowledgement",
    );
  });

  await scenario("revision-checked conversation removal", async (store) => {
    equal(
      await store.commit({
        conversation: conversation("conversation-remove", 1),
      }),
      "committed",
      "remove seed",
    );
    equal(
      await store.removeConversation("conversation-remove", 2),
      false,
      "stale removal",
    );
    equal(
      await store.removeConversation("conversation-remove", 1),
      true,
      "checked removal",
    );
    equal(
      await store.loadConversation("conversation-remove"),
      undefined,
      "removed conversation",
    );
  });

  await scenario(
    "ambiguous commit retry preserves durable effects",
    async (store) => {
      const input = {
        conversation: conversation("conversation-crash", 1),
        outbox: [outbox("conversation-crash", "queue-crash")],
      };
      equal(await store.commit(input), "committed", "first commit");
      equal(await store.commit(input), "state-conflict", "ambiguous retry");
      equal(
        (await store.loadConversation("conversation-crash"))?.revision,
        1,
        "durable state after retry",
      );
      equal(
        (await store.listOutbox(10)).map(({ queueId }) => queueId),
        ["queue-crash"],
        "durable outbox after retry",
      );
    },
  );

  return Object.freeze({ scenarios: Object.freeze(scenarios) });
};
