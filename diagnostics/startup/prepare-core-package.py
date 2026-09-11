"""Stage/pack/install the actual npm layout outside every source checkout.

The caller supplies immutable matching compiler, full runtime, stdlib, and core
archives. No registry publication occurs. Keep the temporary install for the
subsequent same-host comparisons and record every command/artifact hash.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('source')
parser.add_argument('artifacts')
parser.add_argument('core_archive')
parser.add_argument('output')
args = parser.parse_args()
source = pathlib.Path(args.source).resolve()
artifacts = pathlib.Path(args.artifacts).resolve()
core = pathlib.Path(args.core_archive).resolve()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
machine = platform.machine()
if platform.system() == 'Darwin' and machine == 'arm64':
    suffix, release_name = 'darwin-arm64', 'perry-macos-aarch64'
elif platform.system() == 'Linux' and machine == 'x86_64':
    suffix, release_name = 'linux-x64', 'perry-linux-x86_64'
else:
    raise RuntimeError(f'Package proof does not cover {platform.system()}/{machine} yet')
work = pathlib.Path(tempfile.mkdtemp(prefix='perry-core-npm-proof-'))
stage = work / 'stage'
install = work / 'install'
install.mkdir()
(stage / 'scripts').mkdir(parents=True)
shutil.copytree(source / 'npm', stage / 'npm', ignore=shutil.ignore_patterns('node_modules', '*.tgz', '*.a', '*.zst'))
for name in ['Cargo.toml', 'LICENSE', 'scripts/stage-npm.sh']:
    shutil.copy2(source / name, stage / name)
release = work / 'artifacts' / release_name
release.mkdir(parents=True)
receipt = {'sourceCommit': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
           'work': str(work), 'platformPackage': f'@perryts/perry-{suffix}', 'artifacts': [], 'commands': []}

def record(file):
    return {'file': str(file), 'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}

for name in ['perry', 'libperry_runtime.a', 'libperry_stdlib.a']:
    original = artifacts / name
    receipt['artifacts'].append(record(original))
    shutil.copy2(original, release / name)
receipt['artifacts'].append(record(core))
shutil.copy2(core, release / 'libperry_runtime_core.a')
env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PERRY_', 'MIMALLOC_'))}

def save():
    (out / 'package-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

def run(argv, cwd, name, settings=None):
    result = subprocess.run([str(x) for x in argv], cwd=cwd, env={**env, **(settings or {})}, text=True, capture_output=True, timeout=1200)
    (out / name).write_text(result.stdout + result.stderr)
    receipt['commands'].append({'argv': [str(x) for x in argv], 'cwd': str(cwd), 'env': settings or {}, 'log': name, 'exitCode': result.returncode})
    save()
    result.check_returncode()
    return result.stdout

run(['bash', stage / 'scripts/stage-npm.sh', work / 'artifacts'], stage, 'stage.log', {'SKIP_MISSING': '1'})
tarballs = []
for label in ['perry', f'perry-{suffix}']:
    packed = json.loads(run(['npm', 'pack', '--json', '--pack-destination', work], stage / 'npm' / label, f'{label}-pack.log'))
    tarball = work / packed[0]['filename']
    tarballs.append(tarball)
    receipt.setdefault('tarballs', []).append(record(tarball))
run(['npm', 'init', '-y'], install, 'npm-init.log')
run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', *tarballs], install, 'npm-install.log')
compiler = install / 'node_modules' / '@perryts' / f'perry-{suffix}' / 'bin' / 'perry'
receipt['installedCompiler'] = record(compiler)
lib = compiler.parent.parent / 'lib'
if not (lib / 'libperry_runtime_core.a.zst').is_file():
    raise RuntimeError('Real npm staging did not retain the compressed core archive')
if any((parent / 'crates/perry-runtime').exists() for parent in [install, *install.parents, compiler.parent, *compiler.parents]):
    raise RuntimeError('The installed compiler can still discover a source checkout')
run([install / 'node_modules/.bin/perry', '--version'], install, 'installed-wrapper-version.log')
config = {'compileArgs': [], 'variants': {
    'baseline': {'compiler': str(compiler), 'buildEnv': {'PERRY_NO_AUTO_OPTIMIZE': '1'}, 'runtimeEnv': {}},
    'candidate': {'compiler': str(compiler), 'buildEnv': {}, 'runtimeEnv': {}},
}}
(out / 'core-startup-config.json').write_text(json.dumps(config, indent=2) + '\n')
config['cases'] = [str(p.resolve()) for p in sorted(pathlib.Path('benches').glob('*.ts'))]
config['scriptc'] = False
(out / 'core-workloads-config.json').write_text(json.dumps(config, indent=2) + '\n')
receipt['ready'] = True
save()
print(f'Installed package outside source: {install}', flush=True)
