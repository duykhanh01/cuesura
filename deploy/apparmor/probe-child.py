#!/usr/bin/env python3
"""Run inside bwrap AFTER administrative provisioning; never loads policy itself."""

import ctypes
import errno
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def confined_profile():
    profile = Path('/proc/self/attr/current').read_text().strip()
    if 'cusr-bwrap-child' not in profile or '(enforce)' not in profile:
        raise RuntimeError(f'Expected enforcing cusr-bwrap-child stack, got {profile!r}')
    return profile


def probe(try_userns=False):
    profile = confined_profile()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.unshare.argtypes = [ctypes.c_int]
    libc.unshare.restype = ctypes.c_int

    # A mount namespace requires CAP_SYS_ADMIN even in the current user namespace.
    ctypes.set_errno(0)
    result = libc.unshare(0x00020000)  # CLONE_NEWNS
    error = ctypes.get_errno()
    if result != -1 or error != errno.EPERM:
        raise RuntimeError(f'Expected mount-namespace EPERM, got result={result}, errno={error}')

    # Userns creation alone may still succeed: test capability use afterwards as well.
    userns = None
    userns_error = None
    if try_userns:
        ctypes.set_errno(0)
        userns = libc.unshare(0x10000000)  # CLONE_NEWUSER
        userns_error = ctypes.get_errno()
        if userns == 0:
            ctypes.set_errno(0)
            if libc.unshare(0x00020000) != -1 or ctypes.get_errno() != errno.EPERM:
                raise RuntimeError('Mount namespace became available after creating a user namespace')
        elif userns != -1 or userns_error != errno.EPERM:
            raise RuntimeError(f'Unexpected userns result={userns}, errno={userns_error}')

    print(json.dumps({'profile': profile, 'mount_namespace': 'EPERM',
                      'userns_created': None if userns is None else userns == 0,
                      'userns_errno': userns_error}))


def main():
    confined_profile()  # Fail before trying anything if run outside the intended policy.
    if len(sys.argv) == 2 and sys.argv[1] == '--descendant':
        probe(try_userns=True)
        return
    if len(sys.argv) != 1:
        raise RuntimeError('Usage: probe-child.py [--descendant]')

    probe()
    # Test a normal descendant and two ways to invoke bwrap again, without exploit code.
    subprocess.run([sys.executable, str(Path(__file__).resolve()), '--descendant'], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix='cusr-capability-probe-') as scratch:
        copied = Path(scratch) / 'bwrap-copy'
        shutil.copy2('/usr/bin/bwrap', copied)
        for executable in ['/usr/bin/bwrap', str(copied)]:
            result = subprocess.run(
                [executable, '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/',
                 '--proc', '/proc', sys.executable, str(Path(__file__).resolve()), '--descendant'],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                # Namespace setup worked: the descendant must still have passed the denial probe.
                evidence = json.loads(result.stdout.strip())
                if evidence.get('mount_namespace') != 'EPERM' or 'cusr-bwrap-child' not in evidence.get('profile', ''):
                    raise RuntimeError('Nested bwrap returned without confinement evidence')
            elif result.returncode != 1 or not any(
                message in result.stderr for message in ['Permission denied', 'Operation not permitted']
            ):
                raise RuntimeError(f'Unexpected nested-bwrap failure: {result.returncode}: {result.stderr}')
            print(json.dumps({'executable': Path(executable).name, 'returncode': result.returncode,
                              'stderr': result.stderr.strip()}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
