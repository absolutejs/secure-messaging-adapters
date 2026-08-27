import type {
  SecureMessagingInboundReceipt,
  SecureMessagingInboundStatus,
  SecureMessagingOutboxEntry,
  SecureMessagingStore,
  SecureMessagingStoreCommitResult,
  SecureMessagingStoredConversation,
} from "@absolutejs/secure-messaging";

const encoder = new TextEncoder();
const MAXIMUM_IDENTIFIER_BYTES = 512;
const DEFAULT_MAXIMUM_STATE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_OUTBOX_BYTES = 2 * 1024 * 1024;

export type SecureMessagingPostgresQueryResult<Row> = {
  readonly rowCount: number;
  readonly rows: readonly Row[];
};

export type SecureMessagingPostgresTransaction = {
  readonly query: <Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ) => Promise<SecureMessagingPostgresQueryResult<Row>>;
};

export type SecureMessagingPostgresClient =
  SecureMessagingPostgresTransaction & {
    readonly transaction: <Result>(
      operation: (
        transaction: SecureMessagingPostgresTransaction,
      ) => Promise<Result>,
    ) => Promise<Result>;
  };

export type PostgresJsLike = {
  readonly begin: <Result>(
    operation: (transaction: PostgresJsQueryLike) => Promise<Result>,
  ) => Promise<Result>;
  readonly unsafe: <Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ) => Promise<readonly Row[] & { readonly count?: number }>;
};

export type PostgresJsQueryLike = Pick<PostgresJsLike, "unsafe">;

export type NodePostgresPoolLike = {
  readonly connect: () => Promise<NodePostgresPoolClientLike>;
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{
    readonly rowCount: number | null;
    readonly rows: readonly Row[];
  }>;
};

export type NodePostgresPoolClientLike = Pick<NodePostgresPoolLike, "query"> & {
  readonly release: () => void;
};

export type SecureMessagingPostgresStore = SecureMessagingStore & {
  readonly deleteExpiredInbound: (input: {
    readonly batchSize?: number;
    readonly now?: number;
  }) => Promise<number>;
};

export const SECURE_MESSAGING_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS absolute_secure_messaging_conversations (
  tenant_digest TEXT NOT NULL,
  conversation_digest TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  sealed_state BYTEA NOT NULL,
  security_mode TEXT NOT NULL CHECK (security_mode IN ('strict-e2ee', 'managed-recovery')),
  status TEXT NOT NULL CHECK (status IN ('active', 'pending-invitation')),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_digest, conversation_digest)
);

CREATE TABLE IF NOT EXISTS absolute_secure_messaging_inbound (
  tenant_digest TEXT NOT NULL,
  conversation_digest TEXT NOT NULL,
  message_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  save_token TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_digest, conversation_digest, message_digest),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS absolute_secure_messaging_inbound_expiry_idx
  ON absolute_secure_messaging_inbound (expires_at);

CREATE TABLE IF NOT EXISTS absolute_secure_messaging_outbox (
  tenant_digest TEXT NOT NULL,
  queue_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_digest, queue_digest),
  CHECK (octet_length(payload_json) BETWEEN 1 AND 2097152)
);
CREATE INDEX IF NOT EXISTS absolute_secure_messaging_outbox_order_idx
  ON absolute_secure_messaging_outbox (tenant_digest, created_at, queue_digest);
`.trim();

const RECORD_INBOUND = `
INSERT INTO absolute_secure_messaging_inbound
  (tenant_digest, conversation_digest, message_digest, payload_digest, expires_at, save_token, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_digest, conversation_digest, message_digest) DO UPDATE SET
  payload_digest = CASE
    WHEN absolute_secure_messaging_inbound.expires_at <= $7 THEN EXCLUDED.payload_digest
    ELSE absolute_secure_messaging_inbound.payload_digest
  END,
  expires_at = CASE
    WHEN absolute_secure_messaging_inbound.expires_at <= $7 THEN EXCLUDED.expires_at
    ELSE absolute_secure_messaging_inbound.expires_at
  END,
  save_token = CASE
    WHEN absolute_secure_messaging_inbound.expires_at <= $7 THEN EXCLUDED.save_token
    ELSE absolute_secure_messaging_inbound.save_token
  END,
  created_at = CASE
    WHEN absolute_secure_messaging_inbound.expires_at <= $7 THEN EXCLUDED.created_at
    ELSE absolute_secure_messaging_inbound.created_at
  END
