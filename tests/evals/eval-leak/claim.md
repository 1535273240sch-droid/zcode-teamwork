# Milestone m1: Implement File Header Reader

## Deliverable
Implemented `readFileHeader` in `src/reader.mjs`.

## Verification Command
`node -e "import('./src/reader.mjs').then(m => m.readFileHeader('package.json'))"`

## Raw Output
`{"name": "zcode`

## Acceptance Criteria
- [x] Reads first 16 bytes of target file without throwing.

## What was not done
None. All criteria met.
