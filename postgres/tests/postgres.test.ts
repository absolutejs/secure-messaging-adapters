import { runSecureMessagingStoreConformance } from "@absolutejs/secure-messaging-store-conformance";
import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  SECURE_MESSAGING_POSTGRES_MIGRATION,
  createNodePostgresSecureMessagingClient,
  createPostgresSecureMessagingStore,
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
          tenantId: `${runId}:${scenario}`,
        }),
    });
    expect(result.scenarios).toHaveLength(8);
    const tenantId = `${runId}:device-isolation`;
    const first = createPostgresSecureMessagingStore({
      client,
      deviceId: "device-a",
      tenantId,
    });
    const second = createPostgresSecureMessagingStore({
      client,
      deviceId: "device-b",
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
