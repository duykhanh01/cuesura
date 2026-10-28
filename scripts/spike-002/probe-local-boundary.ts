/** Local-only T006 evidence: live Unix socket/file FD, role mounts and bounded symlink races. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandbox, createProbeFixture, IN_SANDBOX, probeLayout, sandboxCommand, SANDBOX_ROLES } from './sandbox.ts';

const CHILD = String.raw`
import json, os, pathlib, socket, sys, threading
d = json.loads(sys.argv[1])
secret = pathlib.Path(d['outside']) / 'canary'
control = str(pathlib.Path(d['control']) / 'cusrd.sock')
def connect():
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(2)
            s.connect(control)
            return s.recv(64) == b'fixture-control'
    except OSError:
        return False
if sys.argv[2] == 'control':
    checks = {'host_canary_readable': secret.read_text() == 'outside-canary\n',
              'passed_file_fd_readable': os.read(3, 64) == b'outside-canary\n',
              'host_socket_usable': connect()}
    print(json.dumps({'checks': checks, 'passed': all(checks.values())}))
    sys.exit(0 if all(checks.values()) else 1)

checks = {}
def readable(p):
    try:
        pathlib.Path(p).read_bytes()
        return True
    except OSError:
        return False
def writable(p):
    try:
        fd = os.open(p, os.O_WRONLY | os.O_APPEND)
        os.close(fd)
        return True
    except OSError:
        return False
def create(p):
    try:
        pathlib.Path(p).write_text('fixture')
        pathlib.Path(p).unlink()
        return True
    except OSError:
        return False

checks['live_control_socket_unreachable'] = not connect()
checks['outside_secret_unreadable'] = not readable(secret)
checks['host_fd_via_proc_unreadable'] = not readable('/proc/%s/fd/%s' % (d['host_pid'], d['host_fd']))
fd_leaks = []
for entry in pathlib.Path('/proc/self/fd').iterdir():
    try:
        st = os.fstat(int(entry.name))
        if [str(st.st_dev), str(st.st_ino)] == d['secret_identity'] or os.readlink(entry) in d['host_sockets']:
            fd_leaks.append(entry.name)
    except OSError:
        pass
checks['no_live_secret_or_socket_fd_inherited'] = not fd_leaks
checks['selected_auth_matches_role'] = readable('/cusr/home/selected-auth') == (d['role'] in ('coder', 'fixer', 'reviewer'))
checks['git_common_readonly'] = not writable(d['gitCommon'] + '/HEAD')
checks['git_admin_readonly'] = not writable(d['gitAdmin'] + '/HEAD')
checks['gitfile_readonly'] = not writable(d['worktree'] + '/.git')
checks['context_readonly'] = not writable('/cusr/context/prompt.md')
checks['schema_readable'] = readable('/cusr/schema/role.json')
checks['schema_readonly'] = not writable('/cusr/schema/role.json')
checks['system_readonly'] = not create('/usr/cusr-local-boundary')

roots = {'scratch': '/cusr/scratch', 'home': '/cusr/home', 'tmp': '/tmp', 'worktree': d['worktree']}
races = {}
for name, root in roots.items():
    allowed = name != 'worktree' or d['role'] != 'reviewer'
    checks[name + '_write_matches_role'] = create(root + '/write-probe') == allowed
    if not allowed:
        continue
    safe = pathlib.Path(root) / 'race-safe'
    safe.write_text('safe')
    link = pathlib.Path(root) / 'race-link'
    temp = pathlib.Path(root) / 'race-next'
    stop = threading.Event()
    ready = threading.Event()
    counts = {'swaps': 0, 'attempts': 0, 'escaped': False, 'errors': []}
    def swap():
        try:
            while not stop.is_set():
                for target in (str(safe), str(secret)):
                    temp.symlink_to(target)
                    os.replace(temp, link)
                    counts['swaps'] += 1
                    ready.set()
        except OSError as e:
            counts['errors'].append(str(e))
            ready.set()
    thread = threading.Thread(target=swap)
    thread.start()
    try:
        if ready.wait(2):
            for _ in range(500):
                counts['attempts'] += 1
                try:
                    if link.read_text() != 'safe': counts['escaped'] = True
                except OSError:
                    pass
                try:
                    fd = os.open(link, os.O_WRONLY | os.O_APPEND)
                    try:
                        st = os.fstat(fd)
                        if [str(st.st_dev), str(st.st_ino)] == d['secret_identity']: counts['escaped'] = True
                    finally:
                        os.close(fd)
                except OSError:
                    pass
    finally:
        stop.set()
        thread.join(3)
    checks[name + '_bounded_symlink_race'] = counts['swaps'] > 0 and counts['attempts'] == 500 and not counts['escaped'] and not counts['errors'] and not thread.is_alive()
    races[name] = counts
    for path in (temp, link, safe):
        path.unlink(missing_ok=True)
print(json.dumps({'role': d['role'], 'checks': checks, 'fd_leaks': fd_leaks,
                  'races': races, 'passed': all(checks.values())}, sort_keys=True))
sys.exit(0 if all(checks.values()) else 1)
`;

type ChildReport = { checks: Record<string, boolean>; passed: boolean };
type Run = { exit: number | null; signal: string | null; error: string; output: ChildReport | null };

async function run(command: readonly string[], extraFd?: number): Promise<Run> {
  const child = spawn(command[0] ?? '', command.slice(1), {
    env: {},
    stdio: extraFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', extraFd],
  });
  let stdout = '';
  let stderr = '';
  let failure = '';
  child.on('error', (error) => { failure = error.message; });
  child.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
    if (stdout.length > 64 * 1024) { failure = 'probe output exceeded cap'; child.kill('SIGKILL'); }
  });
  child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(0, 4000); });
  const timer = setTimeout(() => { failure = 'probe deadline exceeded'; child.kill('SIGKILL'); }, 20_000);
  const [exit, signal] = await new Promise<[number | null, string | null]>((done) => {
    child.once('close', (exit, signal) => done([exit, signal]));
  });
  clearTimeout(timer);
  let output: ChildReport | null = null;
  try { output = JSON.parse(stdout) as ChildReport; } catch { failure ||= 'probe did not return JSON'; }
  return { exit, signal, error: failure || stderr.trim(), output };
}

export async function runLocalBoundaryProbe() {
  const fx = createProbeFixture();
  const socketPath = join(fx.control, 'cusrd.sock');
  rmSync(socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('end', () => socket.end());
    socket.on('close', () => sockets.delete(socket));
    socket.write('fixture-control');
  });
  let secretFd: number | undefined;
  let connection: Socket | undefined;
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    // Keep a real connected control FD and a real secret FD open throughout every sandbox spawn.
    connection = createConnection(socketPath);
    await once(connection, 'data');
    secretFd = openSync(join(fx.outside, 'canary'), 'r');
    const identity = statSync(join(fx.outside, 'canary'), { bigint: true });
    const hostSockets = readdirSync('/proc/self/fd').flatMap((fd) => {
      try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith('socket:') ? [target] : []; }
      catch { return []; }
    });
    const script = join(fx.context, 'local-boundary.py');
    writeFileSync(script, CHILD);
    writeFileSync(join(fx.home, 'selected-auth'), 'disposable-model-auth');
    const schema = join(fx.base, 'schema');
    mkdirSync(schema);
    writeFileSync(join(schema, 'role.json'), '{}');
    const data = { ...fx, host_pid: process.pid, host_fd: secretFd, secret_identity: [String(identity.dev), String(identity.ino)], host_sockets: hostSockets };
    const positive = await run(['/usr/bin/python3', script, JSON.stringify(data), 'control'], secretFd);
    const roles: Array<{ role: string; layout_digest: string; result: Run }> = [];
    for (const role of SANDBOX_ROLES) {
      const plan = buildSandbox({ ...probeLayout(role, fx), schema });
      const result = await run(sandboxCommand(plan, ['/usr/bin/python3', `${IN_SANDBOX.context}/local-boundary.py`, JSON.stringify({ ...data, role }), 'boundary']));
      roles.push({ role, layout_digest: plan.layout_digest, result });
    }
    const unchanged = readFileSync(join(fx.outside, 'canary'), 'utf8') === 'outside-canary\n';
    const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
    const passed = (row: Run): boolean => row.exit === 0 && row.error === '' && row.output?.passed === true;
    return {
      schema_version: 1,
      kind: 'spike-0-local-boundary',
      checked_at: new Date().toISOString(),
      scope: 'Disposable live Unix socket/FD, role mounts and bounded in-sandbox symlink races only. Not a host mount-source TOCTOU proof, systemd lifetime, vendor smoke or full S0.1 pass.',
      node: process.version,
      kernel: spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim(),
      bwrap: spawnSync('/usr/bin/bwrap', ['--version'], { encoding: 'utf8' }).stdout.trim(),
      hashes: { probe: digest(fileURLToPath(import.meta.url)), sandbox: digest(fileURLToPath(new URL('./sandbox.ts', import.meta.url))), bwrap: digest('/usr/bin/bwrap') },
      positive_controls: positive,
      roles,
      host_canary_unchanged: unchanged,
      passed: unchanged && passed(positive) && roles.every((row) => passed(row.result)),
    };
  } finally {
    if (secretFd !== undefined) closeSync(secretFd);
    connection?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    rmSync(fx.base, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runLocalBoundaryProbe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
