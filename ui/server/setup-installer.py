"""Trusted offline installer. Imported commands and skill scripts are never run."""
import base64, hashlib, json, os, pathlib, re, shutil, sys, tempfile
import fcntl
import tomllib

HOME = pathlib.Path(os.environ.get('OPENSHELL_SETUP_HOME', '/sandbox'))
if 'parse_agent_json' not in globals(): exec((pathlib.Path(__file__).parent / 'setup-json.py').read_text())
CATALOG = json.loads(globals().get('SETUP_TARGET_CATALOG') or (pathlib.Path(__file__).parent.parent / 'shared/setup-targets.json').read_text())
TARGETS = {t['id']: t for t in CATALOG if t.get('config') and t.get('skills')}

def network_executable(filename):
    if not filename: return None
    resolved = os.path.realpath(filename)
    if pathlib.Path(resolved).name == 'kiro-cli':
        chat = pathlib.Path(resolved).with_name('kiro-cli-chat')
        if chat.is_file(): return network_executable(str(chat))
    # Copilot's npm loader spawns the platform package, not the Node interpreter.
    if pathlib.Path(resolved).name == 'npm-loader.js' and pathlib.Path(resolved).parent.name == 'copilot':
        package = pathlib.Path(resolved).parent
        arch = 'arm64' if os.uname().machine in ('aarch64', 'arm64') else 'x64'
        try: glibc = bool(os.confstr('CS_GNU_LIBC_VERSION'))
        except (ValueError, OSError): glibc = False
        for platform in (['linux'] if glibc else ['linuxmusl', 'linux']):
            name = 'copilot-' + platform + '-' + arch
            for candidate in (package / 'node_modules/@github' / name / 'copilot', package.parent / name / 'copilot'):
                if candidate.is_file(): return network_executable(str(candidate))
        return None
    try:
        with open(resolved, 'rb') as handle:
            if handle.read(4) == b'\x7fELF': return resolved
    except OSError: pass
    # Codex's npm shim launches a native binary, which owns its network calls.
    if pathlib.Path(resolved).name == 'codex.js':
        package = pathlib.Path(resolved).parent.parent
        arch = 'arm64' if os.uname().machine in ('aarch64', 'arm64') else 'x64'
        triple = 'aarch64-unknown-linux-musl' if arch == 'arm64' else 'x86_64-unknown-linux-musl'
        roots = [package / 'vendor', package / 'node_modules/@openai' / ('codex-linux-' + arch) / 'vendor', package.parent / ('codex-linux-' + arch) / 'vendor']
        for base in roots:
            for suffix in ('bin/codex', 'codex/codex'):
                candidate = base / triple / suffix
                if candidate.is_file():
                    found = network_executable(str(candidate))
                    if found: return found
        return None
    # Known Node shebangs run the Node interpreter; other spawned programs still need separate grants.
    try:
        with open(resolved, 'rb') as handle: first = handle.readline(160).strip()
        if first in (b'#!/usr/bin/env node', b'#!/usr/bin/node', b'#!/usr/local/bin/node'):
            return network_executable(shutil.which('node'))
    except OSError: pass
    # Other script interpreters require a supported adapter.
    return None

def toml_value(value):
    if isinstance(value, dict): return '{ ' + ', '.join(json.dumps(k) + ' = ' + toml_value(v) for k, v in value.items()) + ' }'
    if isinstance(value, list): return '[' + ', '.join(toml_value(v) for v in value) + ']'
    return json.dumps(value)

def digest(raw): return hashlib.sha256(raw).hexdigest()
def safe_path(relative):
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or relative.startswith('/') or any(p in ('..', '.') for p in parts): raise ValueError('Unsafe destination')
    current = HOME
    if current.is_symlink(): raise ValueError('Sandbox home is a symlink')
    for p in parts:
        current = current / p
        if current.is_symlink(): raise ValueError('Destination contains a symlink')
    return current

