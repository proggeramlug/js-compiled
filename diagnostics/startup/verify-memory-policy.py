"""Fresh-process Linux constructor/override probe using the locked allocator.

This fast C gate complements the full Rust/native-binary and performance gates;
it cannot establish RSS savings or prove Cargo's final link integration.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import platform
import subprocess
import tarfile
import tomllib
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('source')
parser.add_argument('output')
args = parser.parse_args()
source = pathlib.Path(args.source).resolve()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
if platform.system() != 'Linux':
    raise RuntimeError('This probe requires Linux PR_GET_THP_DISABLE')
package = next(p for p in tomllib.loads((source / 'Cargo.lock').read_text())['package'] if p['name'] == 'libmimalloc-sys')
url = f"https://static.crates.io/crates/libmimalloc-sys/libmimalloc-sys-{package['version']}.crate"
with urllib.request.urlopen(url, timeout=60) as response:
    archive = response.read()
digest = hashlib.sha256(archive).hexdigest()
if digest != package['checksum']:
    raise RuntimeError('Downloaded allocator does not match Cargo.lock')
prefix = f"libmimalloc-sys-{package['version']}/c_src/mimalloc/v3/"
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for member in tar:
        if not member.isfile() or not member.name.startswith(prefix):
            continue
        relative = pathlib.PurePosixPath(member.name[len(prefix):])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Unsafe archive path')
        destination = out / 'mimalloc' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(tar.extractfile(member).read())
env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PERRY_', 'MIMALLOC_'))}
receipt = {'sourceCommit': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
           'allocator': {'url': url, 'sha256': digest, 'versionTree': 'v3'},
           'platform': platform.platform(), 'commands': [], 'cases': [], 'passed': True}

def save():
    (out / 'policy-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')

def build(argv):
    run = subprocess.run([str(x) for x in argv], env=env, text=True, capture_output=True)
    receipt['commands'].append({'argv': [str(x) for x in argv], 'stdout': run.stdout, 'stderr': run.stderr, 'exitCode': run.returncode})
    save()
    run.check_returncode()

includes = ['-I', out / 'mimalloc/include', '-I', out / 'mimalloc/src']
flags = ['-O3', '-std=c11', '-DNDEBUG', '-DMI_BUILD_RELEASE', '-DMI_DEBUG=0', '-ffunction-sections', '-fdata-sections', '-ftls-model=initial-exec']
build(['cc', *flags, *includes, '-c', out / 'mimalloc/src/static.c', '-o', out / 'mimalloc.o'])
build(['cc', *flags, *includes, '-c', source / 'crates/perry-runtime/src/ffi/perry_memory_profile.c', '-o', out / 'policy.o'])
# Archive extraction and section GC must retain the constructor through its
# production anchor, rather than linking policy.o directly or using whole-archive.
build(['ar', 'rcs', out / 'libpolicy.a', out / 'policy.o'])
binary = out / 'memory-profile-probe'
build(['cc', *flags, *includes, source / 'crates/perry-runtime/tests/fixtures/memory_profile_probe.c',
       out / 'libpolicy.a', out / 'mimalloc.o', '-Wl,--gc-sections', '-pthread', '-ldl', '-lrt', '-o', binary])
cases = [('normal', {}, 1), ('small', {'PERRY_MEMORY_PROFILE': 'small'}, 0),
         ('default-name', {'PERRY_MEMORY_PROFILE': 'default'}, 1), ('unknown-name', {'PERRY_MEMORY_PROFILE': 'unknown'}, 1)]
for profile in [None, 'small']:
    for spelling in ['MIMALLOC_ALLOW_THP', 'mimalloc_allow_thp']:
        for value in [0, 1]:
            settings = {spelling: str(value)}
            if profile:
                settings['PERRY_MEMORY_PROFILE'] = profile
            cases.append((f'{profile or "normal"}-{spelling}-{value}', settings, value))
for name, settings, option in cases:
    run = subprocess.run([str(binary), str(option), str(1 - option)], env={**env, **settings}, text=True, capture_output=True, timeout=30)
    passed = run.returncode == 0 and run.stderr == ''
    receipt['cases'].append({'name': name, 'env': settings, 'expected': {'allowThp': option, 'earlyThpDisabled': 1 - option},
                             'stdout': run.stdout, 'stderr': run.stderr, 'exitCode': run.returncode, 'passed': passed})
    receipt['passed'] &= passed
    save()
    print(name, 'passed' if passed else 'FAILED', flush=True)
if not receipt['passed']:
    raise SystemExit(1)
