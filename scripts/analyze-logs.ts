import * as fs from 'fs';
import * as path from 'path';

const logPath = path.join(__dirname, '..', 'logs', 'requests.log');
const content = fs.readFileSync(logPath, 'utf-8');

// Try to parse as NDJSON (one JSON per line) or handle multi-line JSON objects
const entries: any[] = [];
const lines = content.split('\n');

let buffer = '';
let braceCount = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  
  // Try single-line NDJSON first
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      entries.push(JSON.parse(line));
      continue;
    } catch {}
  }
  
  // Multi-line JSON accumulation
  buffer += line + '\n';
  braceCount += (line.match(/{/g) || []).length;
  braceCount -= (line.match(/}/g) || []).length;
  
  if (braceCount === 0 && buffer.trim()) {
    try {
      entries.push(JSON.parse(buffer));
    } catch {}
    buffer = '';
  }
}

console.log(`Total entries parsed: ${entries.length}`);

// Group by label
const byLabel: Record<string, any[]> = {};
for (const e of entries) {
  const label = e.label || 'unknown';
  if (!byLabel[label]) byLabel[label] = [];
  byLabel[label].push(e);
}

console.log('\n--- Entry counts by label ---');
for (const [label, arr] of Object.entries(byLabel)) {
  console.log(`  ${label}: ${arr.length}`);
}

// Show response-error and response-exception entries in full
console.log('\n--- Response Errors ---');
const errors = byLabel['response-error'] || [];
for (const e of errors) {
  console.log(JSON.stringify(e, null, 2));
}

console.log('\n--- Response Exceptions ---');
const exceptions = byLabel['response-exception'] || [];
for (const e of exceptions) {
  console.log(JSON.stringify(e, null, 2));
}

// Show forced-max-tokens summaries
console.log('\n--- Forced Max Tokens (last 5) ---');
const forced = byLabel['forced-max-tokens'] || [];
for (const e of forced.slice(-5)) {
  console.log(`  ${e.ts}: original=${e.payload?.originalMaxTokens}, forced=${e.payload?.forcedMaxTokens}`);
}

// Show incoming-request summaries (last 5)
console.log('\n--- Incoming Requests (last 5 summaries) ---');
const incoming = byLabel['incoming-request'] || [];
for (const e of incoming.slice(-5)) {
  const p = e.payload || {};
  console.log(`  ${e.ts}: model=${p.model}, hasThinking=${p.hasThinking}, toolsCount=${p.toolsCount}, stream=${p.stream}`);
}

