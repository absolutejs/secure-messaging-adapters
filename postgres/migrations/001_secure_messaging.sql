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