def read(relative):
    p = safe_path(relative)
    if not p.exists(): return None
    if not p.is_file() or p.stat().st_size > 8 * 1024 * 1024: raise ValueError('Destination is not a supported regular file')
    with open(p, 'rb') as f: return f.read()

def write(relative, data, mode=0o600):
    p = safe_path(relative); p.parent.mkdir(parents=True, exist_ok=True)
    safe_path(relative)
    if data is None:
        if p.exists(): p.unlink()
        return
    fd, temp = tempfile.mkstemp(prefix='.openshell-', dir=p.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); os.fchmod(f.fileno(), mode)
        os.replace(temp, p)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def connected_config(item):
    config = item.get('config')
    if not config or not item.get('credentialRef'): return config
    aliases = set(item['credentialRef']['aliases'].values())
    def resolve(value):
        if not isinstance(value, str): return value
        def replace(match):
            key = match.group(1)
            bound = os.environ.get(key, '')
            if key not in aliases or not bound.startswith('openshell:resolve:env:'): raise ValueError('Gateway credential handles are not available yet. Check requirements and retry.')
            return bound
        return re.sub(r'openshell:resolve:env:([A-Za-z0-9_]+)', replace, value)
    return {key: {k: resolve(v) for k, v in value.items()} if key in ('env', 'headers') else value for key, value in config.items()}

def remove_managed_toml(text, block):
    if text.count(block) == 1: return text.replace(block, '', 1)
    # Codex may reformat the file or append its own tables inside our markers.
    # Check values first, remove only owned tables, then verify everything else.
    original = tomllib.loads(text)
    owned = tomllib.loads(block).get('mcp_servers', {})
    if not owned or any(original.get('mcp_servers', {}).get(k) != v for k, v in owned.items()):
        raise ValueError('Managed MCP configuration changed; resolve it before updating or removing')
    kept = []; skipping = False
    for line in text.splitlines(keepends=True):
        if re.match(r'^\s*\[.*\]\s*(?:#.*)?$', line):
            try: section = tomllib.loads(line)
            except tomllib.TOMLDecodeError: raise ValueError('Managed MCP configuration could not be safely updated')
            servers = section.get('mcp_servers', {})
            skipping = bool(servers) and set(servers).issubset(owned)
        if not skipping or line.lstrip().startswith('#'): kept.append(line)
    result = ''.join(kept)
    for line in block.splitlines(keepends=True):
        if line.startswith('# openshell-setup:'): result = result.replace(line, '')
    expected = json.loads(json.dumps(original))
    for key in owned: del expected['mcp_servers'][key]
    actual = tomllib.loads(result)
    if not expected.get('mcp_servers'): expected.pop('mcp_servers', None)
    if not actual.get('mcp_servers'): actual.pop('mcp_servers', None)
    if actual != expected: raise ValueError('Managed MCP configuration could not be safely updated')
    return result

def mcp_names(items, occupied, sid, prior=None):
    names = {}; occupied = set(occupied)
    for item in items:
        name = (prior or {}).get(item['id'])
        if name:
            if name in occupied: raise ValueError('Managed MCP name collision')
        else:
            name = re.sub(r'[^a-zA-Z0-9_-]+', '-', item.get('name') or 'mcp').strip('-')[:60] or 'mcp'
            if name in occupied: name += '-' + sid[:8] + '-' + item['id'][:8]
            if name in occupied: raise ValueError('MCP name collision')
        names[item['id']] = name; occupied.add(name)
    return names

def target_mcp_config(kind, config):
    value = dict(config)
    if kind in ('claude', 'droid'): value['type'] = 'http' if 'url' in value else 'stdio'
    elif kind == 'copilot':
        value['type'] = 'http' if 'url' in value else 'local'
        value['tools'] = ['*']
    elif kind == 'antigravity' and 'url' in value: value['serverUrl'] = value.pop('url')
    elif kind == 'opencode':
        if 'url' in value:
            if value.get('env'): raise ValueError('OpenCode remote MCPs do not support environment settings; use headers instead')
            value['type'] = 'remote'
        else:
            value['type'] = 'local'
            value['command'] = [value['command']] + value.pop('args', [])
            if 'env' in value: value['environment'] = value.pop('env')
        value['enabled'] = True
    return value

