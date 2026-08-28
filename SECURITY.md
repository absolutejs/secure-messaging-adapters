# Security

These adapters persist sealed MLS state, replay metadata, encrypted delivery
frames, and routing metadata. They do not independently verify MLS messages and
do not make an unaudited messaging provider production-approved.

Bind each store instance to an authenticated tenant and device. Apply migrations and run
the published conformance drills before serving traffic. Back up the store with
the key material required to open sealed MLS state, and test restoration into
an isolated environment.

Never log sealed state, delivery frames, tenant IDs, conversation IDs, message
IDs, queue IDs, or database parameters. Report vulnerabilities privately using
GitHub Security Advisories for `absolutejs/secure-messaging-adapters`.

PostgreSQL operators must choose local-WAL or synchronous-replica acknowledgement
explicitly. Redis operators must choose an explicit acknowledgement mode; only
`WAITAOF` confirms local AOF persistence, and neither `WAIT` nor `WAITAOF` turns
Redis replication into a strongly consistent system. Treat acknowledgement
timeouts and lost connections as ambiguous commits and reload before retrying.
