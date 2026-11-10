from pathlib import Path
import json
import re
import hashlib
from collections import Counter

BASE = Path(__file__).resolve().parent
SOURCE_SHA = '8303cb117e197c700332b33b61b45314c9cc5bb4'
SOURCE_BASE = f'https://github.com/immich-app/immich/blob/{SOURCE_SHA}/'
METHODS = {'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'}
spec = json.loads((BASE / 'immich-openapi-v3.3.5.json').read_bytes())
assert spec['info']['version'] == '3.3.5'
source_manifest = json.loads((BASE / 'source-manifest.json').read_text())


def enum_values(name):
    enum_path = BASE / 'source-extras' / 'enum.ts'
    if not enum_path.exists():
        if name == 'Permission':
            return json.loads((BASE / 'permission-enum.json').read_text())
        if name == 'RouteKey':
            return {'Asset': 'assets', 'User': 'users'}
        raise ValueError(f'No archived enum metadata for {name}')
    text = enum_path.read_text()
    block = re.search(r'export enum ' + re.escape(name) + r' \{(.*?)^\}', text, re.S | re.M).group(1)
    return dict(re.findall(r'^\s*([A-Za-z]\w*)\s*=\s*\x27([^\x27]*)\x27,?', block, re.M))


permissions = enum_values('Permission')
route_keys = enum_values('RouteKey')


def resolve_controller_base(raw):
    raw = raw.strip()
    if not raw:
        return ''
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1]
    if raw.startswith('RouteKey.'):
        return route_keys[raw.split('.', 1)[1]]
    raise ValueError(f'Unrecognized controller base {raw}')


controller_methods = {}
all_controller_methods = []
for path in sorted((BASE / 'controllers').glob('*.controller.ts')):
    text = path.read_text()
    base_raw = re.search(r'^@Controller\(([^\n]*)\)', text, re.M).group(1)
    base_path = resolve_controller_base(base_raw)
    method_matches = list(re.finditer(r'^  (?:async )?([A-Za-z_$][\w$]*)\(', text, re.M))
    prev = 0
    for idx, match in enumerate(method_matches):
        preceding = text[prev:match.start()]
        preceding_start = prev
        prev = match.end()
        http = list(re.finditer(r'^  @(Get|Post|Put|Delete|Patch|Options|Head)\(([^\n]*)\)', preceding, re.M))
        if not http:
            continue
        verb = http[-1].group(1).lower()
        route_raw = http[-1].group(2).strip()
        if route_raw.startswith("'") and route_raw.endswith("'"):
            route = route_raw[1:-1]
        elif route_raw == '':
            route = ''
        else:
            raise ValueError((path.name, match.group(1), route_raw))
        route = '/' + '/'.join(x for x in (base_path, route) if x)
        route = re.sub(r':([A-Za-z]\w*)', r'{\1}', route)
        auth = re.search(r'^  @Authenticated\(([^\n]*)\)', preceding, re.M)
        if not auth:
            raise ValueError(f'Missing auth metadata: {path.name} {match.group(1)}')
        auth_raw = auth.group(1).strip()
        auth_opts = {k: (v == 'true') for k, v in re.findall(r'(public|admin|sharedLink|setup):\s*(true|false)', auth_raw)}
        permission_match = re.search(r'permission:\s*(Permission\.(\w+)|false)', auth_raw)
        if auth_opts.get('public'):
            permission_mode = 'public'
            effective_permission = None
        elif permission_match and permission_match.group(1) == 'false':
            permission_mode = 'check_disabled_by_immich'
            effective_permission = None
        elif permission_match:
            permission_mode = 'explicit'
            effective_permission = permissions[permission_match.group(2)]
        else:
            permission_mode = 'default_all'
            effective_permission = permissions['All']
        line = text[:match.start()].count('\n') + 1
        record = {
            'method_name': match.group(1),
            'http_method': verb.upper(),
            'path': route,
            'source_path': 'server/src/controllers/' + path.name,
            'source_url': SOURCE_BASE + 'server/src/controllers/' + path.name,
            'method_line': line,
            'auth_decorator': '@Authenticated(' + auth_raw + ')',
            'public': auth_opts.get('public', False),
            'admin_only': auth_opts.get('admin', False),
            'shared_link_supported': auth_opts.get('sharedLink', False),
            'setup_only': auth_opts.get('setup', False),
            'api_permission_mode': permission_mode,
            'effective_api_key_permission': effective_permission,
            'excluded_from_openapi': '@ApiExcludeEndpoint()' in preceding,
        }
        if match.group(1) in controller_methods:
            raise ValueError(f'Duplicate method name {match.group(1)}')
        controller_methods[match.group(1)] = record
        all_controller_methods.append(record)

