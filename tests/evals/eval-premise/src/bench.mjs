// Eval Fixture 2: Cheated premise benchmark
// Seed defect: measures only hot cache queries after discarding cold cache requests.

export function runBenchmark() {
  const timings = [];
  // Simulate 100 queries: first 50 are slow (cold), next 50 are fast (hot)
  for (let i = 0; i < 100; i++) {
    const lat = i < 50 ? 150 : 2;
    // Cheat: discard cold cache measurements
    if (i >= 50) {
      timings.push(lat);
    }
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95)];
  return {p95, totalMeasured: timings.length};
}
