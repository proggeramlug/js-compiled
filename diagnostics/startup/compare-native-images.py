"""Compare complete native images, allowing only compiler identity metadata.

This is deliberately stricter than comparing .text: code, data, relocations,
addresses, sizes and loader commands must remain identical. Only the two exact
`git:`-prefixed source IDs, ELF build-ID notes, Mach-O UUIDs and code signatures
are normalized. A mismatch requires fresh execution/performance evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

p = argparse.ArgumentParser()
p.add_argument('before_manifest'); p.add_argument('after_manifest')
p.add_argument('before_commit'); p.add_argument('after_commit'); p.add_argument('output')
a = p.parse_args()
before, after = [json.loads(Path(x).read_text()) for x in [a.before_manifest, a.after_manifest]]
identities = [x.encode() for x in [a.before_commit, a.after_commit]]
assert all(len(x) == 40 and all(c in b'0123456789abcdef' for c in x) for x in identities)

def record(path):
    data = Path(path).read_bytes()
    return {'file': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def normalized(path):
    data = bytearray(Path(path).read_bytes())
    changes = []
    for identity in identities:
        start = 0
        while (tag := data.find(b'git:' + identity, start)) >= 0:
            offset = tag + 4
            data[offset:offset + 40] = b'0' * 40
            changes.append({'kind': 'source-id', 'offset': offset, 'bytes': 40})
            start = offset + 40
    def erase(kind, offset, size):
        assert offset >= 0 and size > 0 and offset + size <= len(data)
        data[offset:offset + size] = bytes(size)
        changes.append({'kind': kind, 'offset': offset, 'bytes': size})
    if data[:6] == b'\x7fELF\x02\x01':
        header = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        offset, stride, count, names_index = header[5], header[10], header[11], header[12]
        assert stride == 64 and 0 < names_index < count
        sections = [struct.unpack_from('<IIQQQQIIQQ', data, offset + i * stride) for i in range(count)]
        names = sections[names_index]
        table = data[names[4]:names[4] + names[5]]
        for section in sections:
            name = bytes(table[section[0]:]).split(b'\0', 1)[0]
            if name == b'.note.gnu.build-id':
                assert section[1] == 7
                erase('ELF build ID', section[4], section[5])
    elif data[:4] == b'\xcf\xfa\xed\xfe':
        header = struct.unpack_from('<IiiIIIII', data)
        offset = 32
        for _ in range(header[4]):
            cmd, size = struct.unpack_from('<II', data, offset)
            assert size >= 8 and offset + size <= len(data)
            if cmd == 0x1b: # LC_UUID
                assert size == 24
                erase('Mach-O UUID', offset + 8, 16)
            elif cmd == 0x1d: # LC_CODE_SIGNATURE, linkedit_data_command
                position, length = struct.unpack_from('<II', data, offset + 8)
                erase('Mach-O code signature', position, length)
            offset += size
    else:
        raise RuntimeError('Only little-endian ELF64 and Mach-O64 are supported')
    return bytes(data), changes

assert [x['name'] for x in before['cases']] == [x['name'] for x in after['cases']]
result = {'beforeManifest': record(a.before_manifest), 'afterManifest': record(a.after_manifest),
          'verifier': record(__file__), 'cases': {}, 'equivalent': True}
for old, new in zip(before['cases'], after['cases']):
    assert old['expected'] == new['expected'] and old['source']['sha256'] == new['source']['sha256']
    left, right = [x['commands']['candidate']['binary'] for x in [old, new]]
    assert record(left['file'])['sha256'] == left['sha256']
    assert record(right['file'])['sha256'] == right['sha256']
    first, first_changes = normalized(left['file'])
    second, second_changes = normalized(right['file'])
    same = first == second
    result['cases'][old['name']] = {'before': left, 'after': right,
        'byteIdentical': left['sha256'] == right['sha256'], 'equivalent': same,
        'beforeNormalizations': first_changes, 'afterNormalizations': second_changes,
        'normalizedBeforeSha256': hashlib.sha256(first).hexdigest(),
        'normalizedAfterSha256': hashlib.sha256(second).hexdigest()}
    result['equivalent'] &= same
Path(a.output).write_text(json.dumps(result, indent=2) + '\n')
print('Equivalent:', result['equivalent'], 'cases:', len(result['cases']))
raise SystemExit(0 if result['equivalent'] else 1)
