import type {
  SecureMessagingInboundReceipt,
  SecureMessagingOutboxEntry,
  SecureMessagingStore,
  SecureMessagingStoredConversation,
} from "@absolutejs/secure-messaging";

const encoder = new TextEncoder();
const MAXIMUM_IDENTIFIER_BYTES = 512;
const DEFAULT_MAXIMUM_STATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_OUTBOX_BYTES = 2 * 1024 * 1024;

export type SecureMessagingRedisClient = {
  readonly eval: (
    script: string,
    keys: readonly string[],
    arguments_: readonly string[],
  ) => Promise<unknown>;
  readonly get: (key: string) => Promise<string | null | undefined>;
  readonly hgetall: (key: string) => Promise<Record<string, string> | null>;
  readonly zrange: (
    key: string,
    start: number,
    stop: number,
  ) => Promise<readonly string[]>;
};

export type NodeRedisLike = {
  readonly eval: (
    script: string,
    options: {
      readonly arguments: readonly string[];
      readonly keys: readonly string[];
    },
  ) => Promise<unknown>;
  readonly get: (key: string) => Promise<string | null>;
  readonly hGetAll: (key: string) => Promise<Record<string, string>>;
  readonly zRange: (
    key: string,
    start: number,
    stop: number,
  ) => Promise<string[]>;
};

export type IoRedisLike = {
  readonly eval: (
    script: string,
    numberOfKeys: number,
    ...keysAndArguments: string[]
  ) => Promise<unknown>;
  readonly get: (key: string) => Promise<string | null>;
  readonly hgetall: (key: string) => Promise<Record<string, string>>;
  readonly zrange: (
    key: string,
    start: number,
    stop: number,
  ) => Promise<string[]>;
};

export const createNodeRedisSecureMessagingClient = (
  value: unknown,
): SecureMessagingRedisClient => {
  if (typeof value !== "object" || value === null) fail();
  const client = value as NodeRedisLike;
  if (
    typeof client.eval !== "function" ||
    typeof client.get !== "function" ||
    typeof client.hGetAll !== "function" ||
    typeof client.zRange !== "function"
  )
    fail();
  return Object.freeze({
    eval: (script, keys, arguments_) =>
      client.eval(script, { arguments: arguments_, keys }),
    get: (key) => client.get(key),
    hgetall: (key) => client.hGetAll(key),
    zrange: (key, start, stop) => client.zRange(key, start, stop),
  });
};

export const createIoRedisSecureMessagingClient = (
  value: unknown,
): SecureMessagingRedisClient => {
  if (typeof value !== "object" || value === null) fail();
  const client = value as IoRedisLike;
  if (
    typeof client.eval !== "function" ||
    typeof client.get !== "function" ||
    typeof client.hgetall !== "function" ||
    typeof client.zrange !== "function"
  )
    fail();
  return Object.freeze({
    eval: (script, keys, arguments_) =>
      client.eval(script, keys.length, ...keys, ...arguments_),
    get: (key) => client.get(key),
    hgetall: (key) => client.hgetall(key),
    zrange: (key, start, stop) => client.zrange(key, start, stop),
  });
};

export const SECURE_MESSAGING_REDIS_COMMIT_SCRIPT = `
local conversation_key = KEYS[1]
local outbox_index = KEYS[2]
local inbound_key = KEYS[3]
local expected_revision = ARGV[1]
local new_revision = ARGV[2]
local outbox_count = tonumber(ARGV[8])

local current_revision = redis.call('HGET', conversation_key, 'revision')
if expected_revision == '' then
  if current_revision then return 'state-conflict' end
else
  if current_revision ~= expected_revision then return 'state-conflict' end
end

if ARGV[6] == '1' then
  local prior_digest = redis.call('GET', inbound_key)
  if prior_digest and prior_digest ~= ARGV[7] then return 'replay-conflict' end
end

for index = 1, outbox_count do
  local payload = ARGV[8 + index]
  local prior_payload = redis.call('GET', KEYS[3 + index])
  if prior_payload and prior_payload ~= payload then return 'state-conflict' end
end

redis.call('HSET', conversation_key,
  'revision', new_revision,
  'sealed_state', ARGV[3],
  'security_mode', ARGV[4],
  'status', ARGV[5])
if ARGV[6] == '1' then
  redis.call('SET', inbound_key, ARGV[7], 'PXAT', ARGV[9 + outbox_count])
end
for index = 1, outbox_count do
  local payload_key = KEYS[3 + index]
  redis.call('SET', payload_key, ARGV[8 + index])
  redis.call('ZADD', outbox_index, ARGV[10 + outbox_count], payload_key)
end
return 'committed'
`.trim();

export const SECURE_MESSAGING_REDIS_RECORD_INBOUND_SCRIPT = `
local prior = redis.call('GET', KEYS[1])
if prior then
  if prior == ARGV[1] then return 'duplicate' end
  return 'conflict'
end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[2])
return 'recorded'
`.trim();

export const SECURE_MESSAGING_REDIS_REMOVE_CONVERSATION_SCRIPT = `
if redis.call('HGET', KEYS[1], 'revision') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`.trim();

