// Single source of truth for the npm-tarball file boundary.
//
// Two callers share it, so the boundary cannot drift between CI and release day:
//   * tests/packaging.test.ts imports it — the every-commit guard, which packs
//     the tarball and asserts the reports below are empty.
//   * bin/publish executes it as a script
//     (`npm pack --dry-run --json | node tests/_packaging_allowlists.mjs`)
//     against the tarball it is about to upload, and aborts on any violation.
//
// Both check the *packed file list*, never the `files` config that produced it,
// so an npm default change or an auto-included stray file is caught just as
// surely as a widened glob. Both directions are checked: an allow-list alone
// only catches a tarball that ships too much; a narrowed `files` entry that
// drops dist/ would sail through it, so there is also a required-file list.
//
// The leading underscore marks this as a private helper rather than a test module.

export const TARBALL_ALLOWED_RE = /^(dist\/|src\/|README\.md$|LICENSE$|package\.json$)/;

// One entry per artifact the exports map promises. A tarball missing any of
// these installs but breaks at import/require/CDN time.
export const TARBALL_REQUIRED = [
  'dist/index.mjs',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/abmeter.iife.min.js',
  'src/index.ts',
  'package.json',
  'README.md',
  'LICENSE',
];

// Redundant with the allow-list by construction, and deliberately so: naming
// the monorepo-only paths gives a specific, actionable error for the exact
// regressions this guard exists to catch.
export const TARBALL_FORBIDDEN_RE = /^(tests\/|bin\/|mise\.toml$|CLAUDE\.md$|eslint\.config\.js$|tsup\.config\.ts$|vitest\.config\.ts$|tsconfig\.json$)/;

export function tarballViolations(files) {
  const present = new Set(files);
  return {
    disallowed: files.filter((file) => !TARBALL_ALLOWED_RE.test(file)),
    forbidden: files.filter((file) => TARBALL_FORBIDDEN_RE.test(file)),
    missing: TARBALL_REQUIRED.filter((file) => !present.has(file)),
  };
}

// `npm pack --dry-run --json` output → the packed file paths.
export function filesFromPackJson(packJson) {
  const [report] = packJson;
  if (!report || !Array.isArray(report.files)) {
    throw new Error('unexpected `npm pack --json` output: no files array');
  }
  return report.files.map((file) => file.path);
}

function printViolations(header, files, hint) {
  console.error(`ERROR: ${header}`);
  for (const file of files) console.error(`  - ${file}`);
  console.error(hint);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const files = filesFromPackJson(JSON.parse(Buffer.concat(chunks).toString('utf8')));

  const report = tarballViolations(files);
  const hint = 'Fix the `files` allow-list in package.json.';
  let ok = true;

  if (report.disallowed.length > 0) {
    printViolations('tarball would ship files outside the allowed set:', report.disallowed, hint);
    ok = false;
  }
  if (report.forbidden.length > 0) {
    printViolations('tarball would ship monorepo-only paths:', report.forbidden, hint);
    ok = false;
  }
  if (report.missing.length > 0) {
    printViolations('tarball is missing required files:', report.missing, hint);
    ok = false;
  }

  if (!ok) {
    console.error('Aborting before upload.');
    process.exit(1);
  }
  console.log('OK - tarball contains only allowed files.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
