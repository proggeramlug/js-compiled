import json
import os
import pathlib
import re
import subprocess

ROOT = pathlib.Path.cwd()
OUT = ROOT / 'results' / 'startup'
OUT.mkdir(parents=True, exist_ok=True)
PERRY = str(ROOT / 'node_modules' / '.bin' / 'perry')
SCRIPTC = str(ROOT / 'node_modules' / '.bin' / 'scriptc')

def run(args, log, env=None, required=True):
    r = subprocess.run([str(a) for a in args], capture_output=True, text=True, env={**os.environ, **(env or {})}, timeout=180)
    (OUT / log).write_text(r.stdout + r.stderr)
    if required and r.returncode:
        raise RuntimeError(f'{args}: {r.returncode}\n{r.stderr[-4000:]}')
    return r

(OUT / 'empty.ts').write_text('// A genuinely empty program, separate from the RESULT-printing benchmark.\n')
(OUT / 'plain.c').write_text('#include <stdio.h>\nint main(void) { puts("RESULT 0"); return 0; }\n')
run(['cc', '-O2', OUT / 'plain.c', '-o', OUT / 'plain-c'], 'plain-build.log')

for name, src in [('noop', ROOT / 'benches' / '00-noop.ts'), ('hello', ROOT / 'benches' / '01-hello.ts'), ('empty', OUT / 'empty.ts')]:
    run([PERRY, 'compile', src, '--no-cache', '--keep-intermediates', '-v', '-o', OUT / f'perry-{name}'], f'perry-{name}-build.log', {'PERRY_LINK_MAP': str(OUT / f'perry-{name}.map')})
    run([SCRIPTC, 'build', src, '-o', OUT / f'scriptc-{name}'], f'scriptc-{name}-build.log')

source = (ROOT / 'diagnostics/startup/probe.c').read_text()
names = re.findall(r'(?:VOID0|INT0)\((js_\w+),', source) + re.findall(r'__wrap_(js_\w+)\(', source) + ['main']
run(['cc', '-O2', '-fno-omit-frame-pointer', '-c', ROOT / 'diagnostics/startup/probe.c', '-o', OUT / 'probe.o'], 'probe-build.log')
extra = [str(OUT / 'probe.o')] + [f'-Wl,--wrap={name}' for name in names]
run([PERRY, 'compile', ROOT / 'benches/00-noop.ts', '--no-cache', '--keep-intermediates', '--report-size', '-v', '-o', OUT / 'perry-probe'], 'probe-link.log', {'PERRY_EXTRA_LINK_ARGS': ' '.join(extra)})
run([PERRY, 'compile', ROOT / 'benches/00-noop.ts', '--no-cache', '-v', '-o', OUT / 'perry-relr'], 'relr-link.log', {'PERRY_EXTRA_LINK_ARGS': '-Wl,-z,pack-relative-relocs'})

for name in ['perry-noop', 'perry-hello', 'perry-empty', 'perry-probe', 'scriptc-noop', 'plain-c']:
    binary = OUT / name
    run(['readelf', '-lW', '-SW', '-dW', binary], f'{name}-elf.txt')
    run(['readelf', '-rW', binary], f'{name}-relocations.txt')
    run(['ldd', binary], f'{name}-ldd.txt')
    run(['strace', '-f', '-c', binary], f'{name}-strace-summary.txt')
    run(['strace', '-f', '-tt', '-o', OUT / f'{name}-strace.txt', binary], f'{name}-strace-output.txt')
    run([binary], f'{name}-loader.txt', {'LD_DEBUG': 'statistics'})

for mode in [0, 1, 2, 4, 6, 8, 14]:
    run([OUT / 'perry-probe'], f'probe-mode-{mode}.txt', {'PERRY_STARTUP_TRACE': '1', 'PERRY_STARTUP_ABLATE': str(mode)}, required=mode == 0)

for name, env in [
    ('no-thp', {'MIMALLOC_ALLOW_THP': '0'}),
    ('no-arena', {'MIMALLOC_DISALLOW_ARENA_ALLOC': '1'}),
    ('no-eager', {'MIMALLOC_ARENA_EAGER_COMMIT': '0'}),
]:
    run([OUT / 'perry-probe'], f'probe-{name}.txt', {'PERRY_STARTUP_TRACE': '1', **env})
    run(['strace', '-f', '-o', OUT / f'perry-{name}-strace.txt', OUT / 'perry-noop'], f'perry-{name}-strace-output.txt', env)
    run([OUT / 'perry-noop'], f'mimalloc-{name}.txt', {'MIMALLOC_VERBOSE': '1', 'MIMALLOC_SHOW_STATS': '1', **env})
run([OUT / 'perry-noop'], 'mimalloc-default.txt', {'MIMALLOC_VERBOSE': '1', 'MIMALLOC_SHOW_STATS': '1'})
run([OUT / 'perry-relr'], 'perry-relr-loader.txt', {'LD_DEBUG': 'statistics'})
run(['readelf', '-dW', OUT / 'perry-relr'], 'perry-relr-elf.txt')

(OUT / 'versions.json').write_text(json.dumps({
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'perry': subprocess.check_output([PERRY, '--version'], text=True).strip(),
    'scriptc': subprocess.check_output([SCRIPTC, '--version'], text=True).strip(),
    'commit': os.environ.get('GITHUB_SHA'),
    'uname': subprocess.check_output(['uname', '-a'], text=True).strip(),
}, indent=2))