if not controller_methods:
    # The handoff bundle keeps reviewed source metadata instead of all controller
    # implementations.  Supplying the archived controllers regenerates it from
    # source; otherwise use the fixed, source-linked index shipped in the bundle.
    all_controller_methods = json.loads((BASE / 'controller-auth-index.json').read_text())
    controller_methods = {row['method_name']: row for row in all_controller_methods}


def resolve_ref(ref):
    if not ref.startswith('#/'):
        raise ValueError('External schema reference: ' + ref)
    value = spec
    for segment in ref[2:].split('/'):
        value = value[segment.replace('~1', '/').replace('~0', '~')]
    return value


def find_binary_fields(schema, path='$', visited=()):
    if not isinstance(schema, dict):
        return []
    if '$ref' in schema:
        ref = schema['$ref']
        if ref in visited:
            return []
        return find_binary_fields(resolve_ref(ref), path, visited + (ref,))
    found = []
    if schema.get('format') == 'binary':
        found.append(path)
    for name, value in schema.get('properties', {}).items():
        found += find_binary_fields(value, path + '.' + name, visited)
    if 'items' in schema:
        found += find_binary_fields(schema['items'], path + '[]', visited)
    for key in ('allOf', 'oneOf', 'anyOf'):
        for index, value in enumerate(schema.get(key, [])):
            found += find_binary_fields(value, path + f'<{key}:{index}>', visited)
    return sorted(set(found))


RUNTIME_CONTEXT_NOTES = {
    'getMyApiKey': 'API-key context required by ApiKeyService.getMine; bearer/cookie alternatives in OpenAPI are generic decorator output.',
    'createSession': 'SessionService.create rejects API-key context; API key with all permissions is insufficient.',
    'lockAuthSession': 'AuthService.lockSession requires auth.session; API key with all permissions is insufficient.',
    'unlockAuthSession': 'AuthService.unlockSession requires auth.session and a valid PIN; API key with all permissions is insufficient.',
    'getSyncAck': 'SyncService.getAcks requires auth.session and rejects API-key context.',
    'sendSyncAck': 'SyncService.setAcks requires auth.session and rejects API-key context.',
    'deleteSyncAck': 'SyncService.deleteAcks requires auth.session and rejects API-key context.',
    'getSyncStream': 'SyncService.streamInternal requires auth.session and rejects API-key context. Response is JSON Lines despite absent OpenAPI response content.',
    'sharedLinkLogin': 'SharedLinkService.login requires auth.sharedLink; ordinary user API-key context is insufficient.',
    'getMySharedLink': 'SharedLinkService.getMine requires auth.sharedLink; ordinary user API-key context is insufficient.',
    'maintenanceLogin': 'Normal MaintenanceController always returns Not in maintenance mode; actual behavior depends on maintenance process/state.',
    'startDatabaseRestoreFlow': 'Public setup endpoint; initialization-state checks apply independently of API-key permissions.',
    'signUpAdmin': 'Public setup endpoint; initialization-state checks apply independently of API-key permissions.',
}

