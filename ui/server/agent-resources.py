"""Read only resource names from known agent user configuration, never values."""
import json
from pathlib import Path

home = Path.home()
targets = {
    'Claude Code': ('.claude.json', 'mcpServers', ['.claude/skills']),
    'Codex': ('.codex/config.toml', 'mcp_servers', ['.agents/skills', '.codex/skills']),
    'Cursor': ('.cursor/mcp.json', 'mcpServers', ['.cursor/skills']),
}
result = {}
for agent, (config, key, roots) in targets.items():
    mcps, skills = [], []
    mcp_status, skill_status = 'checked', 'checked'
    try:
        file = home / config
        if file.exists():
            if file.stat().st_size > 1024 * 1024:
                raise ValueError('oversized')
            with file.open('rb') as handle:
                if file.suffix == '.toml':
                    import tomllib
                    data = tomllib.load(handle)
                else:
                    data = json.load(handle)
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
        seen = set()
        for root in roots:
            folder = home / root
            if not folder.exists():
                continue
            for entry in sorted(folder.iterdir()):
                if (entry / 'SKILL.md').is_file() and str(entry.resolve()) not in seen:
                    seen.add(str(entry.resolve()))
                    skills.append({'name': entry.name[:200]})
    except Exception:
        skill_status = 'unavailable'
        skills = []
    result[agent] = {'mcps': {'status': mcp_status, 'items': mcps}, 'skills': {'status': skill_status, 'items': skills}}
print('openshell-agent-resources:' + json.dumps(result, separators=(',', ':')))