def run(request):
    operation = request['operation']; setup = request['setup']; targets = request['targets']
    sid = setup['id']
    if not re.fullmatch(r'[a-f0-9]{24}', sid) or not targets or any(t not in TARGETS for t in targets): raise ValueError('Invalid setup or target')
    manifest_path = '.openshell/installed-setups/' + sid + '.json'
    original_manifest = read(manifest_path)
    previous = json.loads(original_manifest) if original_manifest else None
    required = {TARGETS[t]['command']: shutil.which(TARGETS[t]['command']) for t in targets}
    if any(i['kind'] == 'mcp' for i in setup['items']): required['node'] = shutil.which('node')
    for item in setup['items']:
        if item['kind'] == 'mcp' and (item.get('config') or {}).get('command'):
            required[item['config']['command']] = shutil.which(item['config']['command'])
    if operation == 'probe': return {'executables': required, 'networkExecutables': {k: network_executable(v) for k, v in required.items()}, 'installed': previous is not None, 'revision': previous and previous['revision'], 'items': (previous or {}).get('items', []), 'targets': previous and previous['targets'], 'mcpNames': {c['target']: c.get('names', {}) for c in (previous or {}).get('configs', [])}}
    if previous and (previous['revision'] != setup['revision'] or sorted(previous['targets']) != sorted(targets)): raise ValueError('Select the originally assigned agents before reapplying or removing this Setup')
    if operation not in ('apply', 'remove'): raise ValueError('Unknown operation')
    if operation == 'apply' and any(not p for p in required.values()): raise ValueError('Required agent or MCP executable is missing from the image')
    if operation == 'apply':
        setup = dict(setup, items=[dict(item, config=connected_config(item)) if item['kind'] == 'mcp' else item for item in setup['items']])
    plans = {}; modes = {}; owned_files = {}; owned_configs = []; skill_names = {}
    if operation == 'remove' and not previous: return {'status': 'not-installed'}
    for target in targets:
        adapter = TARGETS[target]
        config_path, skill_path = adapter['config'], adapter['skills']
        if adapter.get('alternateConfig') and safe_path(adapter['alternateConfig']).exists(): config_path = adapter['alternateConfig']
        mcps = [i for i in setup['items'] if i['kind'] == 'mcp']
        if mcps:
            raw = read(config_path); text = (raw or b'').decode('utf-8')
            if target == 'codex':
                # Parse first; never append to a broken config. Managed TOML is
                # a separately delimited tail so unrelated formatting survives.
                tomllib.loads(text)
                begin = '# openshell-setup:' + sid + ':begin\n'; end = '# openshell-setup:' + sid + ':end\n'
                prior = next((c for c in (previous or {}).get('configs', []) if c['target'] == target), None)
                if prior:
                    text = remove_managed_toml(text, prior['block'])
                names = mcp_names(mcps, tomllib.loads(text).get('mcp_servers', {}), sid, (prior or {}).get('names'))
                block = begin
                for item in mcps:
                    block += '[mcp_servers.' + json.dumps(names[item['id']]) + ']\n'
                    for field, value in item['config'].items(): block += ('http_headers' if field == 'headers' else field) + ' = ' + toml_value(value) + '\n'
                block += end
                if operation == 'apply': text = text + ('\n' if text and not text.endswith('\n') else '') + block
                tomllib.loads(text)
                plans[config_path] = text.encode(); owned_configs.append({'target': target, 'block': block, 'names': names})
            else:
                doc = parse_agent_json(text or '{}') if adapter['format'] == 'opencode' else json.loads(text or '{}')
                key_name = adapter['key']
                if not isinstance(doc, dict) or not isinstance(doc.get(key_name, {}), dict): raise ValueError('Invalid MCP configuration')
                servers = doc.setdefault(key_name, {})
                prior = next((c for c in (previous or {}).get('configs', []) if c['target'] == target), None)
                if prior:
                    for key, value in prior['values'].items():
                        if servers.get(key) != value: raise ValueError('Managed MCP configuration changed or name is already used')
                        del servers[key]
                names = mcp_names(mcps, servers, sid, (prior or {}).get('names'))
                values = {}
                if operation == 'apply':
                    for item in mcps:
                        key = names[item['id']]
                        value = target_mcp_config(adapter['format'], item['config'])
                        servers[key] = value; values[key] = value
                plans[config_path] = (json.dumps(doc, indent=2) + '\n').encode(); owned_configs.append({'target': target, 'values': values, 'names': names})
        if operation == 'apply':
            skills = [i for i in setup['items'] if i['kind'] == 'skill']
            root = safe_path(skill_path)
            prior_names = (previous or {}).get('skillNames', {}).get(target, {})
            occupied = {p.name for p in root.iterdir()} if root.exists() else set()
            names = mcp_names(skills, occupied - set(prior_names.values()), sid, prior_names)
            skill_names[target] = names
            for item in skills:
                for f in item['files']:
                    relative = skill_path + '/' + names[item['id']] + '/' + f['path']
                    if f.get('encoding') not in (None, 'utf8', 'base64'): raise ValueError('Unsupported skill file encoding')
                    content = base64.b64decode(f['content'], validate=True) if f.get('encoding') == 'base64' else f['content'].encode()
                    existing = read(relative)
                    if existing is not None and ((previous or {}).get('files', {}).get(relative) != digest(existing)): raise ValueError('Skill file already exists or was modified')
                    plans[relative] = content; modes[relative] = 0o700 if f.get('executable') else 0o600; owned_files[relative] = digest(content)
    # Retire legacy generated paths only after checking every owned file for edits.
    # These deletions join the same rollback plan as the new readable paths.
    if operation == 'apply' and previous:
        for relative, expected in previous['files'].items():
            if relative in owned_files: continue
            raw = read(relative)
            if raw is not None and digest(raw) != expected: raise ValueError('Managed skill was modified; resolve it before migrating')
            plans[relative] = None
    if operation == 'remove':
        for relative, expected in previous['files'].items():
            raw = read(relative)
            if raw is not None and digest(raw) != expected: raise ValueError('Managed skill was modified; remove the assignment manually to preserve changes')
            plans[relative] = None
        plans[manifest_path] = None
    else:
        plans[manifest_path] = json.dumps({'items': [i['id'] for i in setup['items']], 'revision': setup['revision'], 'targets': targets, 'files': owned_files, 'configs': owned_configs, 'skillNames': skill_names}).encode()
    originals = {p: read(p) for p in plans}; original_modes = {p: safe_path(p).stat().st_mode & 0o777 for p in plans if safe_path(p).exists()}; completed = []
    try:
        for p, data in plans.items(): write(p, data, modes.get(p, original_modes.get(p, 0o600))); completed.append(p)
        for p, data in plans.items():
            if read(p) != data: raise ValueError('Written files could not be verified')
    except Exception:
        for p in reversed(completed): write(p, originals[p], original_modes.get(p, 0o600))
        raise
    return {'status': 'installed' if operation == 'apply' else 'removed', 'filesVerified': len(plans), 'restartRequired': True, 'connectivityVerified': False}

try:
    request = json.load(sys.stdin)
    if request['operation'] == 'probe':
        print(json.dumps(run(request))); sys.exit(0)
    lock = safe_path('.openshell/setup.lock'); lock.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        print(json.dumps(run(request)))
except Exception as error:
    # Never echo malformed config content, paths, credentials or child output.
    known = isinstance(error, ValueError) and not isinstance(error, (json.JSONDecodeError, tomllib.TOMLDecodeError))
    print(json.dumps({'error': str(error) if known else 'Setup operation failed; check filesystem access and existing configuration.'}))
    sys.exit(1)
