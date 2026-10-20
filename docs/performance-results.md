# Performance Test Results

## Test Environment

- Application: Usage Meter API
- Database: PostgreSQL test database (`usage_meter_test`)
- Runtime: Node.js v24.21.0
- Test type: Sequential HTTP requests
- Test script: `scripts/performance.mjs`
- Number of requests: 1,000
- Units recorded per request: 1

## Results

| Metric | Result |
|---|---:|
| Total requests | 1,000 |
| Successful requests | 1,000 |
| Failed requests | 0 |
| Success rate | 100% |
| Total duration | 5.31 seconds |
| Throughput | 188.29 requests/second |
| Average latency | 5.31 ms |
| P95 latency | 7.85 ms |

## Methodology

The test created a dedicated test account, a user plan, and a test user. It then sent 1,000 sequential HTTP requests to the usage-recording endpoint, using a unique request ID for each request. The test used the separate `usage_meter_test` database.

## Limitations

This was a sequential baseline test on a local development environment. It does not measure concurrent load, production performance, or behavior under sustained high traffic. Results may vary with hardware, database state, and runtime conditions.

The reported figures describe this specific run and should not be treated as a production capacity guarantee.
