import type {
  SecureMessagingInboundReceipt,
  SecureMessagingOutboxEntry,
  SecureMessagingStore,
  SecureMessagingStoredConversation,
} from "@absolutejs/secure-messaging";
import { expect, test } from "bun:test";
import {
  mutateSecureMessagingStoreAfterRecoveryPoint,
  runSecureMessagingStoreConformance,
  seedSecureMessagingStoreRecovery,
  verifySecureMessagingStoreRecovery,
} from "../src";

const memoryStore = (): SecureMessagingStore => {
  const states = new Map<string, SecureMessagingStoredConversation>();
  const receipts = new Map<string, SecureMessagingInboundReceipt>();
  const pending = new Map<string, SecureMessagingOutboxEntry>();
  const cloneState = (value: SecureMessagingStoredConversation) => ({
    ...value,
    sealedState: value.sealedState.slice(),
  });
  const cloneOutbox = (value: SecureMessagingOutboxEntry) => ({
    ...value,
    message: { ...value.message, bytes: value.message.bytes.slice() },
  });
  return {
    commit: async ({
      conversation,
      expectedRevision,
      inbound,
      outbox = [],
    }) => {
      const current = states.get(conversation.conversationId);
      if (
        (expectedRevision === undefined && current !== undefined) ||
        (expectedRevision !== undefined &&
          (current?.revision !== expectedRevision ||
            conversation.revision !== expectedRevision + 1))
      )
        return "state-conflict";
      if (inbound !== undefined) {
        const prior = receipts.get(
          `${inbound.conversationId}:${inbound.messageId}`,
        );
        if (prior !== undefined && prior.digest !== inbound.digest)
          return "replay-conflict";
      }
      states.set(conversation.conversationId, cloneState(conversation));
      if (inbound !== undefined)
        receipts.set(`${inbound.conversationId}:${inbound.messageId}`, {
          ...inbound,
        });
      for (const entry of outbox)
        pending.set(entry.queueId, cloneOutbox(entry));
      return "committed";
    },
    inspectInbound: async ({ conversationId, digest, messageId }) => {
      const prior = receipts.get(`${conversationId}:${messageId}`);
      return prior === undefined
        ? "new"
        : prior.digest === digest
          ? "duplicate"
          : "conflict";
    },
    listOutbox: async (limit) =>
      [...pending.values()].slice(0, limit).map(cloneOutbox),
    loadConversation: async (conversationId) => {
      const value = states.get(conversationId);
      return value === undefined ? undefined : cloneState(value);
    },
    recordInbound: async (receipt) => {
      const key = `${receipt.conversationId}:${receipt.messageId}`;
      const prior = receipts.get(key);
      if (prior !== undefined)
        return prior.digest === receipt.digest ? "duplicate" : "conflict";
      receipts.set(key, { ...receipt });
      return "recorded";
    },
    removeConversation: async (conversationId, expectedRevision) => {
      if (states.get(conversationId)?.revision !== expectedRevision)
        return false;
      return states.delete(conversationId);
    },
    removeOutbox: async (queueIds) => {
      for (const queueId of queueIds) pending.delete(queueId);
    },
  };
};

test("the conformance runner exercises the complete durable contract", async () => {
  const result = await runSecureMessagingStoreConformance({
    createStore: memoryStore,
  });
  expect(result.scenarios).toHaveLength(9);
});

test("the two-phase recovery fixture detects a post-backup source", async () => {
  const store = memoryStore();
  const fixture = await seedSecureMessagingStoreRecovery(store, "unit");
  await verifySecureMessagingStoreRecovery(store, fixture);
  await mutateSecureMessagingStoreAfterRecoveryPoint(store, fixture);
  await expect(
    verifySecureMessagingStoreRecovery(store, fixture),
  ).rejects.toThrow("restored revision");
});

test("public source uses type aliases rather than interfaces", async () => {
  const source = await Bun.file(
    new URL("../src/index.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/\binterface\s+[A-Za-z_$]/u);
});