records = []
for path, item in spec['paths'].items():
    for method, operation in item.items():
        if method not in METHODS:
            continue
        name = operation['operationId']
        controller = controller_methods[name]
        assert method.upper() == controller['http_method'], name
        assert path == controller['path'], (name, path, controller['path'])
        assert controller['admin_only'] == operation.get('x-immich-admin-only', False), name
        if 'x-immich-permission' in operation:
            assert operation['x-immich-permission'] == controller['effective_api_key_permission'], name
        request_content = operation.get('requestBody', {}).get('content', {})
        response_content = {status: response.get('content', {}) for status, response in operation['responses'].items()}
        types = sorted({media for contents in response_content.values() for media in contents})
        if name == 'getSyncStream':
            response_kind = 'json_lines_stream'
        elif 'application/vnd.apple.mpegurl' in types:
            response_kind = 'hls_playlist'
        elif 'application/octet-stream' in types:
            response_kind = 'binary'
        elif types == ['application/json']:
            response_kind = 'json'
        elif not types:
            response_kind = 'no_content_schema'
        else:
            response_kind = 'mixed_or_other'
        row = {
            'operation_id': name,
            'suggested_tool_name': 'immich_' + name,
            'http_method': method.upper(),
            'path': path,
            'full_api_path': '/api' + path,
            'primary_tag': operation['tags'][0],
            'tags': operation['tags'],
            'summary': operation['summary'],
            'description': operation['description'],
            'state': operation.get('x-immich-state'),
            'deprecated': operation.get('deprecated', False),
            'permission_extension': operation.get('x-immich-permission'),
            'admin_only': operation.get('x-immich-admin-only', False),
            'history': operation['x-immich-history'],
            'security_declared': operation.get('security', spec.get('security', [])),
            'controller_auth': controller,
            'parameters': operation['parameters'],
            'request_body_required': operation.get('requestBody', {}).get('required', False),
            'request_media_types': sorted(request_content),
            'request_schemas': {mt: content.get('schema') for mt, content in request_content.items()},
            'request_binary_fields': {mt: find_binary_fields(content.get('schema', {})) for mt, content in request_content.items() if find_binary_fields(content.get('schema', {}))},
            'response_statuses': list(operation['responses']),
            'response_media_types': types,
            'response_kind': response_kind,
            'response_schemas': {status: {mt: content.get('schema') for mt, content in contents.items()} for status, contents in response_content.items()},
            'runtime_context_note': RUNTIME_CONTEXT_NOTES.get(name),
            'openapi_pointer': '#/paths/' + path.replace('~', '~0').replace('/', '~1') + '/' + method,
        }
        records.append(row)

assert len(records) == 279
assert len({row['operation_id'] for row in records}) == 279
assert len({row['suggested_tool_name'] for row in records}) == 279
assert all(len(row['suggested_tool_name']) <= 64 for row in records)
records.sort(key=lambda r: (r['primary_tag'], r['path'], r['http_method']))

supplementary = [r for r in all_controller_methods if r['method_name'] not in {o['operation_id'] for o in records}]
aliases = [dict(r, canonical_operation_id=r['method_name'][:-2]) for r in supplementary if r['method_name'].endswith('V3')]
for alias in aliases:
    canonical = next(r for r in records if r['operation_id'] == alias['canonical_operation_id'])
    assert alias['http_method'] == 'PATCH' and canonical['http_method'] == 'PUT'
    assert alias['path'] == canonical['path']
    alias['schema_source_operation_id'] = canonical['operation_id']

summary = {
    'product': 'Immich',
    'version': spec['info']['version'],
    'openapi_version': spec['openapi'],
    'source_commit_sha': SOURCE_SHA,
    'openapi_sha256': source_manifest['sha256'],
    'paths_count': len(spec['paths']),
    'operation_count': len(records),
    'primary_tag_count': len(Counter(r['primary_tag'] for r in records)),
    'operation_counts_by_method': dict(sorted(Counter(r['http_method'] for r in records).items())),
    'operation_counts_by_primary_tag': dict(sorted(Counter(r['primary_tag'] for r in records).items())),
    'operation_counts_by_state': dict(sorted(Counter(r['state'] or 'not_specified' for r in records).items())),
    'admin_only_count': sum(r['admin_only'] for r in records),
    'public_count': sum(r['controller_auth']['public'] for r in records),
    'setup_only_count': sum(r['controller_auth']['setup_only'] for r in records),
    'shared_link_supported_count': sum(r['controller_auth']['shared_link_supported'] for r in records),
    'permission_extension_count': sum(r['permission_extension'] is not None for r in records),
    'api_permission_mode_counts': dict(sorted(Counter(r['controller_auth']['api_permission_mode'] for r in records).items())),
    'request_media_type_counts': dict(sorted(Counter(t for r in records for t in r['request_media_types']).items())),
    'response_kind_counts': dict(sorted(Counter(r['response_kind'] for r in records).items())),
    'supplemental_hidden_patch_alias_count': len(aliases),
    'other_hidden_controller_route_count': len(supplementary) - len(aliases),
    'source_controller_count': len({r['source_path'] for r in all_controller_methods}),
}

