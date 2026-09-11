import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { cpus } from 'node:os';

const dir = path.resolve('results/startup');
const variants = [
  ['plain-c', 'plain-c', 'RESULT 0\n'],
  ['perry-noop', 'perry-noop', 'RESULT 0\n'],
  ['scriptc-noop', 'scriptc-noop', 'RESULT 0\n'],
  ['perry-hello', 'perry-hello', 'hello, world\nRESULT 1\n'],
  ['scriptc-hello', 'scriptc-hello', 'hello, world\nRESULT 1\n'],
  ['perry-empty', 'perry-empty', ''],
  ['scriptc-empty', 'scriptc-empty', ''],
  ...[0, 1, 2, 4, 6, 8, 14].map(mode => [`probe-mode-${mode}`, 'perry-probe', 'RESULT 0\n', { PERRY_STARTUP_ABLATE: String(mode) }]),
].map(([name, file, output, env = {}]) => ({ name, file: path.join(dir, file), output, env }));

function run(argv, env = {}) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const p = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', b => { stdout += b; });
    p.stderr.on('data', b => { stderr += b; });
    const timeout = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.on('error', e => { clearTimeout(timeout); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`${argv[0]}: ${code}/${signal}: ${stderr}`));
      resolve({ ms: Number(process.hrtime.bigint() - start) / 1e6, stdout, stderr });
    });
  });
}
function summary(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * .9)], max: sorted.at(-1), samples: xs };
}
const result = { versions: JSON.parse(readFileSync(path.join(dir, 'versions.json'))), cpu: cpus()[0].model, samples: 100, variants: {} };
for (const v of variants) {
  result.variants[v.name] = { binaryBytes: statSync(v.file).size, wallMs: [], rssKiB: [] };
  for (let i = 0; i < 5; ++i) {
    const r = await run([v.file], v.env);
    if (r.stdout !== v.output) throw new Error(`${v.name}: unexpected output ${JSON.stringify(r.stdout)}`);
  }
}
const overhead = [];
// Rotate execution order across 100 rounds to reduce ordering/thermal bias.
for (let round = 0; round < 100; ++round) {
  overhead.push((await run(['/bin/true'])).ms);
  for (let i = 0; i < variants.length; ++i) {
    const v = variants[(i + round) % variants.length];
    const r = await run([v.file], v.env);
    if (r.stdout !== v.output) throw new Error(`${v.name}: changed output`);
    result.variants[v.name].wallMs.push(r.ms);
  }
}
for (const v of variants) {
  const row = result.variants[v.name];
  for (let i = 0; i < 5; ++i) {
    const r = await run(['/usr/bin/time', '-f', 'RSS_KIB=%M', '--', v.file], v.env);
    row.rssKiB.push(Number(/RSS_KIB=(\d+)/.exec(r.stderr)[1]));
  }
  row.wallMs = summary(row.wallMs);
  console.log(v.name, JSON.stringify({ medianMs: row.wallMs.median, minMs: row.wallMs.min, rssKiB: Math.max(...row.rssKiB), binaryBytes: row.binaryBytes }));
}
result.spawnOverheadMs = summary(overhead);
writeFileSync(path.join(dir, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
