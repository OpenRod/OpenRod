"""Trusted offline installer. Imported commands and skill scripts are never run."""
import hashlib, json, os, pathlib, re, shutil, sys, tempfile
import fcntl
import tomllib

HOME = pathlib.Path(os.environ.get('OPENSHELL_SETUP_HOME', '/sandbox'))
TARGETS = {'codex': ('.codex/config.toml', '.agents/skills', 'codex'), 'claude': ('.claude.json', '.claude/skills', 'claude'), 'cursor': ('.cursor/mcp.json', '.cursor/skills', 'cursor-agent')}
def network_executable(filename):
    if not filename: return None
    resolved = os.path.realpath(filename)
    try:
        with open(resolved, 'rb') as handle:
            if handle.read(4) == b'\x7fELF': return resolved
    except OSError: pass
    # A script can spawn another program. Do not infer the network caller.
    return None

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

def run(request):
    operation = request['operation']; setup = request['setup']; targets = request['targets']
    sid = setup['id']
    if not re.fullmatch(r'[a-f0-9]{24}', sid) or not targets or any(t not in TARGETS for t in targets): raise ValueError('Invalid setup or target')
    manifest_path = '.openshell/installed-setups/' + sid + '.json'
    original_manifest = read(manifest_path)
    previous = json.loads(original_manifest) if original_manifest else None
    required = {TARGETS[t][2]: shutil.which(TARGETS[t][2]) for t in targets}
    for item in setup['items']:
        if item['kind'] == 'mcp' and item.get('config', {}).get('command'):
            required[item['config']['command']] = shutil.which(item['config']['command'])
    if operation == 'probe': return {'executables': required, 'networkExecutables': {k: network_executable(v) for k, v in required.items()}, 'installed': previous is not None, 'revision': previous and previous['revision'], 'targets': previous and previous['targets']}
    if previous and (previous['revision'] != setup['revision'] or sorted(previous['targets']) != sorted(targets)): raise ValueError('Select the originally assigned agents before reapplying or removing this Setup')
    if operation not in ('apply', 'remove'): raise ValueError('Unknown operation')
    if operation == 'apply' and any(not p for p in required.values()): raise ValueError('Required agent or MCP executable is missing from the image')
    plans = {}; modes = {}; owned_files = {}; owned_configs = []
    if operation == 'remove' and not previous: return {'status': 'not-installed'}
    for target in targets:
        config_path, skill_path, _ = TARGETS[target]
        mcps = [i for i in setup['items'] if i['kind'] == 'mcp']
        if mcps:
            raw = read(config_path); text = (raw or b'').decode('utf-8')
            if target == 'codex':
                # Parse first; never append to a broken config. Managed TOML is
                # a separately delimited tail so unrelated formatting survives.
                tomllib.loads(text)
                begin = '# openshell-setup:' + sid + ':begin\n'; end = '# openshell-setup:' + sid + ':end\n'
                block = begin
                for item in mcps:
                    key = 'os-' + sid[:8] + '-' + item['id'][:8]
                    block += '[mcp_servers.' + json.dumps(key) + ']\n'
                    for field, value in item['config'].items(): block += field + ' = ' + json.dumps(value) + '\n'
                block += end
                prior = next((c for c in (previous or {}).get('configs', []) if c['target'] == target), None)
                if prior:
                    if text.count(prior['block']) != 1: raise ValueError('Managed MCP configuration changed; resolve it before updating or removing')
                    text = text.replace(prior['block'], '', 1)
                elif any(('os-' + sid[:8] + '-' + i['id'][:8]) in tomllib.loads(text).get('mcp_servers', {}) for i in mcps): raise ValueError('MCP name collision')
                if operation == 'apply': text = text + ('\n' if text and not text.endswith('\n') else '') + block
                tomllib.loads(text)
                plans[config_path] = text.encode(); owned_configs.append({'target': target, 'block': block})
            else:
                doc = json.loads(text or '{}')
                if not isinstance(doc, dict) or not isinstance(doc.get('mcpServers', {}), dict): raise ValueError('Invalid MCP configuration')
                servers = doc.setdefault('mcpServers', {})
                prior = next((c for c in (previous or {}).get('configs', []) if c['target'] == target), None)
                values = {}
                for item in mcps:
                    key = 'os-' + sid[:8] + '-' + item['id'][:8]
                    value = dict(item['config'])
                    if target == 'claude': value['type'] = 'http' if 'url' in value else 'stdio'
                    if key in servers and (not prior or servers[key] != prior['values'].get(key)): raise ValueError('Managed MCP configuration changed or name is already used')
                    if operation == 'apply': servers[key] = value; values[key] = value
                    else: servers.pop(key, None)
                plans[config_path] = (json.dumps(doc, indent=2) + '\n').encode(); owned_configs.append({'target': target, 'values': values})
        if operation == 'apply':
            for item in setup['items']:
                if item['kind'] != 'skill': continue
                for f in item['files']:
                    relative = skill_path + '/os-' + sid[:8] + '-' + item['name'] + '/' + f['path']
                    content = f['content'].encode(); existing = read(relative)
                    if existing is not None and ((previous or {}).get('files', {}).get(relative) != digest(existing)): raise ValueError('Skill file already exists or was modified')
                    plans[relative] = content; modes[relative] = 0o700 if f.get('executable') else 0o600; owned_files[relative] = digest(content)
    if operation == 'remove':
        for relative, expected in previous['files'].items():
            raw = read(relative)
            if raw is not None and digest(raw) != expected: raise ValueError('Managed skill was modified; remove the assignment manually to preserve changes')
            plans[relative] = None
        plans[manifest_path] = None
    else:
        plans[manifest_path] = json.dumps({'revision': setup['revision'], 'targets': targets, 'files': owned_files, 'configs': owned_configs}).encode()
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