for filename, data in [
    ('operation-inventory.json', {'source': source_manifest, 'summary': summary, 'operations': records}),
    ('inventory-summary.json', summary),
    ('controller-auth-index.json', all_controller_methods),
    ('supplemental-hidden-routes.json', {'patch_aliases': aliases, 'other_hidden_routes': [r for r in supplementary if not r['method_name'].endswith('V3')]}),
    ('permission-enum.json', permissions),
]:
    (BASE / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

lines = [
    '# Immich 3.3.5 API operation inventory',
    '',
    f'- Official source tag: `v3.3.5`',
    f'- Commit: `{SOURCE_SHA}`',
    f'- OpenAPI SHA-256: `{source_manifest["sha256"]}`',
    f'- Scope: **{len(records)} operations / {len(spec["paths"])} paths / {summary["primary_tag_count"]} primary tags**.',
    '- `Deprecated` is an additional tag on 24 operations; it is not a separate primary group.',
    '- Permission values below describe upstream behavior; they are not an MCP-side allowlist.',
    '- `all (default)` means the controller omits an explicit permission and upstream AuthService defaults to `all`. It does not mean no authentication.',
    '- `no key-permission check` means upstream explicitly sets `permission: false`. Other authentication and resource checks still apply.',
    '- OpenAPI security alternatives do not prove a session-only operation works with an API key. See runtime-context notes and the auth review.',
    '',
    '## Counts by primary tag',
    '',
    '| Primary tag | Count |',
    '| --- | ---: |',
]
for tag, count in summary['operation_counts_by_primary_tag'].items():
    lines.append(f'| {tag} | {count} |')
lines += ['', '## Operations', '']

for tag in summary['operation_counts_by_primary_tag']:
    lines += [f'### {tag}', '', '| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |', '| --- | --- | --- | --- | --- | --- | --- |']
    for row in records:
        if row['primary_tag'] != tag:
            continue
        ctrl = row['controller_auth']
        mode = ctrl['api_permission_mode']
        perm = {'public': 'public', 'default_all': 'all (default)', 'check_disabled_by_immich': 'no key-permission check'}.get(mode, ctrl['effective_api_key_permission'])
        if ctrl['setup_only']:
            perm += '; setup only'
        lines.append(f'| `{row["operation_id"]}` | {row["http_method"]} | `{row["path"]}` | `{perm}` | {"yes" if row["admin_only"] else ""} | {row["state"] or "not specified"} | {row["response_kind"]} |')
    lines.append('')

lines += ['## Runtime context exceptions confirmed in source', '', '| Operation ID | Source constraint |', '| --- | --- |']
for name, note in RUNTIME_CONTEXT_NOTES.items():
    lines.append(f'| `{name}` | {note} |')
lines += [
    '',
    '## Schema supplements',
    '',
    '- `getSyncStream` returns `Content-Type: application/jsonlines+json` with a JSON Lines stream (confirmed in `sync.controller.ts`). The OpenAPI 200 response has no content schema, so a generated JSON-only client is incomplete.',
    '- File endpoints advertise `application/octet-stream`; preserve actual Content-Type, Content-Disposition, status, range semantics, and bytes.',
    '- HLS playlist responses use `application/vnd.apple.mpegurl`; preserve playlist references and request headers `x-immich-hls-pos` and `x-immich-hls-msn`.',
    '- Multipart operations: `uploadDatabaseBackup`, `uploadAsset`, `createProfileImage`. `uploadAsset` has both `assetData` and optional `sidecarData` file fields.',
    '- `logoutOAuth` uses `application/x-www-form-urlencoded`.',
    '',
    '## Hidden PATCH aliases present in source',
    '',
    'The official OpenAPI contains the PUT forms with a deprecation history. The same release source also provides these PATCH aliases with `@ApiExcludeEndpoint()`. They implement the same operation and should be tracked separately from the 279 documented operations. Do not silently rewrite the canonical method merely because an alias exists.',
    '',
    '| Hidden source method | HTTP path | Canonical OpenAPI operation |',
    '| --- | --- | --- |',
]
for row in aliases:
    lines.append(f'| `{row["method_name"]}` | `PATCH {row["path"]}` | `{row["canonical_operation_id"]}` |')
lines += ['', '## Provenance', '', f'- [Pinned official OpenAPI]({SOURCE_BASE}open-api/immich-openapi-specs.json)', f'- [Pinned controllers]({SOURCE_BASE.replace("/blob/", "/tree/")}server/src/controllers)', '- `source-manifest.json` and `controllers-manifest.json` preserve exact source hashes.', '']
(BASE / 'operation-inventory.md').write_text('\n'.join(lines))

print(json.dumps(summary, ensure_ascii=False, indent=2))
