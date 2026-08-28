import { runSecureMessagingStoreConformance } from "@absolutejs/secure-messaging-store-conformance";
import { afterAll, expect, test } from "bun:test";
import Redis from "ioredis";
import {
  SECURE_MESSAGING_REDIS_COMMIT_SCRIPT,
  createIoRedisSecureMessagingClient,
  createRedisSecureMessagingStore,
} from "../src";

const redisUrl = process.env.SECURE_MESSAGING_TEST_REDIS_URL;
const redis =
  redisUrl === undefined
    ? undefined
    : new Redis(redisUrl, { lazyConnect: true });

afterAll(async () => {
  if (redis !== undefined && redis.status !== "end") await redis.quit();
});

test("commit script validates every conflict before its first write", () => {
  const firstWrite =
    SECURE_MESSAGING_REDIS_COMMIT_SCRIPT.indexOf("redis.call('HSET'");
  expect(firstWrite).toBeGreaterThan(0);
  expect(
    SECURE_MESSAGING_REDIS_COMMIT_SCRIPT.indexOf("replay-conflict"),
  ).toBeLessThan(firstWrite);
  expect(
    SECURE_MESSAGING_REDIS_COMMIT_SCRIPT.indexOf("prior_payload"),
  ).toBeLessThan(firstWrite);
});

test.skipIf(redis === undefined)(
  "passes every conformance and crash-boundary drill against Redis",
  async () => {
    if (redis === undefined) throw new Error("Redis test URL is required");
    if (redis.status === "wait") await redis.connect();
    const client = createIoRedisSecureMessagingClient(redis);
    const runId = crypto.randomUUID();
    const result = await runSecureMessagingStoreConformance({
      createStore: (scenario) =>
        createRedisSecureMessagingStore({
          client,
          deviceId: "device-1",
          durability: {
            mode: "aof",
            replicaFsyncs: 0,
            timeoutMilliseconds: 5_000,
          },
          tenantId: `${runId}:${scenario}`,
        }),
    });
    expect(result.scenarios).toHaveLength(9);
    const tenantId = `${runId}:device-isolation`;
    const first = createRedisSecureMessagingStore({
      client,
      deviceId: "device-a",
      durability: {
        mode: "aof",
        replicaFsyncs: 0,
        timeoutMilliseconds: 5_000,
      },
      tenantId,
    });
    const second = createRedisSecureMessagingStore({
      client,
      deviceId: "device-b",
      durability: {
        mode: "aof",
        replicaFsyncs: 0,
        timeoutMilliseconds: 5_000,
      },
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
  30_000,
);

test("public source uses type aliases rather than interfaces", async () => {
  const source = await Bun.file(
    new URL("../src/index.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/\binterface\s+[A-Za-z_$]/u);
});
