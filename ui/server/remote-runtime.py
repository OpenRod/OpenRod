"""Start an isolated, persistent Docker gateway. No SSH-owned background process."""
import base64
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def main():
    value = json.load(sys.stdin)
    name = value['name']
    if not re.fullmatch(r'console-ssh-[a-f0-9]{24}', name):
        raise ValueError('Invalid gateway name')
    os.umask(0o077)
    root = Path.home() / '.local/state/openshell-console/remote-gateways' / name
    if ',' in str(root):
        raise ValueError('Remote gateway home path cannot contain a Docker mount separator')
    if value.get('expectExisting') and not (root / 'managed.json').is_file():
        raise ValueError('Saved remote gateway state is missing. Restore it before reconnecting; no replacement was created')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or root.resolve() != root:
        raise ValueError('Remote gateway state must not use symlinks')
    os.chmod(root, 0o700)
    tls = root / 'tls'
    tls.mkdir(exist_ok=True, mode=0o700)
    if tls.is_symlink():
        raise ValueError('Remote TLS directory must not be a symlink')

    def write_once(file, data):
        try:
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if file.is_symlink() or not file.is_file() or file.read_bytes() != data:
                raise ValueError('Existing remote gateway state differs; it was left unchanged')
            return
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)

    allowed = {'ca.crt', 'server.crt', 'server.key', 'supervisor.crt', 'supervisor.key', 'jwt.key', 'jwt.pub', 'jwt.kid'}
    if set(value['files']) != allowed:
        raise ValueError('Invalid runtime certificate bundle')
    identity = {'name': name, 'engineId': value['engineId'], 'port': value['port']}
    write_once(root / 'managed.json', json.dumps(identity, sort_keys=True).encode())
    for filename, data in value['files'].items():
        write_once(tls / filename, base64.b64decode(data, validate=True))
    # Paths in generated TOML are basic strings; escape the remote home path.
    config = value['config'].replace('__CONSOLE_REMOTE_ROOT__', json.dumps(str(root))[1:-1])
    write_once(root / 'gateway.toml', config.encode())
    for folder in ['config', 'state', 'cache']:
        (root / folder).mkdir(exist_ok=True, mode=0o700)
        if (root / folder).is_symlink():
            raise ValueError('Remote gateway directories must not use symlinks')

    legacy = value.get('legacy') or {}
    migration = root / 'state/.console-migrated'
    database = root / 'state/openshell/gateway/openshell.db'
    if value.get('expectExisting') and not database.is_file():
        raise ValueError('The remote gateway database is missing; no empty replacement was created')
    if legacy and not migration.exists():
        if 'openshell/gateway/openshell.db' not in legacy:
            raise ValueError('Legacy state does not contain its gateway database')
        if database.exists():
            raise ValueError('Both local legacy and remote gateway databases exist. Resolve the migration manually; neither was overwritten')
        staged_state = root / 'migration-state'
        staged_state.mkdir(exist_ok=True, mode=0o700)
        if staged_state.is_symlink():
            raise ValueError('Migration directory must not be a symlink')
        for filename, data in legacy.items():
            parts = filename.split('/')
            if any(not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in {'.', '..'} for part in parts):
                raise ValueError('Invalid legacy gateway state path')
            file = staged_state / filename
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if file.parent.resolve() != file.parent:
                raise ValueError('Legacy state must not use symlinks')
            write_once(file, base64.b64decode(data, validate=True))
        import sqlite3
        from urllib.parse import quote
        with sqlite3.connect('file:' + quote(str(staged_state / 'openshell/gateway/openshell.db')) + '?mode=ro', uri=True) as migrated_db:
            if migrated_db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Legacy gateway database failed integrity verification')
        write_once(staged_state / '.console-migrated', b'1\n')
        os.rmdir(root / 'state')
        os.rename(staged_state, root / 'state')

    def docker(*args, check=True):
        result = subprocess.run(['docker', '--host', 'unix://' + value['socket'], *args], capture_output=True, text=True, timeout=150)
        if check and result.returncode:
            # Never relay Docker output containing config or credentials.
            raise RuntimeError('Remote Docker gateway operation failed: ' + args[0])
        return result

    info = json.loads(docker('info', '--format', '{{json .}}').stdout)
    if info['ID'] != value['engineId']:
        raise ValueError('The remote Docker engine changed during connection')
    image = docker('image', 'inspect', value['image'], check=False)
    if image.returncode:
        image = docker('image', 'inspect', value['imageId'], check=False)
    if image.returncode:
        # docker save/load may retain only the release tag. Its content is
        # checked against the pinned digest below before it can run.
        image = docker('image', 'inspect', value['image'].split('@')[0], check=False)
    if image.returncode:
        if not value['download']:
            raise RuntimeError('Upload the pinned gateway:0.1.2 image together with the sandbox and supervisor images')
        docker('pull', '--platform', 'linux/' + value['arch'], value['image'])
        image = docker('image', 'inspect', value['image'])
    image_info = json.loads(image.stdout)[0]
    # Docker's containerd store identifies a multi-platform image by its
    # manifest digest; the classic store uses the platform config digest.
    if image_info['Id'] not in {value['imageId'], value['image'].split('@')[1]} or image_info['Architecture'] != value['arch'] or image_info['Os'] != 'linux':
        raise ValueError('Remote gateway image does not match the pinned release')
    image_id = image_info['Id']

    socket_info = os.stat(value['socket'])
    if not stat.S_ISSOCK(socket_info.st_mode):
        raise ValueError('Docker endpoint must be a Unix socket')
    common = ['--network', 'host', '--user', str(os.getuid()) + ':' + str(os.getgid()),
              '--group-add', str(socket_info.st_gid),
              '--mount', 'type=bind,source=' + str(root) + ',target=' + str(root),
              '--mount', 'type=bind,source=' + value['socket'] + ',target=' + value['socket'],
              '--env', 'XDG_CONFIG_HOME=' + str(root / 'config'),
              '--env', 'XDG_STATE_HOME=' + str(root / 'state'),
              '--env', 'XDG_CACHE_HOME=' + str(root / 'cache')]
    existing = docker('container', 'inspect', name, check=False)
    if not existing.returncode:
        container = json.loads(existing.stdout)[0]
        labels = container['Config'].get('Labels') or {}
        mounts = {entry['Destination']: entry['Source'] for entry in container['Mounts']}
        if (labels.get('openshell.console/engine') != value['engineId']
                or labels.get('openshell.console/gateway') != name
                or container['Image'] != image_id
                or container['HostConfig']['NetworkMode'] != 'host'
                or container['HostConfig']['RestartPolicy']['Name'] != 'unless-stopped'
                or container['Config']['User'] != str(os.getuid()) + ':' + str(os.getgid())
                or not set(['XDG_CONFIG_HOME=' + str(root / 'config'),
                            'XDG_STATE_HOME=' + str(root / 'state'),
                            'XDG_CACHE_HOME=' + str(root / 'cache')]).issubset(container['Config'].get('Env') or [])
                or mounts.get(str(root)) != str(root)
                or mounts.get(value['socket']) != value['socket']
                or container['Config']['Cmd'] != ['--config', str(root / 'gateway.toml')]):
            raise ValueError('An unrelated container uses this gateway name; it was left unchanged')
        if not container['State']['Running']:
            docker('start', name)
    else:
        docker('run', '--rm', *common, image_id, 'config', 'preflight', '--path', str(root / 'gateway.toml'))
        docker('run', '--detach', '--name', name, '--restart', 'unless-stopped',
               '--label', 'openshell.console/gateway=' + name,
               '--label', 'openshell.console/engine=' + value['engineId'],
               *common, image_id, '--config', str(root / 'gateway.toml'))
    print(json.dumps(identity))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
