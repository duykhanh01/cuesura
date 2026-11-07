import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { ExitCode, errorEnvelope, okEnvelope, renderEnvelope } from './output.ts';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliSpec {
  readonly name: string;
  readonly description: string;
  readonly version: string;
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
  readonly options?: readonly {
    readonly flags: string;
    readonly description: string;
  }[];
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

/**
 * Runs one binary invocation and returns its exit code. Only `--version`, `--help` and the given
 * commands succeed; anything else is reported as not_available with exit 2, so a command that is not
 * implemented is never presented as available.
 */
export async function runCli(
  spec: CliSpec,
  argv: readonly string[],
  io: CliIo,
  commands: readonly CliCommand[] = [],
): Promise<number> {
  const json = argv.includes('--json');
  let exitCode: number = ExitCode.ok;

  const program = new Command(spec.name)
    .description(spec.description)
    .option('-V, --version', 'Show the version number')
    .option('--json', 'Print one JSON result object to standard output')
    .helpOption('-h, --help', 'Show help')
    .allowUnknownOption()
    .allowExcessArguments()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .exitOverride()
    .action(() => {
      const opts = program.opts<{ version?: true; json?: true }>();
      if (opts.version === true) {
        io.stdout(
          json ? renderEnvelope(okEnvelope({ version: spec.version })) : `${spec.version}\n`,
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
      for (const [k, v] of Object.entries(opts)) values[k] = v === true ? 'true' : v;
      (c.args ?? []).forEach((a, i) => {
        values[a.replace(/[<>[\]]/g, '')] = given[i] as string | undefined;
      });
      exitCode = await c.run(values, json || subJson === true, io);
    });
  }

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    if (e.exitCode === 0) return ExitCode.ok;
    // Commander has already written its diagnostic to stderr.
    if (json) {
      io.stdout(
        renderEnvelope(
          errorEnvelope({
            code: 'invalid_arguments',
            message: e.message,
            details: {},
            request_id: null,
          }),
        ),
      );
    }
    return ExitCode.usage;
  }
  return exitCode;
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
