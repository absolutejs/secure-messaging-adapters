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
          tenantId: `${runId}:${scenario}`,
        }),
    });
    expect(result.scenarios).toHaveLength(8);
  },
);

test("public source uses type aliases rather than interfaces", async () => {
  const source = await Bun.file(
    new URL("../src/index.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/\binterface\s+[A-Za-z_$]/u);
});
