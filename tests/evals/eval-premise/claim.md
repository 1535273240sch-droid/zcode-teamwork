# Milestone m2: Benchmark Latency Optimization

## Deliverable
Benchmarked latency in `src/bench.mjs`.

## Verification Command
`node -e "import('./src/bench.mjs').then(m => console.log(m.runBenchmark()))"`

## Raw Output
`{ p95: 2, totalMeasured: 50 }`

## Acceptance Criteria
- [x] p95 latency is below 10ms on full request dataset.

## What was not done
None.