RETURNING payload_digest, save_token
`.trim();

const DELETE_EXPIRED = `
DELETE FROM absolute_secure_messaging_inbound
WHERE ctid IN (
  SELECT ctid FROM absolute_secure_messaging_inbound
  WHERE expires_at <= $1 ORDER BY expires_at LIMIT $2
)
`.trim();

type StoredInboundRow = {
  readonly payload_digest: unknown;
  readonly save_token: unknown;
};

type StoredConversationRow = {
  readonly revision: unknown;
  readonly sealed_state: unknown;
  readonly security_mode: unknown;
  readonly status: unknown;
};

type StoredOutboxRow = { readonly payload_json: unknown };

class CommitConflict extends Error {
  readonly result: Exclude<SecureMessagingStoreCommitResult, "committed">;
  constructor(result: Exclude<SecureMessagingStoreCommitResult, "committed">) {
    super(result);
    this.result = result;
  }
}

const fail = (): never => {
  throw new Error("Secure messaging PostgreSQL store failed");
};

const postgresJsQuery =
  (client: PostgresJsQueryLike): SecureMessagingPostgresTransaction["query"] =>
  async <Row>(text: string, values: readonly unknown[]) => {
    const rows = await client.unsafe<Row>(text, values);
    return { rowCount: rows.count ?? rows.length, rows };
  };

export const createPostgresJsSecureMessagingClient = (
  value: unknown,
): SecureMessagingPostgresClient => {
  if (
    typeof value !== "function" ||
    !("unsafe" in value) ||
    typeof value.unsafe !== "function" ||
    !("begin" in value) ||
    typeof value.begin !== "function"
  )
    fail();
  const client = value as PostgresJsLike;
  return Object.freeze({
    query: postgresJsQuery(client),
    transaction: (operation) =>
      client.begin((transaction) =>
        operation({ query: postgresJsQuery(transaction) }),
      ),
  });
};

const nodePostgresQuery =
  (
    client: Pick<NodePostgresPoolLike, "query">,
  ): SecureMessagingPostgresTransaction["query"] =>
  async <Row>(text: string, values: readonly unknown[]) => {
    const result = await client.query<Row & Record<string, unknown>>(
      text,
      values,
    );
    return {
      rowCount: result.rowCount ?? result.rows.length,
      rows: result.rows,
    };
  };

export const createNodePostgresSecureMessagingClient = (
  value: unknown,
): SecureMessagingPostgresClient => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("query" in value) ||
    typeof value.query !== "function" ||
    !("connect" in value) ||
    typeof value.connect !== "function"
  )
    fail();
  const pool = value as NodePostgresPoolLike;
  return Object.freeze({
    query: nodePostgresQuery(pool),
    transaction: async (operation) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation({ query: nodePostgresQuery(client) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  });
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

const timestamp = (value: unknown) => {
  const parsed =
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(parsed)) fail();
  return parsed as number;
};

const bytes = (value: unknown, maximum: number) => {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > maximum
  )
    return fail();
  return Uint8Array.from(value as Uint8Array);
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

const randomToken = () =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

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
    bytes: base64urlEncode(bytes(entry.message.bytes, maximum)),
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
  payload: unknown,
  maximum: number,
): SecureMessagingOutboxEntry => {
  if (
    typeof payload !== "string" ||
    encoder.encode(payload).byteLength > maximum
  )
    return fail();
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
  maximumStateBytes: number,
) => {
  boundedIdentifier(value.conversationId);
  positiveLimit(value.revision);
  bytes(value.sealedState, maximumStateBytes);
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

const recordInbound = async (
  transaction: SecureMessagingPostgresTransaction,
  tenantDigest: string,
  receipt: SecureMessagingInboundReceipt,
  now: number,
) => {
  validateInbound(receipt, now);
  const token = randomToken();
  const result = await transaction.query<StoredInboundRow>(RECORD_INBOUND, [
    tenantDigest,
    await digest(receipt.conversationId),
    await digest(receipt.messageId),
    receipt.digest,
    receipt.expiresAt,
    token,
    now,
  ]);
  const row = result.rows[0] ?? fail();
  if (row.save_token === token) return "recorded" as const;
  if (typeof row.payload_digest !== "string") fail();
  return row.payload_digest === receipt.digest
    ? ("duplicate" as const)
    : ("conflict" as const);
};

export const createPostgresSecureMessagingStore = (options: {
  readonly client: SecureMessagingPostgresClient;
  readonly maximumOutboxBytes?: number;
  readonly maximumStateBytes?: number;
  readonly now?: () => number;
  readonly tenantId: string;
}): SecureMessagingPostgresStore => {
  boundedIdentifier(options.tenantId);
  const now = options.now ?? Date.now;
  const maximumOutboxBytes = positiveLimit(
    options.maximumOutboxBytes ?? DEFAULT_MAXIMUM_OUTBOX_BYTES,
  );
  const maximumStateBytes = positiveLimit(
    options.maximumStateBytes ?? DEFAULT_MAXIMUM_STATE_BYTES,
  );
  const tenantDigestPromise = digest(options.tenantId);

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
      const tenantDigest = await tenantDigestPromise;
      try {
        await options.client.transaction(async (transaction) => {
          if (inbound !== undefined) {
            const inboundResult = await recordInbound(
              transaction,
              tenantDigest,
              inbound,
              currentTime,
            );
            if (inboundResult === "conflict")
              throw new CommitConflict("replay-conflict");
          }
          const conversationDigest = await digest(conversation.conversationId);
          const stateResult =
            expectedRevision === undefined
              ? await transaction.query(
                  "INSERT INTO absolute_secure_messaging_conversations (tenant_digest, conversation_digest, revision, sealed_state, security_mode, status, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_digest, conversation_digest) DO NOTHING",
                  [
                    tenantDigest,
                    conversationDigest,
                    conversation.revision,
                    bytes(conversation.sealedState, maximumStateBytes),
                    conversation.securityMode,
                    conversation.status,
                    currentTime,
                  ],
                )
              : await transaction.query(
                  "UPDATE absolute_secure_messaging_conversations SET revision = $3, sealed_state = $4, security_mode = $5, status = $6, updated_at = $7 WHERE tenant_digest = $1 AND conversation_digest = $2 AND revision = $8",
                  [
                    tenantDigest,
                    conversationDigest,
                    conversation.revision,
                    bytes(conversation.sealedState, maximumStateBytes),
                    conversation.securityMode,
                    conversation.status,
                    currentTime,
                    expectedRevision,
                  ],
                );
          if (stateResult.rowCount !== 1)
            throw new CommitConflict("state-conflict");
          for (const entry of outbox) {
            const payload = serializeOutbox(entry, maximumOutboxBytes);
            const inserted = await transaction.query(
              "INSERT INTO absolute_secure_messaging_outbox (tenant_digest, queue_digest, payload_json, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_digest, queue_digest) DO NOTHING",
              [tenantDigest, await digest(entry.queueId), payload, currentTime],
            );
            if (inserted.rowCount === 0) {
              const existing = await transaction.query<StoredOutboxRow>(
                "SELECT payload_json FROM absolute_secure_messaging_outbox WHERE tenant_digest = $1 AND queue_digest = $2",
                [tenantDigest, await digest(entry.queueId)],
              );
              if (existing.rows[0]?.payload_json !== payload)
                throw new CommitConflict("state-conflict");
            }
          }
        });
        return "committed";
      } catch (error) {
        if (error instanceof CommitConflict) return error.result;
        throw error;
      }
    },
    deleteExpiredInbound: async ({
      batchSize = 1_000,
      now: suppliedNow,
    } = {}) => {
      if (
        !Number.isSafeInteger(batchSize) ||
        batchSize < 1 ||
        batchSize > 10_000
      )
        fail();
      const currentTime = suppliedNow ?? now();
      if (!Number.isSafeInteger(currentTime)) fail();
      const result = await options.client.query(DELETE_EXPIRED, [
        currentTime,
        batchSize,
      ]);
      return result.rowCount;
    },
    inspectInbound: async (receipt): Promise<SecureMessagingInboundStatus> => {
      boundedIdentifier(receipt.conversationId);
      boundedIdentifier(receipt.messageId);
      boundedIdentifier(receipt.digest);
      const result = await options.client.query<{
        readonly payload_digest: unknown;
      }>(
        "SELECT payload_digest FROM absolute_secure_messaging_inbound WHERE tenant_digest = $1 AND conversation_digest = $2 AND message_digest = $3 AND expires_at > $4",
        [
          await tenantDigestPromise,
          await digest(receipt.conversationId),
          await digest(receipt.messageId),
          now(),
        ],
      );
      const stored = result.rows[0]?.payload_digest;
      if (stored === undefined) return "new";
      if (typeof stored !== "string") fail();
      return stored === receipt.digest ? "duplicate" : "conflict";
    },
    listOutbox: async (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail();
      const result = await options.client.query<StoredOutboxRow>(
        "SELECT payload_json FROM absolute_secure_messaging_outbox WHERE tenant_digest = $1 ORDER BY created_at, queue_digest LIMIT $2",
        [await tenantDigestPromise, limit],
      );
      return Object.freeze(
        result.rows.map(({ payload_json }) =>
          deserializeOutbox(payload_json, maximumOutboxBytes),
        ),
      );
    },
    loadConversation: async (conversationId) => {
      boundedIdentifier(conversationId);
      const result = await options.client.query<StoredConversationRow>(
        "SELECT revision, sealed_state, security_mode, status FROM absolute_secure_messaging_conversations WHERE tenant_digest = $1 AND conversation_digest = $2",
        [await tenantDigestPromise, await digest(conversationId)],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const value: SecureMessagingStoredConversation = {
        conversationId,
        revision: timestamp(row.revision),
        sealedState: bytes(row.sealed_state, maximumStateBytes),
        securityMode:
          row.security_mode as SecureMessagingStoredConversation["securityMode"],
        status: row.status as SecureMessagingStoredConversation["status"],
      };
      validateConversation(value, maximumStateBytes);
      return Object.freeze(value);
    },
    recordInbound: async (receipt) =>
      recordInbound(options.client, await tenantDigestPromise, receipt, now()),
    removeConversation: async (conversationId, expectedRevision) => {
      boundedIdentifier(conversationId);
      positiveLimit(expectedRevision);
      const result = await options.client.query(
        "DELETE FROM absolute_secure_messaging_conversations WHERE tenant_digest = $1 AND conversation_digest = $2 AND revision = $3",
        [
          await tenantDigestPromise,
          await digest(conversationId),
          expectedRevision,
        ],
      );
      return result.rowCount === 1;
    },
    removeOutbox: async (queueIds) => {
      if (queueIds.length > 1_000) fail();
      if (queueIds.length === 0) return;
      const digests = await Promise.all(
        queueIds.map((queueId) => digest(boundedIdentifier(queueId))),
      );
      const placeholders = digests
        .map((_, index) => `$${index + 2}`)
        .join(", ");
      await options.client.query(
        `DELETE FROM absolute_secure_messaging_outbox WHERE tenant_digest = $1 AND queue_digest IN (${placeholders})`,
        [await tenantDigestPromise, ...digests],
      );
    },
  });
};
