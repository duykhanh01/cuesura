/**
 * Local-only architecture experiment, not a replacement for S0.1 or a new sandbox mode.
 * Run: node scripts/spike-002/reassess-sandbox.ts
 * Uses throwaway canaries; no sudo, policy changes, model calls or network requests.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSandbox,
  createProbeFixture,
  probeLayout,
  sandboxCommand,
  SANDBOX_ROLES,
} from './sandbox.ts';

// This child tests only disposable files created by createProbeFixture(). Namespace syscalls
// run inside the existing outer sandbox and never target host namespaces or real credentials.
const CHILD = String.raw`
import ctypes, errno, json, os, pathlib, shutil, sys

data = json.loads(sys.argv[1])
mode = sys.argv[2]
script = '/cusr/context/reassessment.py'
if mode == 'raw-userns':
    os.execv('/usr/bin/unshare', ['unshare', '--user', '--map-root-user', '--mount',
             '--propagation', 'private', '--', '/usr/bin/python3', script, sys.argv[1], 'check'])
if mode in ('nested-bwrap', 'copied-bwrap'):
    binary = '/usr/bin/bwrap'
    if mode == 'copied-bwrap':
        binary = '/cusr/scratch/bwrap-copy'
        shutil.copyfile('/usr/bin/bwrap', binary)
        os.chmod(binary, 0o755)
    os.execv(binary, [binary, '--unshare-user', '--unshare-pid', '--bind', '/', '/',
             '--proc', '/proc', '--dev', '/dev', '--new-session', '--die-with-parent',
             '--cap-drop', 'ALL', '--', '/usr/bin/python3', script, sys.argv[1], 'check'])

libc = ctypes.CDLL(None, use_errno=True)
checks = {}
def check(name, value):
    checks[name] = bool(value)
def readable(path):
    try:
        pathlib.Path(path).read_bytes()
        return True
    except OSError:
        return False
def writable_existing(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND)
        os.close(fd)
        return True
    except OSError:
        return False
def create(path):
    try:
        with open(path, 'x') as stream:
            stream.write('disposable canary\n')
        os.unlink(path)
        return True
    except OSError:
        return False

wt = data['worktree']
dotgit = wt + '/.git'
outside = data['outside'] + '/canary'
control = data['control'] + '/cusrd.sock'
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
try:
    label = pathlib.Path('/proc/self/attr/current').read_text().strip('\x00\n')
except OSError:
    label = 'unavailable'

check('no_new_privs', status.get('NoNewPrivs', '').strip() == '1')
check('worktree_readable', readable(wt + '/README.md'))
check('context_readable', readable('/cusr/context/prompt.md'))
check('outside_canary_hidden', not readable(outside))
check('control_path_hidden', not pathlib.Path(control).exists())
check('host_pid_root_cannot_reveal_canary', not readable('/proc/' + str(data['host_pid']) + '/root' + outside))
check('pid1_root_cannot_reveal_canary', not readable('/proc/1/root' + outside))
check('worktree_write_matches_role', create(wt + '/reassessment-new') == (data['role'] != 'reviewer'))
check('scratch_writable', create('/cusr/scratch/reassessment-new'))
check('home_writable', create('/cusr/home/reassessment-new'))
check('git_metadata_read_only', not writable_existing(data['gitCommon'] + '/HEAD'))
check('dotgit_read_only', not writable_existing(dotgit))
check('context_read_only', not writable_existing('/cusr/context/prompt.md'))

# Try to undo the read-only bind, then remove its overlay. A new userns can have
# CAP_SYS_ADMIN locally; the inherited parent mount restrictions must still hold.
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
libc.mount.restype = ctypes.c_int
ctypes.set_errno(0)
remount = libc.mount(None, dotgit.encode(), None, 32 | 4096, None)
remount_errno = ctypes.get_errno()
check('cannot_remount_dotgit_rw', remount == -1)
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.umount2.restype = ctypes.c_int
ctypes.set_errno(0)
unmount = libc.umount2(dotgit.encode(), 2)
unmount_errno = ctypes.get_errno()
check('cannot_remove_dotgit_overlay', unmount == -1)
check('dotgit_still_read_only', not writable_existing(dotgit))
check('reviewer_still_cannot_write', data['role'] != 'reviewer' or not create(wt + '/reassessment-after'))

fd_targets = []
for fd in pathlib.Path('/proc/self/fd').iterdir():
    try:
        fd_targets.append(os.readlink(fd))
    except OSError:
        pass
check('no_canary_or_control_fd_inherited', not any(data['outside'] in fd or data['control'] in fd for fd in fd_targets))

print(json.dumps({'role': data['role'], 'apparmor_label': label,
    'cap_eff': status.get('CapEff', '').strip(), 'checks': checks,
    'remount_errno': remount_errno, 'unmount_errno': unmount_errno,
    'passed': all(checks.values())}, sort_keys=True))
sys.exit(0 if all(checks.values()) else 1)
`;

const fx = createProbeFixture();
const rows: Array<{
  role: string;
  mode: string;
  exit: number | null;
  output: string;
  error: string;
}> = [];
try {
  writeFileSync(join(fx.context, 'reassessment.py'), CHILD);
  const dotgitBefore = readFileSync(join(fx.worktree, '.git'), 'utf8');
  const headBefore = readFileSync(join(fx.gitCommon, 'HEAD'), 'utf8');
  for (const role of SANDBOX_ROLES) {
    const plan = buildSandbox(probeLayout(role, fx));
    const data = JSON.stringify({ ...fx, role, host_pid: process.pid });
    for (const mode of [
      'baseline',
      'nested-bwrap',
      'copied-bwrap',
      'raw-userns',
    ]) {
      const [exe, ...args] = sandboxCommand(plan, [
        '/usr/bin/python3',
        '/cusr/context/reassessment.py',
        data,
        mode,
      ]);
      const r = spawnSync(exe as string, args, {
        env: {},
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024,
      });
      rows.push({
        role,
        mode,
        exit: r.status,
        output: r.stdout.trim(),
        error: (r.stderr || r.error?.message || '').trim(),
      });
      if (
        readFileSync(join(fx.worktree, '.git'), 'utf8') !== dotgitBefore ||
        readFileSync(join(fx.gitCommon, 'HEAD'), 'utf8') !== headBefore
      ) {
        throw new Error(
          'Disposable metadata changed: confinement check failed',
        );
      }
    }
  }
  const version = spawnSync('/usr/bin/bwrap', ['--version'], {
    encoding: 'utf8',
  });
  const kernel = spawnSync('uname', ['-r'], { encoding: 'utf8' });
  const report = {
    scope:
      'Local namespace/read-only canaries only; NOT S0.1 pass, not a kernel exploit test, not a vendor smoke or an approved policy change.',
    node: process.version,
    bwrap: version.stdout.trim(),
    kernel: kernel.stdout.trim(),
    passed: rows.every((row) => row.exit === 0),
    runs: rows,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
} finally {
  rmSync(fx.base, { recursive: true, force: true });
}