export const SECURE_MESSAGING_REDIS_REMOVE_OUTBOX_SCRIPT = `
for index = 2, #KEYS do
  redis.call('DEL', KEYS[index])
  redis.call('ZREM', KEYS[1], KEYS[index])
end
return #KEYS - 1
`.trim();

const fail = (): never => {
  throw new Error("Secure messaging Redis store failed");
};

const boundedIdentifier = (value: string) => {
  if (
    value.length === 0 ||
    encoder.encode(value).byteLength > MAXIMUM_IDENTIFIER_BYTES
  )
    fail();
  return value;
};

const positiveLimit = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
};

const byteValue = (value: Uint8Array, maximum: number) => {
  if (value.byteLength === 0 || value.byteLength > maximum) fail();
  return Uint8Array.from(value);
};

const base64urlEncode = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64urlDecode = (value: unknown, maximum: number) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return fail();
  const encoded = value;
  try {
    const binary = atob(
      encoded.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (encoded.length % 4)) % 4),
    );
    const decoded = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (
      decoded.byteLength === 0 ||
      decoded.byteLength > maximum ||
      base64urlEncode(decoded) !== encoded
    )
      fail();
    return decoded;
  } catch {
    return fail();
  }
};

const digest = async (value: string) =>
  base64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
) => {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) fail();
};

const objectValue = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail();
  return value as Record<string, unknown>;
};

const serializeOutbox = (
  entry: SecureMessagingOutboxEntry,
  maximum: number,
) => {
  boundedIdentifier(entry.queueId);
  boundedIdentifier(entry.message.conversationId);
  boundedIdentifier(entry.message.id);
  const payload = JSON.stringify({
    bytes: base64urlEncode(byteValue(entry.message.bytes, maximum)),
    conversationId: entry.message.conversationId,
    id: entry.message.id,
    kind: entry.message.kind,
    ...(entry.message.recipientDeviceId === undefined
      ? {}
      : {
          recipientDeviceId: boundedIdentifier(entry.message.recipientDeviceId),
        }),
    queueId: entry.queueId,
  });
  if (encoder.encode(payload).byteLength > maximum) fail();
  return payload;
};

const deserializeOutbox = (
  payload: string,
  maximum: number,
): SecureMessagingOutboxEntry => {
  if (payload.length === 0 || encoder.encode(payload).byteLength > maximum)
    fail();
  try {
    const value = objectValue(JSON.parse(payload));
    exactKeys(value, [
      "bytes",
      "conversationId",
      "id",
      "kind",
      "recipientDeviceId",
      "queueId",
    ]);
    const conversationId = value.conversationId;
    const id = value.id;
    const kind = value.kind;
    const queueId = value.queueId;
    const recipientDeviceId = value.recipientDeviceId;
    if (
      typeof conversationId !== "string" ||
      typeof id !== "string" ||
      (kind !== "application" &&
        kind !== "commit" &&
        kind !== "proposal" &&
        kind !== "welcome") ||
      typeof queueId !== "string" ||
      (recipientDeviceId !== undefined && typeof recipientDeviceId !== "string")
    )
      return fail();
    return Object.freeze({
      message: Object.freeze({
        bytes: base64urlDecode(value.bytes, maximum),
        conversationId: boundedIdentifier(conversationId),
        id: boundedIdentifier(id),
        kind,
        ...(recipientDeviceId === undefined
          ? {}
          : { recipientDeviceId: boundedIdentifier(recipientDeviceId) }),
      }),
      queueId: boundedIdentifier(queueId),
    });
  } catch {
    return fail();
  }
};

const validateConversation = (
  value: SecureMessagingStoredConversation,
  maximum: number,
) => {
  boundedIdentifier(value.conversationId);
  positiveLimit(value.revision);
  byteValue(value.sealedState, maximum);
  if (
    (value.securityMode !== "strict-e2ee" &&
      value.securityMode !== "managed-recovery") ||
    (value.status !== "active" && value.status !== "pending-invitation")
  )
    fail();
};

const validateInbound = (value: SecureMessagingInboundReceipt, now: number) => {
  boundedIdentifier(value.conversationId);
  boundedIdentifier(value.messageId);
  boundedIdentifier(value.digest);
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) fail();
};

const resultValue = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
) => {
  if (typeof value === "string" && allowed.includes(value as Value))
    return value as Value;
  return fail();
};

