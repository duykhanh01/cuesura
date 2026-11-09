import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { ExitCode, errorEnvelope, okEnvelope, renderEnvelope } from './output.ts';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliOption {
  readonly flags: string;
  readonly description: string;
}

export const DATA_DIR: CliOption = {
  flags: '--data-dir <dir>',
  description: 'Daemon data directory (default: $CUSR_DATA_DIR or ~/.cusr)',
};

export interface CliSpec {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** The commit this binary was built from, printed by `--version`. */
  readonly build?: BuildInfo;
  /**
   * Also accepted before the command (`cusr --data-dir DIR status`). A command that declares the same
   * flag gets the value given either place; its own place wins.
   */
  readonly globalOptions?: readonly CliOption[];
}

/**
 * One implemented subcommand; a two-word name (`task add`) sits under its group. Options are long flags,
 * taking a value (`--data-dir <dir>`) or not (`--follow`, given as the string `'true'`). Positional
 * arguments (`<id>`) reach `run` under their own name.
 */
export interface CliCommand {
  readonly name: string;
  readonly description: string;
  /** Printed after the options in `--help`: notes and real examples. */
  readonly help?: string;
  readonly args?: readonly string[];
  readonly options?: readonly CliOption[];
  run(
    values: Readonly<Record<string, string | undefined>>,
    json: boolean,
    io: CliIo,
  ): Promise<number>;
}

/** A reader such as `head` that has seen enough closes the pipe: that ends the output, not in a crash. */
export function exitOnClosedPipe(e: NodeJS.ErrnoException): void {
  if (e.code !== 'EPIPE') throw e;
  process.exit(0);
}

export const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Version of the installed package; the relative path holds for both src/cli and dist/cli. */
export function packageVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version === '')
    throw new Error('package.json is missing a valid version');
  return version;
}

export type BuildInfo = { readonly commit: string | null; readonly built_at: string | null };

let built: BuildInfo | undefined;

/**
 * What `pnpm build` stamped (scripts/write-build-info.ts); nulls when run from source. Read once, so a
 * daemon keeps reporting the build it started from after the install is swapped under it.
 */
export function buildInfo(): BuildInfo {
  if (built !== undefined) return built;
  built = { commit: null, built_at: null };
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'),
    );
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>;
      built = {
        commit: typeof r['commit'] === 'string' ? r['commit'] : null,
        built_at: typeof r['built_at'] === 'string' ? r['built_at'] : null,
      };
    }
  } catch {
    // Not built: running from source.
  }
  return built;
}

/**
 * `help [command...]` as `[command...] --help`; anything before the first word is a global option.
 * Applying it twice changes nothing.
 */
export function helpArgv(
  argv: readonly string[],
  globalOptions: readonly CliOption[] = [],
): readonly string[] {
  const valued = new Set(
    globalOptions.filter((o) => o.flags.includes('<')).map((o) => o.flags.split(/[ ,]/)[0]),
  );
  let i = 0;
  while (i < argv.length && (argv[i] as string).startsWith('-')) i += valued.has(argv[i]) ? 2 : 1;
  if (argv[i] !== 'help') return argv;
  return [...argv.slice(0, i), ...argv.slice(i + 1), '--help'];
}

/**
 * Runs one binary invocation and returns its exit code. Only `--version`, `--help` and the given
 * commands succeed; anything else is reported as not_available with exit 2, so a command that is not
 * implemented is never presented as available.
 */
