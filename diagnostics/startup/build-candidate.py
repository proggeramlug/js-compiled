"""Build an isolated runtime experiment, retaining immutable archive receipts.

The two source checkouts must already exist. Build each compiler and its
archives together: Perry rejects an archive with a different source identity,
even for a runtime-only change. Every flag and artifact hash is recorded.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('baseline')
parser.add_argument('candidate')
parser.add_argument('output')
args = parser.parse_args()
root = pathlib.Path.cwd()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
target = out / 'cargo-target'
receipt = {'variants': {}, 'commands': []}
env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PERRY_', 'MIMALLOC_', 'CARGO_PROFILE_'))
       and k not in ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_TARGET_DIR')}
env['CARGO_TARGET_DIR'] = str(target)

def save():
    (out / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

def run(argv, cwd, name):
    receipt['commands'].append({'argv': argv, 'cwd': str(cwd), 'log': name})
    save()
    print(name, flush=True)
    with (out / name).open('w') as log:
        subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)

def record(file):
    return {'file': str(file), 'bytes': file.stat().st_size,
            'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}

receipt['rustc'] = subprocess.check_output(['rustc', '-Vv'], cwd=args.baseline, env=env, text=True)
llvm_prefix = env.get('LLVM_SYS_221_PREFIX')
receipt['llvm'] = {'prefix': llvm_prefix, 'version': subprocess.check_output(
    [str(pathlib.Path(llvm_prefix) / 'bin/llvm-config') if llvm_prefix else 'llvm-config', '--version'],
    env=env, text=True).strip()}
config = {'compileArgs': ['--no-auto-optimize'], 'variants': {}}
for label, directory in [('baseline', args.baseline), ('candidate', args.candidate)]:
    source = pathlib.Path(directory).resolve()
    destination = out / label
    destination.mkdir(exist_ok=True)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source):
        raise RuntimeError(f'{label} checkout must be clean')
    receipt['variants'][label] = {'source': str(source), 'commit': commit, 'libraries': []}
    run(['cargo', 'build', '--locked', '--profile', 'perry-dev', '-p', 'perry'], source, f'{label}-compiler.log')
    compiler = destination / 'perry'
    shutil.copy2(target / 'perry-dev/perry', compiler)
    receipt['variants'][label]['compiler'] = record(compiler)
    # Separate Cargo invocations match packaging's runtime-only feature graph.
    # Copy the first archive before the stdlib invocation unifies its features.
    for package, archive in [('perry-runtime-static', 'libperry_runtime.a'), ('perry-stdlib-static', 'libperry_stdlib.a')]:
        run(['cargo', 'build', '--locked', '--release', '-p', package], source, f'{label}-{package}.log')
        shutil.copy2(target / 'release' / archive, destination / archive)
        receipt['variants'][label]['libraries'].append(record(destination / archive))
        save()
    config['variants'][label] = {
        'compiler': str(compiler),
        'buildEnv': {'PERRY_WORKSPACE_ROOT': str(source), 'PERRY_LIB_DIR': str(destination)},
        'runtimeEnv': {},
    }
(out / 'startup-config.json').write_text(json.dumps(config, indent=2) + '\n')
config['cases'] = [str(p) for p in sorted((root / 'benches').glob('*.ts'))]
config['scriptc'] = False
(out / 'workloads-config.json').write_text(json.dumps(config, indent=2) + '\n')
fixtures = pathlib.Path(args.candidate).resolve() / 'test-files'
names = [
    'test_gap_startup_empty_checkpoint_before_exit.ts',
    'test_gap_startup_empty_checkpoint_timing.ts',
    'test_gap_startup_before_exit_microtasks_only.ts',
    'test_gap_startup_before_exit_unref.ts',
    'test_gap_startup_exit_job_boundary.ts',
    'test_gap_6077_unhandled_rejection_event.ts',
    'test_gap_6077_unhandled_rejection_sources.ts',
    'test_issue_9305_throw_in_microtask.ts',
    'test_gap_9416_stdin_only_loop_liveness.ts',
]
config['cases'] = [str(fixtures / name) for name in names] + [str(p) for p in sorted(fixtures.glob('test_microtask_inv_*.ts'))]
(out / 'fixtures-config.json').write_text(json.dumps(config, indent=2) + '\n')
