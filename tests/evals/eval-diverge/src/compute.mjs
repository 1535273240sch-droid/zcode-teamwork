// Eval Fixture 3: Divergent evidence
// Seed defect: produces value 41 while worker claims it produces 42.

export function calculateSecret() {
  return 41;
}

if (process.argv[1] && process.argv[1].endsWith('compute.mjs')) {
  console.log(`result: ${calculateSecret()}`);
  process.exit(0);
}
