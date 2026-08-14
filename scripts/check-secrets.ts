/**
 * Stage-5 secrets check (spec §15 / acceptance criterion 7):
 * scans the built client bundle and web source for leaked secrets or
 * provider env-var names that should never appear client-side.
 *
 * Usage: npm run check:secrets
 * Exit code 0 = clean, 1 = findings.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['apps/web/dist', 'apps/web/src'];

// A "secret-looking" assignment: key followed by a value of decent length.
const SECRET_PATTERN =
  /(api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*["'][^"']{12,}["']/i;
// Provider env-var names must never leak into the client bundle.
const ENV_PATTERN =
  /\b(BINANCE|KRAKEN|COINBASE|GEMINI|BITSTAMP|SWISSQUOTE)_(API|SECRET|KEY|TOKEN|PRIVATE)[A-Z_]*\b/;

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ico', '.map']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && !BINARY_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

let findings = 0;
for (const dir of SCAN_DIRS) {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Minified bundles are one line; report the file rather than a giant slice.
    const secretMatch = content.match(SECRET_PATTERN);
    const envMatch = content.match(ENV_PATTERN);
    if (secretMatch != null) {
      findings += 1;
      console.log(`⚠️  ${path.relative(ROOT, file)}: possible secret pattern (${secretMatch[0].slice(0, 60)}…)`);
    }
    if (envMatch != null) {
      findings += 1;
      console.log(`⚠️  ${path.relative(ROOT, file)}: provider env-var name leaked (${envMatch[0]})`);
    }
  }
}

if (findings > 0) {
  console.error(`\n✖ secrets check FAILED — ${findings} finding(s)`);
  process.exit(1);
}
console.log('✔ secrets check clean: no secret patterns or provider env-var names in the client');
