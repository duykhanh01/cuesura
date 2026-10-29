import { describe, expect, it } from 'vitest';
import { runLocalBoundaryProbe } from '../../../scripts/spike-002/probe-local-boundary.ts';
import {
  bwrapUsable,
  SANDBOX_ROLES,
} from '../../../scripts/spike-002/sandbox.ts';

describe.skipIf(!bwrapUsable().usable)(
  'spike-002 live FD/socket and bounded symlink races',
  () => {
    it('keeps live host authority outside every role while the positive controls work', async () => {
      const report = await runLocalBoundaryProbe();
      expect(report.positive_controls.output?.checks).toEqual({
        host_canary_readable: true,
        passed_file_fd_readable: true,
        host_socket_usable: true,
      });
      expect(report.roles.map((row) => row.role)).toEqual([...SANDBOX_ROLES]);
      for (const row of report.roles) {
        expect(row.result, row.role).toMatchObject({
          exit: 0,
          error: '',
          output: { passed: true },
        });
        expect(
          row.result.output?.checks['no_live_secret_or_socket_fd_inherited'],
        ).toBe(true);
      }
      expect(report.host_canary_unchanged).toBe(true);
      expect(report.passed).toBe(true);
    });
  },
);