export async function runCli(
  spec: CliSpec,
  rawArgv: readonly string[],
  io: CliIo,
  commands: readonly CliCommand[] = [],
): Promise<number> {
  const argv = helpArgv(rawArgv, spec.globalOptions);
  const json = argv.includes('--json');
  let exitCode: number = ExitCode.ok;
  // With --json the help text goes into one envelope instead of straight to stdout.
  let helpText = '';

  const program = new Command(spec.name)
    .description(spec.description)
    .option('-V, --version', 'Show the version number')
    .option('--json', 'Print one JSON result object to standard output')
    .helpOption('-h, --help', 'Show help')
    .allowUnknownOption()
    .allowExcessArguments()
    .configureOutput({
      writeOut: json ? (t) => (helpText += t) : io.stdout,
      writeErr: io.stderr,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .exitOverride();
  for (const o of spec.globalOptions ?? []) program.option(o.flags, o.description);
  program.action(() => {
    const opts = program.opts<{ version?: true; json?: true }>();
    if (opts.version === true) {
      const commit = spec.build?.commit ?? null;
      io.stdout(
        json
          ? renderEnvelope(okEnvelope({ version: spec.version, ...spec.build }))
          : `${spec.version}${commit === null ? '' : ` (${commit.slice(0, 12)})`}\n`,
      );
      return;
    }
    exitCode = notAvailable(spec.name, program.args, json, io, commands.length > 0);
  });
  if (commands.length === 0)
    program.addHelpText('after', '\nNo commands are available in this build.');

  const groups = new Map<string, Command>();
  for (const c of commands) {
    const words = c.name.split(' ');
    const leaf = words.at(-1) as string;
    let parent = program;
    if (words.length > 1) {
      const name = words[0] as string;
      const known = groups.get(name);
      parent = known ?? program.command(name).description(`Commands for ${name}`).exitOverride();
      groups.set(name, parent);
    }
    const sub = parent
      .command(leaf)
      .description(c.description)
      .allowExcessArguments(false)
      .option('--json', 'Print one JSON result object to standard output');
    for (const a of c.args ?? []) sub.argument(a);
    for (const o of c.options ?? []) sub.option(o.flags, o.description);
    if (c.help !== undefined) sub.addHelpText('after', `\n${c.help}`);
    sub.exitOverride().action(async (...given: unknown[]) => {
      const { json: subJson, ...opts } = sub.opts<
        Record<string, string | true | undefined> & { json?: true }
      >();
      const values: Record<string, string | undefined> = {};
      const globals = program.opts<Record<string, string | true | undefined>>();
      for (const o of c.options ?? []) {
        const key = sub.options.find((x) => x.flags === o.flags)?.attributeName();
        const fromGlobal = key === undefined ? undefined : globals[key];
        if (key !== undefined && opts[key] === undefined && fromGlobal !== undefined)
          opts[key] = fromGlobal;
      }
      for (const [k, v] of Object.entries(opts)) values[k] = v === true ? 'true' : v;
      (c.args ?? []).forEach((a, i) => {
        values[a.replace(/[<>[\]]/g, '')] = given[i] as string | undefined;
      });
      exitCode = await c.run(values, json || subJson === true, io);
    });
  }

  const unknown = commands.length > 0 ? unknownHelpTarget(program, argv, spec.globalOptions) : null;
  if (unknown !== null) {
    const message = `${spec.name}: no command "${unknown.name}"; valid: ${unknown.valid.join(', ')}`;
    if (json)
      io.stdout(
        renderEnvelope(
          errorEnvelope({
            code: 'invalid_arguments',
            message,
            details: { subcommands: unknown.valid },
            request_id: null,
          }),
        ),
      );
    else io.stderr(`${message}\n`);
    return ExitCode.usage;
  }

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    if (e.exitCode === 0) {
      if (json) io.stdout(renderEnvelope(okEnvelope({ help: helpText })));
      return ExitCode.ok;
    }
    // Commander has already written its diagnostic to stderr.
    if (json) {
      const choices = subcommandChoices(groups, argv);
      io.stdout(
        renderEnvelope(
          errorEnvelope({
            code: 'invalid_arguments',
            message:
              e.code === 'commander.help' && choices !== null
                ? `${spec.name} ${choices.group} needs a subcommand: ${choices.subcommands.join(', ')}`
                : e.message,
            details: choices === null ? {} : { subcommands: choices.subcommands },
            request_id: null,
          }),
        ),
      );
    }
    return hookPath(argv) ? ExitCode.failure : ExitCode.usage;
  }
  return exitCode;
}

/**
 * The command a help request names that does not exist (`cusr help task nonexistent`), with the names
 * valid in its place; commander would print the help of the nearest parent instead.
 */
function unknownHelpTarget(
  program: Command,
  argv: readonly string[],
  globalOptions: readonly CliOption[] = [],
): { name: string; valid: string[] } | null {
  if (!argv.includes('--help') && !argv.includes('-h')) return null;
  const valued = new Set(
    globalOptions.filter((o) => o.flags.includes('<')).map((o) => o.flags.split(/[ ,]/)[0]),
  );
  const words: string[] = [];
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const a = argv[i] as string;
    if (valued.has(a)) i++;
    else if (!a.startsWith('-')) words.push(a);
  }
  let parent = program;
  for (const word of words) {
    if (parent !== program && parent.commands.length === 0) return null;
    const found = parent.commands.find((c) => c.name() === word);
    if (found === undefined) {
      const valid = parent.commands.map((c) => c.name());
      return { name: [...(parent === program ? [] : [parent.name()]), word].join(' '), valid };
    }
    parent = found;
  }
  return null;
}

/** The subcommands of a group named without a valid one (`cusr queue`), so a caller can pick one. */
function subcommandChoices(
  groups: ReadonlyMap<string, Command>,
  argv: readonly string[],
): { group: string; subcommands: string[] } | null {
  const words = argv.filter((a) => !a.startsWith('-'));
  const name = words[0] ?? '';
  const group = groups.get(name);
  if (group === undefined) return null;
  const subcommands = group.commands.map((c) => c.name());
  return subcommands.includes(words[1] ?? '') ? null : { group: name, subcommands };
}

/** Commands an agent runs itself under `assistant`; the rest are hooks a harness runs. */
const ASSISTANT_RUN_BY_AGENT = ['wait', 'register', 'unregister'];

/**
 * A harness wakes the session on exit 2 from a hook (`asyncRewake`), so a hook command that no longer
 * parses would wake it on every Stop with its own error.
 */
function hookPath(argv: readonly string[]): boolean {
  return argv[0] === 'assistant' && !ASSISTANT_RUN_BY_AGENT.includes(argv[1] ?? '');
}

function notAvailable(
  name: string,
  args: readonly string[],
  json: boolean,
  io: CliIo,
  hasCommands: boolean,
): number {
  const argument = args[0] ?? null;
  const message =
    argument === null
      ? `${name}: no command given${hasCommands ? '' : '; no commands are available in this build'}`
      : `${name}: ${argument.startsWith('-') ? 'option' : 'command'} "${argument}" is not available in this build`;
  if (json) {
    io.stdout(
      renderEnvelope(
        errorEnvelope({
          code: 'not_available',
          message,
          details: { program: name, argument },
          request_id: null,
        }),
      ),
    );
  } else {
    io.stderr(`${message}\n`);
  }
  return ExitCode.usage;
}
