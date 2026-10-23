# Performance Test Results

All results come from local runs on a development machine, with the load script, API, and PostgreSQL all running on the same computer. They show relative behavior, not production capacity.

## 1. Sequential baseline (`scripts/performance.mjs`)

- Database: `usage_meter_test`
- 1,000 sequential requests, 1 unit each, unique request ID per request

| Metric | Result |
|---|---:|
| Successful requests | 1,000 (100%) |
| Total duration | 5.31 s |
| Throughput | 188.29 requests/s |
| Average latency | 5.31 ms |
| P95 latency | 7.85 ms |

With one request at a time, each request takes about 5 ms end to end.

## 2. Concurrent load (`npm run load`)

- 5,000 requests, concurrency 50, 10 users per account, 1 unit per request
- Run against the Docker Compose stack
- After each run, the script checks that the stored account total and the sum of user totals equal the number of accepted requests. All runs passed.

| Metric | 1 account (run A) | 1 account (run B) | 10 accounts |
|---|---:|---:|---:|
| Total time | 31.29 s | 23.05 s | 5.27 s |
| Throughput | 160 req/s | 217 req/s | 950 req/s |
| Latency avg / p50 | 311.3 / 305.0 ms | 229.5 / 208.7 ms | 52.4 / 51.5 ms |
| Latency p95 / p99 / max | 391.7 / 428.2 / 451.4 ms | 359.4 / 407.6 / 455.6 ms | 62.4 / 68.4 / 76.6 ms |
| p95, first -> last quarter | 373.1 -> 358.2 ms | 391.2 -> 286.5 ms | 65.3 -> 65.3 ms |
| HTTP statuses | 201 x 5,000 | 201 x 5,000 | 201 x 5,000 |
| Failed / unexpectedly rejected | 0 | 0 | 0 |

Runs A and B use identical settings; the difference between them is normal run-to-run variation on a local machine.

## What the results show

- **Requests for one account are processed one at a time.** The service locks the account row for each request, so 50 parallel clients on one account queue up. Average latency is roughly the number of workers divided by throughput (50 / 160 is about 311 ms), so most of the latency is waiting for the lock, not query time.
- **Different accounts do not block each other.** Spreading the same load over 10 accounts raised throughput to 950 requests/s and cut average latency to about 52 ms.
- **No slowdown as events accumulate.** In the single-account runs, p95 latency did not rise between the first and last quarter of requests, up to 5,000 events in one account. The 10-account run has only 500 events per account, so it does not test this.
- **Correct under concurrency.** Stored totals matched accepted requests in every run, and no request was lost, double-counted, or wrongly rejected.

## Limitations

- Local, single-machine runs. The load generator competes with the API and database for CPU.
- Only one burst of 5,000 requests per run; sustained, long-running load has not been tested.
- Behavior at much larger event volumes per account (for example millions) has not been tested.
- Results vary with hardware, database state, and runtime conditions, and are not a production capacity guarantee.
