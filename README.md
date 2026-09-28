# Serverless Idempotent Task API

Multi-tenant task service on AWS, written to the standard I would apply to
something on call.

- `POST /v1/tasks` creates a task **exactly once** per `Idempotency-Key`, under
  concurrency, retries and mid-flight crashes.
- Tenant scope comes from **verified JWT claims only**, never from the request.
- Everything, including alarms and least-privilege IAM, is **AWS CDK**.
- A React front end that stays correct when the tenant changes mid-request.

```
npm ci && npm run verify
```

## Idempotency under concurrency

Every concurrent caller races to insert one item:

```
pk = TENANT#<tenantId>
sk = IDEMPOTENCY#<key>

ConditionExpression:
  attribute_not_exists(pk)
  OR (#status = :inProgress AND #lease < :now AND #hash = :hash)
```

DynamoDB lets exactly one writer win. The winner creates the task and completes
the reservation in a single `TransactWriteItems`, so a crash can never leave a
`COMPLETED` marker without the task it points at. The transaction carries a
`ClientRequestToken`, so an SDK-level retry is a no-op rather than a second
application of the same writes.

Losers read the winner's record and get one of four answers:

| Situation                                    | Response                                     |
| -------------------------------------------- | -------------------------------------------- |
| Same key, same payload, winner finished      | `200` replay of the original body            |
| Same key, same payload, winner still running | `409 request_in_progress` with `Retry-After` |
| Same key, **different** payload              | `409 idempotency_key_reuse`                  |
| Winner died, lease expired, payload matches  | claim taken over, `201`                      |

The payload is hashed after canonical JSON serialisation, so a retry whose keys
serialise in a different order is recognised as the same request, not a
conflicting one.

Tenancy is part of the partition key, so two tenants may reuse the same
idempotency key without colliding.

### The lease is the interesting part

A naive implementation reserves the key and then completes it. If the handler
dies in between, from a timeout, an out-of-memory kill, a deploy or a throttle,
that key is locked for the full retention window. Every honest retry from the
client gets a conflict, for hours, and no task ever exists. The failure looks
like data loss to the caller and like nothing at all on the dashboard.

So the reservation carries `leaseExpiresAt`, set to well beyond the Lambda
timeout. While it is live, a second caller is told the request is in progress
and given a `Retry-After`. Once it passes, the holder cannot still be running,
and the next caller **with the identical payload** takes the claim over. A
different payload is still rejected, and a `COMPLETED` record is never taken
over however old it is.

`test/create-task.test.ts` covers all four paths, including an abandoned claim
simulated by failing the transaction mid-flight.

## Rolling deployments

Schema changes follow expand and contract:

1. **Expand** — add the new optional attribute. Old and new code both run.
2. **Backfill** — migrate existing items in the background, idempotently.
3. **Switch reads** — new code prefers the new attribute, still tolerating its absence.
4. **Contract** — only once no running version reads the old one.

API changes are additive within `/v1`. A breaking change gets `/v2`, and both
run side by side behind the same authorizer. Rollback is redeploying the
previous Lambda version, which stays safe because no step ever removes
something the previous version still needs.

Retries are safe by construction: the client keeps its `Idempotency-Key` across
attempts, so a retry through a rolling deploy replays rather than duplicates.
Authorization is re-evaluated on every attempt and never cached.

## Late responses in the UI

`src/web/search-controller.ts` holds the race logic, deliberately kept out of
React so the interesting behaviour is testable without a DOM.

Each search bumps a generation counter and aborts the previous
`AbortController`. A response or error whose generation is stale is discarded.
Results are cleared the instant the tenant changes, because showing one
tenant's rows under another tenant's header is a data leak, not a cosmetic
glitch.

## Production concerns

| Concern         | How it is handled                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration   | Validated at cold start. A missing variable kills init with a named error, not every request with a 500.                                                    |
| Input           | `zod` schemas with explicit length limits. Unknown fields are rejected, not dropped, so a client sending `tenantId` is told it had no effect.               |
| Body size       | Checked before parsing, returning `413` rather than failing at the DynamoDB item limit.                                                                     |
| Logging         | Structured JSON. The logger accepts only primitives and reduces errors to name, message and a bounded stack, so clinical data cannot be logged by accident. |
| Audit           | Every creation logs task id, tenant, actor and timestamp, and no task content.                                                                              |
| Error responses | Internal detail never leaves the process. Callers get a code, a message and a request id.                                                                   |
| Failures        | Dead letter queue with a 14 day retention, alarmed on depth.                                                                                                |
| Blast radius    | Reserved concurrency on the function, rate and burst throttling on the stage.                                                                               |
| Throttling      | Adaptive SDK retries with capped attempts and request timeouts below the Lambda timeout.                                                                    |
| Observability   | X-Ray tracing, plus alarms on errors, throttles, p99 latency, DLQ depth and table throttling.                                                               |
| Data durability | Table is `RETAIN` with point-in-time recovery. Logs are `RETAIN` for six months because they carry the audit trail.                                         |
| TTL safety      | Only idempotency records carry `expiresAt`. A regression test asserts task items never do, because a stray TTL attribute would silently delete real tasks.  |
| CORS            | Explicit origin list. A wildcard origin with credentials is asserted against in the stack tests.                                                            |
| IAM             | Read and write on one table. The stack test fails if a wildcard action appears.                                                                             |

## Verification

`npm run verify` runs lint, format check, types, tests with coverage
thresholds, and `cdk synth`. CI runs the same plus `npm audit` and, on pull
requests, `cdk diff` against the deployed stack.

62 tests across 8 suites: concurrency, crash recovery, tenant isolation,
authorization, validation, adapter behaviour, logging, configuration, UI races
and the infrastructure itself.

Jest transpiles with SWC rather than type-checking a second time, which took
the suite from about three minutes to under ten seconds.

## Layout

```
bin/app.ts                      CDK app entry, tags and environment wiring
lib/task-api-stack.ts           Table, Lambda, HTTP API, JWT authorizer, DLQ, alarms
src/lib/config.ts               Fail-fast environment validation
src/lib/logger.ts               Structured, PHI-safe logging
src/lib/schema.ts               Request schemas and hard limits
src/lib/auth.ts                 Tenant and scope from verified claims
src/lib/create-task-service.ts  Idempotency and lease logic, transport independent
src/lib/store.ts                Persistence port, conditional-write semantics explicit
src/lib/dynamo-store.ts         DynamoDB adapter, retries and error translation
src/handlers/create-task.ts     Lambda adapter
src/web/search-controller.ts    Race-safe search core
src/web/useTenantSearch.ts      React hook wrapping it
test/                           Unit, adapter and infrastructure tests
```

## Known gaps

Honest list of what is not here.

- No integration test against DynamoDB Local. The adapter is unit tested and
  the condition expression asserted, but nothing exercises real DynamoDB.
- Read and list endpoints are not implemented. Creation was the interesting
  problem.
- Single region. Multi-region would need global tables and a conflict story.
- No `cdk-nag` in the pipeline yet.
