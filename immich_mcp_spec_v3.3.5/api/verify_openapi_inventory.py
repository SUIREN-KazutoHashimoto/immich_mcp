#!/usr/bin/env python3
"""Verify the pinned Immich 3.3.5 source and complete operation inventory.

This verifies the specification handoff, not a future MCP implementation.
No network access or Immich server credentials are used.
"""
import argparse
import hashlib
import json
from pathlib import Path
from collections import Counter

EXPECTED_COMMIT = '8303cb117e197c700332b33b61b45314c9cc5bb4'
EXPECTED_SHA256 = '632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9'
EXPECTED_BLOB = '52e3820ef6fd3e6165cb70a7b91596a9366670aa'
EXPECTED_OPERATIONS = 279
METHODS = {'get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    base = args.directory
    raw = (base / 'immich-openapi-v3.3.5.json').read_bytes()
    assert len(raw) == 953386, 'Unexpected byte length'
    assert hashlib.sha256(raw).hexdigest() == EXPECTED_SHA256, 'OpenAPI SHA256 mismatch'
    assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == EXPECTED_BLOB, 'Git blob SHA mismatch'
    spec = json.loads(raw)
    assert spec['info']['version'] == '3.3.5'
    expected = {o['operationId']: (m.upper(), p, o) for p, path_item in spec['paths'].items() for m, o in path_item.items() if m in METHODS}
    inventory = json.loads((base / 'operation-inventory.json').read_text())
    rows = inventory['operations']
    assert len(rows) == EXPECTED_OPERATIONS
    assert len(expected) == EXPECTED_OPERATIONS
    assert len(spec['paths']) == 193
    assert len({r['operation_id'] for r in rows}) == EXPECTED_OPERATIONS, 'Duplicate operation ID'
    assert set(expected) == {r['operation_id'] for r in rows}, 'Missing or surplus operations'
    assert len({r['suggested_tool_name'] for r in rows}) == EXPECTED_OPERATIONS
    for row in rows:
        method, path, operation = expected[row['operation_id']]
        assert (row['http_method'], row['path']) == (method, path)
        assert row['permission_extension'] == operation.get('x-immich-permission')
        assert row['admin_only'] == operation.get('x-immich-admin-only', False)
        assert row['state'] == operation.get('x-immich-state')
        assert row['deprecated'] == operation.get('deprecated', False)
        assert row['security_declared'] == operation.get('security', [])
        assert row['parameters'] == operation['parameters']
        assert row['request_media_types'] == sorted(operation.get('requestBody', {}).get('content', {}))
        assert row['controller_auth']['http_method'] == method
        assert row['controller_auth']['path'] == path
        assert EXPECTED_COMMIT in row['controller_auth']['source_url']
        assert len(row['suggested_tool_name']) <= 64
    summary = inventory['summary']
    assert summary['operation_count'] == EXPECTED_OPERATIONS
    assert summary['primary_tag_count'] == 41
    assert summary['admin_only_count'] == 57
    assert summary['public_count'] == 17
    assert summary['permission_extension_count'] == 247
    assert summary['api_permission_mode_counts'] == dict(sorted(Counter(r['controller_auth']['api_permission_mode'] for r in rows).items()))
    assert summary['operation_counts_by_state'] == dict(sorted(Counter(r['state'] or 'not_specified' for r in rows).items()))
    media_counts = Counter(mt for row in rows for mt in row['request_media_types'])
    assert media_counts['multipart/form-data'] == 3
    assert media_counts['application/x-www-form-urlencoded'] == 1
    assert next(r for r in rows if r['operation_id'] == 'getSyncStream')['response_kind'] == 'json_lines_stream'
    supplement = json.loads((base / 'supplemental-hidden-routes.json').read_text())
    assert len(supplement['patch_aliases']) == 14
    assert len(supplement['other_hidden_routes']) == 2
    for row in supplement['patch_aliases']:
        method, path, _ = expected[row['canonical_operation_id']]
        assert method == 'PUT' and row['http_method'] == 'PATCH'
        assert path == row['path']
    manifest = json.loads((base / 'source-manifest.json').read_text())
    assert manifest['commit_sha'] == EXPECTED_COMMIT
    assert manifest['sha256'] == EXPECTED_SHA256
    if 'license' in manifest:
        license_info = manifest['license']
        license_bytes = (base / license_info['local_filename']).read_bytes()
        assert len(license_bytes) == license_info['size_bytes']
        assert hashlib.sha256(license_bytes).hexdigest() == license_info['sha256']
    print(json.dumps({'ok': True, 'version': '3.3.5', 'source_commit': EXPECTED_COMMIT, 'operations': EXPECTED_OPERATIONS, 'paths': 193, 'primary_tags': 41, 'hidden_patch_aliases': 14, 'openapi_sha256': EXPECTED_SHA256}, indent=2))


if __name__ == '__main__':
    main()
