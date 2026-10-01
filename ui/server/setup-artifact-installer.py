"""Extract a verified package archive without executing its contents."""
import hashlib, io, json, os, pathlib, shutil, sys, tarfile, tempfile
root = pathlib.Path('/sandbox/.openshell/packages')
try:
    expected = sys.argv[1]
    if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected): raise ValueError()
    data = sys.stdin.buffer.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected: raise ValueError()
    for p in [pathlib.Path('/sandbox'), root.parent, root]:
        if p.is_symlink(): raise ValueError()
    root.mkdir(parents=True, exist_ok=True)
    dest = root / expected
    # Never trust a previously writable artifact; compare before replacing.
    temp = pathlib.Path(tempfile.mkdtemp(prefix='.package-', dir=root))
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = archive.getmembers()
            if len(members) > 30000 or sum(m.size for m in members) > 200 * 1024 * 1024: raise ValueError()
            seen = set()
            for m in members:
                name = pathlib.PurePosixPath(m.name)
                if name.is_absolute() or '..' in name.parts or m.name in seen: raise ValueError()
                seen.add(m.name)
                if not (m.isfile() or m.isdir() or m.issym()): raise ValueError()
                if m.issym():
                    link = pathlib.PurePosixPath(m.linkname)
                    if link.is_absolute() or not os.path.realpath(temp / name.parent / link).startswith(str(temp) + '/'): raise ValueError()
            # Symlinks are written last; archive members never traverse links.
            for m in sorted(members, key=lambda m: m.issym()):
                p = temp / m.name
                if not str(p.resolve()).startswith(str(temp) + '/') and p.resolve() != temp: raise ValueError()
                if m.isdir(): p.mkdir(parents=True, exist_ok=True)
                elif m.isfile():
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with open(p, 'xb') as out: shutil.copyfileobj(archive.extractfile(m), out)
                    p.chmod(0o700 if m.mode & 0o111 else 0o600)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True); p.symlink_to(m.linkname)
        if dest.exists() or dest.is_symlink():
            # Avoid replacing code a running MCP may be using.
            def inventory(base):
                result = {}
                for d, dirs, files in os.walk(base, followlinks=False):
                    for n in dirs + files:
                        p = pathlib.Path(d) / n; key = str(p.relative_to(base))
                        result[key] = ('link', os.readlink(p)) if p.is_symlink() else ('dir', '') if p.is_dir() else ('file', hashlib.sha256(p.read_bytes()).hexdigest(), bool(p.stat().st_mode & 0o111))
                return result
            if dest.is_symlink() or inventory(dest) != inventory(temp): raise ValueError()
        else: temp.rename(dest); temp = None
    finally:
        if temp: shutil.rmtree(temp)
    print(json.dumps({'installed': expected}))
except Exception:
    print(json.dumps({'error': 'Package integrity, filesystem or archive validation failed.'})); sys.exit(1)
