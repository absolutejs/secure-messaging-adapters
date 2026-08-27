# Security

These adapters persist sealed MLS state, replay metadata, encrypted delivery
frames, and routing metadata. They do not independently verify MLS messages and
do not make an unaudited messaging provider production-approved.

Bind each store instance to an authenticated tenant. Apply migrations and run
the published conformance drills before serving traffic. Back up the store with
the key material required to open sealed MLS state, and test restoration into
an isolated environment.

Never log sealed state, delivery frames, tenant IDs, conversation IDs, message
IDs, queue IDs, or database parameters. Report vulnerabilities privately using
GitHub Security Advisories for `absolutejs/secure-messaging-adapters`.
