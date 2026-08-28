import { SecureMessagingDurabilityUncertainError } from "@absolutejs/secure-messaging";
import {
  runSecureMessagingDurabilityUncertaintyConformance,
  runSecureMessagingStoreConformance,
} from "@absolutejs/secure-messaging-store-conformance";
import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  SECURE_MESSAGING_POSTGRES_MIGRATION,
  createNodePostgresSecureMessagingClient,
  createPostgresSecureMessagingStore,
  type SecureMessagingPostgresTransaction,
} from "../src";

const databaseUrl = process.env.SECURE_MESSAGING_TEST_POSTGRES_URL;
const pool =
  databaseUrl === undefined
    ? undefined
    : new Pool({ connectionString: databaseUrl, max: 8 });

afterAll(async () => {
  await pool?.end();
});

test("packaged migration matches the exported idempotent migration", async () => {
  const shipped = await Bun.file(
    new URL("../migrations/001_secure_messaging.sql", import.meta.url),
  ).text();
  expect(shipped.trim()).toBe(SECURE_MESSAGING_POSTGRES_MIGRATION);
  expect(shipped).toContain("CREATE TABLE IF NOT EXISTS");
  expect(shipped).toContain("CREATE INDEX IF NOT EXISTS");
});

test("transaction response loss is explicitly uncertain", async () => {
  const store = createPostgresSecureMessagingStore({
    client: {
      query: async <Row>() => ({ rowCount: 0, rows: [] as Row[] }),
      transaction: async () => {
        throw new Error("private database diagnostic");
      },
    },
    deviceId: "device-1",
    durability: "local-wal",
    tenantId: "tenant-1",
  });
  await expect(
    store.commit({
      conversation: {
        conversationId: "conversation-1",
        revision: 1,
        sealedState: Uint8Array.of(1),
        securityMode: "strict-e2ee",
        status: "active",
      },
    }),
  ).rejects.toBeInstanceOf(SecureMessagingDurabilityUncertainError);
});

test.skipIf(pool === undefined)(
  "passes every conformance and crash-boundary drill against PostgreSQL",
  async () => {
    if (pool === undefined) throw new Error("PostgreSQL test URL is required");
    await pool.query(SECURE_MESSAGING_POSTGRES_MIGRATION);
    const client = createNodePostgresSecureMessagingClient(pool);
    const runId = crypto.randomUUID();
    const result = await runSecureMessagingStoreConformance({
      createStore: (scenario) =>
        createPostgresSecureMessagingStore({
          client,
          deviceId: "device-1",
          durability: "local-wal",
          tenantId: `${runId}:${scenario}`,
        }),
    });
    expect(result.scenarios).toHaveLength(9);
    const uncertaintyTenant = `${runId}:durability-uncertainty`;
    const faultClient = {
      ...client,
      transaction: async <Value>(
        operation: (
          transaction: SecureMessagingPostgresTransaction,
        ) => Promise<Value>,
      ) => {
        await client.transaction(operation);
        throw new Error("simulated lost commit response");
      },
    };
    const uncertainty =
      await runSecureMessagingDurabilityUncertaintyConformance({
        commitWithLostAcknowledgement: (input) =>
          createPostgresSecureMessagingStore({
            client: faultClient,
            deviceId: "device-1",
            durability: "local-wal",
            tenantId: uncertaintyTenant,
          }).commit(input),
        resolveAuthoritativeStore: () =>
          createPostgresSecureMessagingStore({
            client,
            deviceId: "device-1",
            durability: "local-wal",
            tenantId: uncertaintyTenant,
          }),
      });
    expect(uncertainty.initialResolution).toBe("applied");
    const tenantId = `${runId}:device-isolation`;
    const first = createPostgresSecureMessagingStore({
      client,
      deviceId: "device-a",
      durability: "local-wal",
      tenantId,
    });
    const second = createPostgresSecureMessagingStore({
      client,
      deviceId: "device-b",
      durability: "local-wal",
      tenantId,
    });
    const state = (marker: number) => ({
      conversationId: "shared-conversation",
      revision: 1,
      sealedState: Uint8Array.of(marker),
      securityMode: "strict-e2ee" as const,
      status: "active" as const,
    });
    expect(await first.commit({ conversation: state(1) })).toBe("committed");
    expect(await second.commit({ conversation: state(2) })).toBe("committed");
    expect([
      ...(await first.loadConversation("shared-conversation"))!.sealedState,
    ]).toEqual([1]);
    expect([
      ...(await second.loadConversation("shared-conversation"))!.sealedState,
    ]).toEqual([2]);
  },
);

test("public source uses type aliases rather than interfaces", async () => {
  const source = await Bun.file(
    new URL("../src/index.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/\binterface\s+[A-Za-z_$]/u);
});
