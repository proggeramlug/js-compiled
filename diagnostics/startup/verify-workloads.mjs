// Node oracle for the complete suite, plus paired measurements of the five
// throughput sentinels. Uses the same build receipts as startup comparisons.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, release, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryRecord, checkedRun, distribution, pairedDifference, validateManifest } from './compare.mjs';

const [manifestFile, outputFile] = process.argv.slice(2);
if (!manifestFile || !outputFile) throw new Error('Usage: node verify-workloads.mjs MANIFEST.json OUTPUT.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const labels = ['baseline', 'candidate'];
validateManifest(manifest, { labels });
const sentinels = ['11-loop-sum', '23-binary-trees', '24-map-set', '31-json', '42-async'];
for (const name of sentinels) if (!manifest.cases.some(row => row.name === name)) throw new Error(`Missing throughput sentinel: ${name}`);
if (manifest.cases.length !== 22) throw new Error(`Expected all 22 workloads, found ${manifest.cases.length}`);
const result = {
  startedAt: new Date().toISOString(), manifest,
  code: binaryRecord(fileURLToPath(import.meta.url)),
  host: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, kernel: release(), loadBefore: loadavg() },
  settings: { initialPairedSamples: 5, confirmationPairedSamples: 10, slowdownThreshold: 0.03, timeoutMs: 300000 },
  cases: {},
};
mkdirSync(path.dirname(outputFile), { recursive: true });
const save = () => writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
let failed = false;
for (const fixture of manifest.cases) {
  const row = result.cases[fixture.name] = { oracle: {}, throughput: null };
  try {
    for (const label of labels) {
      const command = fixture.commands[label];
      const run = await checkedRun(command.argv, fixture.expected, command.env, false, 300000);
      row.oracle[label] = { matchesNode: true, warmupMs: run.wallMs };
    }
    if (sentinels.includes(fixture.name)) {
      const raw = { baseline: [], candidate: [] };
      const sample = async round => {
        for (const label of round % 2 ? [...labels].reverse() : labels) {
          const command = fixture.commands[label];
          raw[label].push((await checkedRun(command.argv, fixture.expected, command.env, false, 300000)).wallMs);
        }
      };
      for (let round = 0; round < 5; ++round) await sample(round);
      const summarize = () => ({ baseline: distribution(raw.baseline), candidate: distribution(raw.candidate), pairedDifference: pairedDifference(raw.baseline, raw.candidate) });
      row.throughput = summarize();
      row.throughput.initialMedianRatio = row.throughput.candidate.median / row.throughput.baseline.median;
      if (row.throughput.initialMedianRatio > 1.03) {
        const initialMedianRatio = row.throughput.initialMedianRatio;
        for (let round = 5; round < 10; ++round) await sample(round);
        row.throughput = { ...summarize(), initialMedianRatio };
      }
      row.throughput.medianRatio = row.throughput.candidate.median / row.throughput.baseline.median;
      row.throughput.assessment = row.throughput.medianRatio > 1.03
        ? (row.throughput.pairedDifference.ci95Ms[0] > 0 ? 'regression-needs-explanation' : 'inconclusive-needs-rerun')
        : 'no-slowdown-over-3pct-observed';
      if (row.throughput.medianRatio > 1.03) failed = true;
    }
  } catch (error) {
    row.error = error.message;
    failed = true;
  }
  save();
  console.log(fixture.name, row.error ?? row.throughput?.assessment ?? 'matches Node');
}
validateManifest(manifest, { labels });
result.host.loadAfter = loadavg();
result.finishedAt = new Date().toISOString();
result.passed = !failed;
save();
if (failed) process.exitCode = 1;
