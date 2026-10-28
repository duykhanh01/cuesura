"""Verify planned mount identities, then exec bwrap using pinned path FDs (Linux only)."""
import json
import os
import sys


def launch(plan, command):
    argv = list(plan['argv'])
    # Work backwards so removing an absent optional bind preserves the earlier offsets.
    for source in reversed(plan['sources']):
        path = source['source']
        expected = source['identity']
        index = source['argv_index']
        if expected is None:
            if os.path.lexists(path):
                raise RuntimeError(f'mount source appeared after planning: {path}')
            del argv[index:index + 3]
            continue
        fd = os.open(expected['realpath'], os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        st = os.fstat(fd)
        if (str(st.st_dev) != expected['dev'] or str(st.st_ino) != expected['ino']
                or os.path.realpath(path) != expected['realpath']):
            raise RuntimeError(f'mount source changed after planning: {path}')
        os.set_inheritable(fd, True)
        flag = '--bind-fd' if argv[index].startswith('--bind') else '--ro-bind-fd'
        argv[index:index + 2] = [flag, str(fd)]
    os.execve(plan['bwrap'], [plan['bwrap'], *argv, '--', *command], os.environ)


if __name__ == '__main__':
    try:
        launch(json.loads(sys.argv[1]), sys.argv[2:])
    except (OSError, RuntimeError) as error:
        sys.stderr.write(f'SandboxPolicyError: {error}\n')
        sys.exit(125)
