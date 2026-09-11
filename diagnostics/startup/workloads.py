"""Check allocator tradeoffs on unchanged workloads, with a Node output oracle."""
import json
import os
import pathlib
import subprocess
import time

root = pathlib.Path.cwd()
out = root / 'results/startup'
perry = root / 'node_modules/.bin/perry'
results = {}

def run(args, env=None):
    start = time.perf_counter()
    result = subprocess.run([str(a) for a in args], env={**os.environ, **(env or {})}, capture_output=True, text=True, timeout=180, check=True)
    return result, (time.perf_counter() - start) * 1000

for name in ['11-loop-sum', '23-binary-trees', '24-map-set', '31-json', '42-async']:
    src = root / 'benches' / (name + '.ts')
    binary = out / ('workload-' + name)
    built, _ = run([perry, 'compile', src, '--no-cache', '-o', binary])
    (out / (name + '-build.log')).write_text(built.stdout + built.stderr)
    reference, _ = run(['node', src])
    row = {'expected': reference.stdout, 'default': [], 'no-thp': []}
    settings = [('default', {}), ('no-thp', {'MIMALLOC_ALLOW_THP': '0'})]
    for label, env in settings:
        warm, _ = run([binary], env)
        assert warm.stdout == reference.stdout, (name, label, warm.stdout, reference.stdout)
    for round_number in range(3):
        for label, env in settings[::1 if round_number % 2 == 0 else -1]:
            measured, elapsed = run(['/usr/bin/time', '-f', 'RSS_KIB=%M', '--', binary], env)
            assert measured.stdout == reference.stdout, (name, label, measured.stdout, reference.stdout)
            rss = int(measured.stderr.rsplit('RSS_KIB=', 1)[1].strip())
            row[label].append({'wallMs': elapsed, 'rssKiB': rss})
    results[name] = row
    (out / 'workloads.json').write_text(json.dumps(results, indent=2) + '\n')
    print(name, json.dumps(row), flush=True)
