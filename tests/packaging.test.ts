// @vitest-environment node
//
// Tarball content + bundle-size guard, the JS mirror of
// sdk-python/tests/test_packaging.py. Builds dist/ with tsup, walks
// `npm pack --dry-run --json`, and checks the file list against
// tests/_packaging_allowlists.mjs — the same module bin/publish runs against
// the tarball it is about to upload. A widened `files` glob therefore fails in
// PR CI rather than on release day.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { filesFromPackJson, tarballViolations } from './_packaging_allowlists.mjs';

const SDK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_CORE_GZIP_BYTES = 9 * 1024;

let files: string[];

beforeAll(() => {
  execFileSync('npx', ['tsup'], { cwd: SDK_ROOT, stdio: 'pipe' });
  const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: SDK_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  files = filesFromPackJson(JSON.parse(packOutput));
});

describe('npm tarball boundary', () => {
  it('ships only dist/, src/, README.md, LICENSE, package.json', () => {
    expect(tarballViolations(files).disallowed).toEqual([]);
  });

  it('excludes monorepo-only paths', () => {
    expect(tarballViolations(files).forbidden).toEqual([]);
  });

  it('contains every artifact the exports map promises', () => {
    expect(tarballViolations(files).missing).toEqual([]);
  });
});

describe('bundle size', () => {
  it(`keeps the core ESM bundle under ${MAX_CORE_GZIP_BYTES / 1024} KB gzipped`, () => {
    const bundle = readFileSync(`${SDK_ROOT}/dist/index.mjs`);
    const gzipped = gzipSync(bundle, { level: 9 }).byteLength;
    expect(gzipped).toBeLessThanOrEqual(MAX_CORE_GZIP_BYTES);
  });
});
