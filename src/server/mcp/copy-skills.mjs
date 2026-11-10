import { cp } from 'node:fs/promises';

await cp(
  new URL('./skills/', import.meta.url),
  process.argv[2] ?? new URL('../dist/skills/', import.meta.url),
  { recursive: true },
);
