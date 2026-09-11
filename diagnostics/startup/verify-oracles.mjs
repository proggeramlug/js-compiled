// Correctness-only local gate when concurrent builds make timing unsuitable.
import { readFileSync, writeFileSync } from 'node:fs';
import { checkedRun, validateManifest } from './compare.mjs';

const [manifestFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: verify-oracles.mjs MANIFEST OUTPUT');
const manifest = JSON.parse(readFileSync(manifestFile));
const labels = ['baseline', 'candidate'];
validateManifest(manifest, { labels });
if (manifest.cases.length !== 22) throw new Error('All 22 benchmarks are required');
const result = { manifest, cases: {}, complete: false, passed: true };
for (const fixture of manifest.cases) {
  const row = result.cases[fixture.name] = {};
  for (const label of labels) {
    try {
      const command = fixture.commands[label];
      const run = await checkedRun(command.argv, fixture.expected, command.env, false, 300000);
      row[label] = { matchesNode: true, wallMs: run.wallMs };
    } catch (error) {
      row[label] = { error: error.message };
      result.passed = false;
    }
  }
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
  console.log(fixture.name, Object.values(row).every(v => v.matchesNode) ? 'passed' : 'FAILED');
}
validateManifest(manifest, { labels });
result.complete = true;
writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
if (!result.passed) process.exitCode = 1;
