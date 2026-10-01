"""Read only resource names from known agent user configuration, never values."""
import json
from pathlib import Path

home = Path.home()
if 'parse_agent_json' not in globals(): exec((Path(__file__).parent / 'setup-json.py').read_text())
catalog = json.loads(globals().get('SETUP_TARGET_CATALOG') or (Path(__file__).parent.parent / 'shared/setup-targets.json').read_text())
result = {}
for adapter in catalog:
    agent = adapter['name']
    if not adapter.get('config'):
        result[agent] = {kind: {'status': 'unsupported', 'items': [], 'reason': adapter.get('reason')} for kind in ('mcps', 'skills')}
        continue
    config, key = adapter['config'], adapter['key']
    roots = [adapter['skills']] + adapter.get('extraSkillRoots', [])
    mcps, skills = [], []
    mcp_status, skill_status = 'checked', 'checked'
    try:
        file = home / config
        if adapter.get('alternateConfig') and (home / adapter['alternateConfig']).exists(): file = home / adapter['alternateConfig']
        if file.exists():
            if file.stat().st_size > 1024 * 1024:
                raise ValueError('oversized')
            with file.open('rb') as handle:
                if file.suffix == '.toml':
                    import tomllib
                    data = tomllib.load(handle)
                else:
                    data = parse_agent_json(handle.read().decode('utf8')) if adapter['format'] == 'opencode' else json.load(handle)
            servers = data.get(key, {})
            if not isinstance(servers, dict):
                raise ValueError('invalid servers')
            for name, value in servers.items():
                if not isinstance(value, dict):
                    raise ValueError('invalid server')
                mcps.append({'name': name[:200], 'disabled': value.get('enabled') is False or value.get('disabled') is True})
    except Exception:
        mcp_status = 'unavailable'
        mcps = []
    try:
        seen = set(); seen_names = set()
        for root in roots:
            folder = home / root
            if not folder.exists():
                continue
            for entry in sorted(folder.iterdir()):
                if (entry / 'SKILL.md').is_file() and str(entry.resolve()) not in seen and entry.name not in seen_names:
                    seen.add(str(entry.resolve())); seen_names.add(entry.name)
                    skills.append({'name': entry.name[:200]})
    except Exception:
        skill_status = 'unavailable'
        skills = []
    result[agent] = {'mcps': {'status': mcp_status, 'items': mcps}, 'skills': {'status': skill_status, 'items': skills}}
print('openshell-agent-resources:' + json.dumps(result, separators=(',', ':')))
