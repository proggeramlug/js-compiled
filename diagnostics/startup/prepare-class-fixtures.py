import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1]).resolve()
source = pathlib.Path(sys.argv[2]).resolve()
config = json.loads((out / 'startup-config.json').read_text())
config['scriptc'] = False
config['cases'] = [str(source / 'test-files' / name) for name in [
    'test_gap_class_expr_inherited_static_method.ts',
    'test_class_static_in_function.ts',
    'test_gap_class_expr_new_instanceof.ts',
]] + [str(pathlib.Path('diagnostics/startup/class-parents-first-use.ts').resolve())]
config['gcStressCases'] = ['class-parents-first-use']
(out / 'class-fixtures-config.json').write_text(json.dumps(config, indent=2) + '\n')
