"""Parse agent JSONC without interpreting expressions or changing string values."""
import json, re

def parse_agent_json(text):
    string = r'"(?:\\.|[^"\\])*"'
    clean = re.sub(string + r'|//[^\n]*|/\*[\s\S]*?\*/', lambda m: m[0] if m[0].startswith('"') else ' ', text)
    clean = re.sub(string + r'|,\s*[}\]]', lambda m: m[0] if m[0].startswith('"') else m[0][1:], clean)
    return json.loads(clean)
