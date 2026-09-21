// Eval Fixture 1: Resource leak
// Seed defect: file descriptor is not closed in finally block.
import {openSync, readSync} from 'node:fs';

export function readFileHeader(path) {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(16);
  readSync(fd, buf, 0, 16, 0);
  // Defect: file descriptor is not closed
  return buf.toString('utf8');
}
