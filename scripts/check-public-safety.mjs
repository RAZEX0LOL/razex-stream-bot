import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skippedDirectories = new Set(['.git', '.data', 'node_modules', 'coverage']);
const forbiddenNames = new Set(['.env', 'config.json', 'tokens.json', 'secrets.json']);
const forbiddenExtensions = new Set(['.exe', '.pem', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db']);
const productionDomain = 'razex' + '.online';
const patterns = [
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['Twitch OAuth token', /oauth:[a-z0-9]{20,}/i],
  ['Telegram bot token', /\b[0-9]{8,10}:[A-Za-z0-9_-]{30,}\b/],
  ['Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{20,}/i],
  ['production domain', new RegExp(productionDomain.replace('.', '\\.'), 'i')],
  ['local developer path', /\/Users\/[A-Za-z0-9._-]+\//]
];

const failures = [];
let checkedFiles = 0;

walk(root);

if (failures.length > 0) {
  console.error('Public-safety check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-safety check passed (${checkedFiles} text files checked).`);

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute) || entry.name;

    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;

    if (forbiddenNames.has(entry.name)) failures.push(`${relative}: private configuration filename`);
    if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
      failures.push(`${relative}: binary or private-data extension`);
    }
    const stat = fs.statSync(absolute);
    if (stat.size > 5 * 1024 * 1024) failures.push(`${relative}: file is larger than 5 MiB`);
    if (stat.size > 2 * 1024 * 1024) continue;

    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    checkedFiles += 1;
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) failures.push(`${relative}: ${label}`);
    }
  }
}
