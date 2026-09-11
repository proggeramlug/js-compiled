"""Create same-binary ordinary/small comparisons after the source build."""
import copy
import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1])
for kind in ['startup', 'workloads']:
    config = json.loads((out / f'{kind}-config.json').read_text())
    candidate = config['variants']['candidate']
    config['variants']['baseline'] = copy.deepcopy(candidate)
    candidate['runtimeEnv'] = {'PERRY_MEMORY_PROFILE': 'small'}
    (out / f'small-{kind}-config.json').write_text(json.dumps(config, indent=2) + '\n')
