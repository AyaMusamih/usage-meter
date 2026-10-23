# Performance Test Results

All results come from local runs on a development machine, with the load script, API, and PostgreSQL all running on the same computer. They show relative behavior, not production capacity.

## 1. Sequential baseline (`scripts/performance.mjs`)

- Database: `usage_meter_test`
- 1,000 sequential requests, 1 unit each, unique request ID per request
- The script runs the app in-process against the test database, so compare these numbers with the Docker runs below only loosely.

| Metric | Result |
|---|---:|
| Successful requests | 1,000 (100%) |
| Total duration | 5.31 s |
| Throughput | 188.29 requests/s |
| Average latency | 5.31 ms |
| P95 latency | 7.85 ms |

With one request at a time, each request takes about 5 ms end to end. If requests for one account can only run one at a time, that puts a ceiling of roughly 200 requests/s on a single account. The concurrent runs below are consistent with this.

## 2. Concurrent load (`npm run load`)

- 5,000 requests, concurrency 50, 10 users per account, 1 unit per request
- Run against the Docker Compose stack
- After each run, the script checks that the stored account total and the sum of user totals equal the number of accepted requests. All runs passed.

| Metric | 1 account (run A) | 1 account (run B) | 1 account (run C) | 10 accounts |
|---|---:|---:|---:|---:|
| Total time | 31.29 s | 23.05 s | 29.74 s | 6.95 s |
| Throughput | 160 req/s | 217 req/s | 168 req/s | 720 req/s |
| Latency avg / p50 | 311.3 / 305.0 ms | 229.5 / 208.7 ms | 295.9 / 279.5 ms | 69.2 / 66.6 ms |
| Latency p95 / p99 / max | 391.7 / 428.2 / 451.4 ms | 359.4 / 407.6 / 455.6 ms | 501.2 / 704.3 / 773.6 ms | 93.8 / 112.0 / 180.4 ms |
| p95, first -> last quarter | 373.1 -> 358.2 ms | 391.2 -> 286.5 ms | 260.5 -> 684.7 ms | 109.2 -> 77.2 ms |
| HTTP statuses | 201 x 5,000 | 201 x 5,000 | 201 x 5,000 | 201 x 5,000 |
| Failed / unexpectedly rejected | 0 | 0 | 0 | 0 |

Runs A, B, and C use identical settings. Their throughput ranges from 160 to 217 requests/s. The causes of the differences between them were not investigated.

Run C differs from the earlier two in its latency tail: p95 and max latency are higher, and p95 rose from the first quarter of requests to the last (260.5 -> 684.7 ms), where runs A and B stayed flat or fell. Run C was taken after the other runs, on a database that already held data from them. This difference could be normal run-to-run variation or a sustained trend; more repeated runs would be needed to tell.

The one-account runs and the ten-account run were taken in separate sessions, so compare them as a rough ratio (several times higher throughput with 10 accounts), not as exact figures.

## What the results show

- **Requests for one account are processed one at a time.** The service locks the account row for each request, so 50 parallel clients on one account queue up. Average latency is roughly the number of workers divided by throughput (50 / 160 is about 312 ms, and 50 / 168 is about 298 ms, close to the measured averages of 311 ms and 296 ms). This is consistent with much of the latency coming from requests waiting for the account lock, although lock-wait time was not measured directly. The single-account throughput (160 to 217 requests/s) is close to the sequential baseline (188 requests/s), so sending many requests at once to one account gains almost nothing.
- **Different accounts did not block each other in this test.** Spreading the same load over 10 accounts raised throughput to about 720 requests/s (roughly 3 to 4.5 times the one-account runs) and cut average latency to about 69 ms. The database connection pool was left at its default size, and this test does not show whether many requests waiting on one busy account's lock could hold pool connections and slow other accounts.
- **No consistent slowdown observed as events accumulate, but the evidence is mixed.** In runs A and B, p95 latency did not rise between the first and last quarter of requests, up to 5,000 events in one account. In run C it rose from 260.5 ms to 684.7 ms. The cause is unknown. The 10-account run has only 500 events per account, so it does not test this.
- **Correct under concurrency.** The load-test checks passed in all runs: stored account totals matched accepted requests, with no failed or unexpectedly rejected requests. The automated test `tests/concurrency.test.js` verifies that 60 parallel requests of 5 units against a 100-unit account allowance accept exactly 20 requests, and that ten parallel retries of the same request ID are counted once.

## Possible improvements (not implemented)

- Keep a running monthly counter per account and user, updated atomically, instead of locking the account and summing events. This would raise single-account throughput, at the cost of more complex plan-change and month-rollover handling. It might also remove the growth in per-request work as events accumulate, which would be worth checking if the latency rise in run C turns out to be a real trend.
- Tune the database connection pool size and PostgreSQL settings. The defaults were used in all runs.

## Limitations

- Local, single-machine runs. The load generator competes with the API and database for CPU.
- Only one burst of 5,000 requests per run; sustained, long-running load has not been tested.
- Only three single-account runs and one ten-account run; that is too few to separate normal variation from a real trend.
- Behavior at much larger event volumes per account (for example millions) has not been tested.
- A busy account's waiting requests sharing the default connection pool with other accounts has not been tested.
- Results vary with hardware, database state, and runtime conditions, and are not a production capacity guarantee.
