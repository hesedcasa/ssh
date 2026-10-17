/* eslint-disable @typescript-eslint/no-explicit-any */
import {Command} from '@oclif/core'
import {expect} from 'chai'
import {type SinonStub, stub} from 'sinon'

import {BaseCommand, preserveV4JsonExitCode} from '../src/base-command.js'

/** The error shape oclif routes into `catch` (`@oclif/core` `CommandError`). */
type CommandError = Error & {exitCode?: number; oclif?: {exit?: number}}

class BaseStyleProbe extends BaseCommand {
  static override enableJsonFlag = true

  public async run(): Promise<void> {}
}

/**
 * Mirrors plugin-lib's `AuthCommandBase extends Command` — the shape of the
 * six factory-built `ssh servers` commands, which do not extend
 * {@link BaseCommand} and therefore need `preserveV4JsonExitCode`.
 */
class AuthStyleProbe extends Command {
  static override enableJsonFlag = true

  public async run(): Promise<void> {}
}

const PatchedAuthProbe = preserveV4JsonExitCode(AuthStyleProbe)

/** The `CLIError` that `this.error()` throws in every command (oclif.exit = 2). */
function cliError(cmd: any, message: string): CommandError {
  try {
    cmd.error(message)
    expect.fail('this.error should have thrown')
  } catch (error) {
    return error as CommandError
  }
}

/**
 * Pins the `--json` error exit-code contract in `BaseCommand.catch` and in
 * `preserveV4JsonExitCode`.
 *
 * `@hesed/plugin-lib` 0.13.0 pulled `@oclif/core` v4 -> v5 onto the runtime
 * path: v5's `Command.catch` exits `err.oclif.exit` (2 for `CLIError`) where
 * v4 exited `process.exitCode ?? err.exitCode ?? 1` -- i.e. 1. Both fix-ups
 * re-derive the v4 value after oclif has printed the error JSON; these tests
 * drive the real oclif `catch` through them, for the two command families in
 * this plugin: the `BaseCommand` subclasses (exec, tinker, artisan, discover)
 * and the plugin-lib factory commands (the six `ssh servers` commands).
 */
for (const [label, Probe] of [
  ['BaseCommand subclasses', BaseStyleProbe],
  ['patched plugin-lib auth factory commands', PatchedAuthProbe],
] as const) {
  describe(`BaseCommand --json error exit codes: ${label}`, () => {
    let originalExitCode: typeof process.exitCode

    beforeEach(() => {
      originalExitCode = process.exitCode
      // Simulate a fresh CLI process: whatever ran earlier in this mocha
      // process must not leak into the exit-code the fix-up re-derives.
      process.exitCode = undefined
    })

    afterEach(() => {
      process.exitCode = originalExitCode
    })

    function makeCmd(argv: string[]): {cmd: any; logJson: SinonStub} {
      const cmd = new Probe(argv, {
        root: process.cwd(),
        runHook: stub().resolves({failures: [], successes: []}),
      } as any)
      const logJson = stub() as SinonStub
      ;(cmd as any).logJson = logJson
      return {cmd, logJson}
    }

    it('exits 1 for a --json failure, as @oclif/core v4 did', async () => {
      const {cmd} = makeCmd(['--json'])

      await cmd.catch(cliError(cmd, 'ERROR: kubectl get pod failed (exit code 255)'))

      expect(process.exitCode).to.equal(1)
    })

    it('leaves the JSON error envelope printed by oclif untouched', async () => {
      const {cmd, logJson} = makeCmd(['--json'])
      const err = cliError(cmd, 'ERROR: boom')

      await cmd.catch(err)

      // The fix-up must only re-derive the exit code: what oclif logs is
      // exactly its own `toErrorJson` rendering of the original error.
      expect(logJson.calledOnce).to.be.true
      expect(logJson.firstCall.args[0]).to.deep.equal(cmd.toErrorJson(err))
    })

    it('honors an explicit err.exitCode, like v4 did', async () => {
      const {cmd} = makeCmd(['--json'])
      const err = cliError(cmd, 'ERROR: boom')
      err.exitCode = 3

      await cmd.catch(err)

      expect(process.exitCode).to.equal(3)
    })

    it('keeps an exit code set before the failure', async () => {
      const {cmd} = makeCmd(['--json'])
      process.exitCode = 7

      await cmd.catch(cliError(cmd, 'ERROR: boom'))

      expect(process.exitCode).to.equal(7)
    })

    it('leaves non-json failures to oclif (rethrow, exit 2)', async () => {
      const {cmd} = makeCmd([])
      const err = cliError(cmd, 'ERROR: boom')

      try {
        await cmd.catch(err)
        expect.fail('should have rethrown')
      } catch (error) {
        expect(error).to.equal(err)
      }

      expect(process.exitCode).to.equal(2)
    })
  })
}

describe('preserveV4JsonExitCode', () => {
  it('patches the class in place, keeping oclif discovery intact', () => {
    expect(PatchedAuthProbe).to.equal(AuthStyleProbe)
    expect(AuthStyleProbe.enableJsonFlag).to.be.true
  })
})