export const createRedisSecureMessagingStore = (options: {
  readonly client: SecureMessagingRedisClient;
  readonly keyPrefix?: string;
  readonly maximumOutboxBytes?: number;
  readonly maximumStateBytes?: number;
  readonly now?: () => number;
  readonly deviceId: string;
  readonly tenantId: string;
}): SecureMessagingStore => {
  boundedIdentifier(options.tenantId);
  boundedIdentifier(options.deviceId);
  const prefix = options.keyPrefix ?? "absolute:secure-messaging:";
  if (prefix.length === 0 || prefix.length > 256 || prefix.includes("{"))
    fail();
  const now = options.now ?? Date.now;
  const maximumOutboxBytes = positiveLimit(
    options.maximumOutboxBytes ?? DEFAULT_MAXIMUM_OUTBOX_BYTES,
  );
  const maximumStateBytes = positiveLimit(
    options.maximumStateBytes ?? DEFAULT_MAXIMUM_STATE_BYTES,
  );
  const tenantDigestPromise = digest(
    JSON.stringify([options.tenantId, options.deviceId]),
  );
  const base = async () => `${prefix}{${await tenantDigestPromise}}`;
  const conversationKey = async (id: string) =>
    `${await base()}:conversation:${await digest(boundedIdentifier(id))}`;
  const inboundKey = async (conversationId: string, messageId: string) =>
    `${await base()}:inbound:${await digest(boundedIdentifier(conversationId))}:${await digest(boundedIdentifier(messageId))}`;
  const outboxIndex = async () => `${await base()}:outbox`;
  const outboxKey = async (queueId: string) =>
    `${await base()}:outbox-entry:${await digest(boundedIdentifier(queueId))}`;

  return Object.freeze({
    commit: async ({
      conversation,
      expectedRevision,
      inbound,
      outbox = [],
    }) => {
      validateConversation(conversation, maximumStateBytes);
      if (
        expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      )
        fail();
      if (outbox.length > 1_000) fail();
      const currentTime = now();
      if (inbound !== undefined) validateInbound(inbound, currentTime);
      const payloads = outbox.map((entry) =>
        serializeOutbox(entry, maximumOutboxBytes),
      );
      const keys = [
        await conversationKey(conversation.conversationId),
        await outboxIndex(),
        inbound === undefined
          ? await conversationKey(conversation.conversationId)
          : await inboundKey(inbound.conversationId, inbound.messageId),
        ...(await Promise.all(outbox.map(({ queueId }) => outboxKey(queueId)))),
      ];
      return resultValue(
        await options.client.eval(SECURE_MESSAGING_REDIS_COMMIT_SCRIPT, keys, [
          expectedRevision === undefined ? "" : String(expectedRevision),
          String(conversation.revision),
          base64urlEncode(
            byteValue(conversation.sealedState, maximumStateBytes),
          ),
          conversation.securityMode,
          conversation.status,
          inbound === undefined ? "0" : "1",
          inbound?.digest ?? "",
          String(outbox.length),
          ...payloads,
          String(inbound?.expiresAt ?? 0),
          String(currentTime),
        ]),
        ["committed", "replay-conflict", "state-conflict"] as const,
      );
    },
    inspectInbound: async (receipt) => {
      boundedIdentifier(receipt.digest);
      const prior = await options.client.get(
        await inboundKey(receipt.conversationId, receipt.messageId),
      );
      return prior === undefined || prior === null
        ? "new"
        : prior === receipt.digest
          ? "duplicate"
          : "conflict";
    },
    listOutbox: async (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail();
      const keys = await options.client.zrange(
        await outboxIndex(),
        0,
        limit - 1,
      );
      const entries: SecureMessagingOutboxEntry[] = [];
      for (const key of keys) {
        const payload = await options.client.get(key);
        if (payload !== undefined && payload !== null)
          entries.push(deserializeOutbox(payload, maximumOutboxBytes));
      }
      return Object.freeze(entries);
    },
    loadConversation: async (conversationId) => {
      const stored = await options.client.hgetall(
        await conversationKey(conversationId),
      );
      if (stored === null || Object.keys(stored).length === 0) return undefined;
      exactKeys(stored, [
        "revision",
        "sealed_state",
        "security_mode",
        "status",
      ]);
      const revision = Number(stored.revision);
      const value: SecureMessagingStoredConversation = {
        conversationId,
        revision,
        sealedState: base64urlDecode(stored.sealed_state, maximumStateBytes),
        securityMode:
          stored.security_mode as SecureMessagingStoredConversation["securityMode"],
        status: stored.status as SecureMessagingStoredConversation["status"],
      };
      validateConversation(value, maximumStateBytes);
      return Object.freeze(value);
    },
    recordInbound: async (receipt) => {
      const currentTime = now();
      validateInbound(receipt, currentTime);
      return resultValue(
        await options.client.eval(
          SECURE_MESSAGING_REDIS_RECORD_INBOUND_SCRIPT,
          [await inboundKey(receipt.conversationId, receipt.messageId)],
          [receipt.digest, String(receipt.expiresAt)],
        ),
        ["recorded", "duplicate", "conflict"] as const,
      );
    },
    removeConversation: async (conversationId, expectedRevision) => {
      positiveLimit(expectedRevision);
      return (
        (await options.client.eval(
          SECURE_MESSAGING_REDIS_REMOVE_CONVERSATION_SCRIPT,
          [await conversationKey(conversationId)],
          [String(expectedRevision)],
        )) === 1
      );
    },
    removeOutbox: async (queueIds) => {
      if (queueIds.length > 1_000) fail();
      if (queueIds.length === 0) return;
      await options.client.eval(
        SECURE_MESSAGING_REDIS_REMOVE_OUTBOX_SCRIPT,
        [await outboxIndex(), ...(await Promise.all(queueIds.map(outboxKey)))],
        [],
      );
    },
  });
};
