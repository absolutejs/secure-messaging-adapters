# Security

Use one adapter instance per authenticated tenant. Use TLS, least-privilege
database roles, encrypted storage, tested backups, and point-in-time recovery.
Never construct a tenant from message-controlled data.

The transaction implementation supplied to this package must roll back when its
callback throws. Direct clients that cannot guarantee this are unsupported.
Alert on state and replay conflicts, migration drift, cleanup lag, and backup
restore failures.

The database stores sealed MLS state and encrypted delivery frames, but it also
observes timing, sizes, and routing metadata. Treat database access as sensitive.
