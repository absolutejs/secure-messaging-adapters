import { SecureMessagingDurabilityUncertainError } from "@absolutejs/secure-messaging";
import {
  runSecureMessagingDurabilityUncertaintyConformance,
  runSecureMessagingStoreConformance,
} from "@absolutejs/secure-messaging-store-conformance";
import { afterAll, expect, test } from "bun:test";
import Redis from "ioredis";
import {
  SECURE_MESSAGING_REDIS_COMMIT_SCRIPT,
  SECURE_MESSAGING_REDIS_DEFAULT_KEY_PREFIX,
  createSecureMessagingRedisAclRules,
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

test("ACL contract is namespace-scoped and grants only exact commands", () => {
  const rules = createSecureMessagingRedisAclRules();
  expect(rules).toContain(`~${SECURE_MESSAGING_REDIS_DEFAULT_KEY_PREFIX}*`);
  expect(rules).toContain("-@all");
  expect(rules).toContain("resetchannels");
  expect(rules).not.toContain("allkeys");
  expect(rules).not.toContain("allchannels");
  expect(rules).not.toContain("+config");
  expect(rules).not.toContain("+flushall");
  expect(() =>
    createSecureMessagingRedisAclRules({ keyPrefix: "unsafe:*" }),
  ).toThrow("unsafe");
});

test("insufficient durability acknowledgement is explicitly uncertain", async () => {
  const store = createRedisSecureMessagingStore({
    client: {
      eval: async () => "committed",
      get: async () => null,
      hgetall: async () => ({}),
      wait: async () => 0,
      waitaof: async () => [0, 0],
      zrange: async () => [],
    },
    deviceId: "device-1",
    durability: {
      mode: "aof",
      replicaFsyncs: 0,
      timeoutMilliseconds: 1,
    },
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

test.skipIf(redis === undefined)(
  "passes every conformance and crash-boundary drill against Redis",
  async () => {
    if (redis === undefined) throw new Error("Redis test URL is required");
    if (redisUrl === undefined) throw new Error("Redis test URL is required");
    if (redis.status === "wait") await redis.connect();
    const client = createIoRedisSecureMessagingClient(redis);
    const runId = crypto.randomUUID();
    const state = (marker: number) => ({
      conversationId: "shared-conversation",
      revision: 1,
      sealedState: Uint8Array.of(marker),
      securityMode: "strict-e2ee" as const,
      status: "active" as const,
    });
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

    const aclUsername = `absolute-app-${runId}`;
    const aclPassword = crypto.randomUUID();
    await redis.call(
      "ACL",
      "SETUSER",
      aclUsername,
      "reset",
      "on",
      `>${aclPassword}`,
      ...createSecureMessagingRedisAclRules(),
    );
    const aclRedis = new Redis(redisUrl, {
      lazyConnect: true,
      password: aclPassword,
      username: aclUsername,
    });
    aclRedis.on("error", () => undefined);
    try {
      await aclRedis.connect();
      const aclStore = createRedisSecureMessagingStore({
        client: createIoRedisSecureMessagingClient(aclRedis),
        deviceId: "device-1",
        durability: {
          mode: "aof",
          replicaFsyncs: 0,
          timeoutMilliseconds: 5_000,
        },
        tenantId: `${runId}:acl-contract`,
      });
      expect(
        await aclStore.commit({
          conversation: state(3),
        }),
      ).toBe("committed");
      await expect(aclRedis.config("GET", "appendonly")).rejects.toThrow(
        "NOPERM",
      );
      await expect(aclRedis.set("outside:namespace", "denied")).rejects.toThrow(
        "NOPERM",
      );
      await expect(
        aclRedis.publish("__sentinel__:hello", "denied"),
      ).rejects.toThrow("NOPERM");
    } finally {
      aclRedis.disconnect(false);
      await redis.call("ACL", "DELUSER", aclUsername);
    }

    const uncertaintyTenant = `${runId}:durability-uncertainty`;
    const faultClient = {
      ...client,
      waitaof: async (
        localFsyncs: number,
        replicaFsyncs: number,
        timeoutMilliseconds: number,
      ) => {
        await client.waitaof(localFsyncs, replicaFsyncs, timeoutMilliseconds);
        return [0, 0];
      },
    };
    const uncertainty =
      await runSecureMessagingDurabilityUncertaintyConformance({
        commitWithLostAcknowledgement: (input) =>
          createRedisSecureMessagingStore({
            client: faultClient,
            deviceId: "device-1",
            durability: {
              mode: "aof",
              replicaFsyncs: 0,
              timeoutMilliseconds: 5_000,
            },
            tenantId: uncertaintyTenant,
          }).commit(input),
        resolveAuthoritativeStore: () =>
          createRedisSecureMessagingStore({
            client,
            deviceId: "device-1",
            durability: {
              mode: "aof",
              replicaFsyncs: 0,
              timeoutMilliseconds: 5_000,
            },
            tenantId: uncertaintyTenant,
          }),
      });
    expect(uncertainty.initialResolution).toBe("applied");
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
