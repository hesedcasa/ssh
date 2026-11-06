/* eslint-disable @typescript-eslint/no-explicit-any */
import {Command, Config} from '@oclif/core'
import {expect} from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {type SinonStub, stub} from 'sinon'

import {BaseCommand, preserveV4JsonExitCode} from '../src/base-command.js'
import SshServersAdd from '../src/commands/ssh/servers/add.js'
import SshServersDelete from '../src/commands/ssh/servers/delete.js'
import SshServersList from '../src/commands/ssh/servers/list.js'
import SshServersProfile from '../src/commands/ssh/servers/profile.js'
import SshServersTest from '../src/commands/ssh/servers/test.js'
import SshServersUpdate from '../src/commands/ssh/servers/update.js'
import {SERVER_CONFIG_FILE} from '../src/k8s/index.js'

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

  /**
   * The six `ssh servers` commands, as their modules actually register them
   * with oclif -- i.e. already wrapped by `preserveV4JsonExitCode`. Driving
   * them through oclif's full `_run()` (`init` -> `parse` -> `run` -> `catch`)
   * binds the wrapper to the real exports: dropping it from a command module
   * flips the real `--json` failure exit code from 1 back to 2 and these tests
   * fail with it, where the probe-based suite above alone would stay green.
   */
  describe('real ssh servers command exports (--json error exit code)', () => {
    // Every field flag the add/update factories require outside a TTY. The
    // failures under test happen after parse, so each argv must parse cleanly.
    const fieldFlags = [
      '--bastionHost',
      'bastion.example.com',
      '--component',
      'api',
      '--container',
      'app',
      '--namespace',
      'sa-prod',
      '--role',
      'app',
      '--sshHost',
      'k8s-node.example.com',
      '--sshUser',
      'allen',
    ]

    let config: Config
    let configDir: string
    let originalExitCode: typeof process.exitCode

    before(async () => {
      // A real oclif Config (so `_run()`'s init/removeEnvVar/parse path runs as
      // in the CLI); only `configDir` is pointed at the isolated store.
      config = await Config.load(process.cwd())
    })

    beforeEach(async () => {
      originalExitCode = process.exitCode
      // Simulate a fresh CLI process: the fix-up must re-derive 1 from the
      // error, not inherit a stale exit code from an earlier suite.
      process.exitCode = undefined
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-servers-json-exit-'))
      config.configDir = configDir
    })

    afterEach(async () => {
      process.exitCode = originalExitCode
      await fs.rm(configDir, {force: true, recursive: true})
    })

    // Each case fails naturally inside `run()` -- no stubs -- from the real
    // (or missing) profile store, exactly as the equivalent CLI invocation.
    const cases: Array<{
      argv: string[]
      cmdClass: typeof Command
      message: string
      store?: object
      topic: string
    }> = [
      {
        argv: ['-p', 'dup', ...fieldFlags],
        cmdClass: SshServersAdd,
        message: "Profile 'dup' already exists. Use 'ssh auth update' to modify it.",
        store: {profiles: {dup: {sshHost: 'k8s-node.example.com'}}},
        topic: 'add',
      },
      {
        argv: ['-p', 'ghost'],
        cmdClass: SshServersDelete,
        message: "Profile 'ghost' does not exist.",
        store: {profiles: {other: {sshHost: 'k8s-node.example.com'}}},
        topic: 'delete',
      },
      {
        argv: [],
        cmdClass: SshServersList,
        message: 'No authentication profiles found',
        topic: 'list',
      },
      {
        argv: ['--default', 'ghost'],
        cmdClass: SshServersProfile,
        message: 'Missing authentication config',
        topic: 'profile',
      },
      {
        argv: ['-p', 'ghost'],
        cmdClass: SshServersTest,
        message: "Missing authentication config. Run 'ssh auth add'.",
        topic: 'test',
      },
      {
        argv: ['-p', 'ghost', ...fieldFlags],
        cmdClass: SshServersUpdate,
        message: "Profile 'ghost' does not exist. Use 'ssh auth add' to create it.",
        store: {profiles: {other: {sshHost: 'k8s-node.example.com'}}},
        topic: 'update',
      },
    ]

    const registerCase = ({argv, cmdClass, message, store, topic}: (typeof cases)[number]): void => {
      it(`ssh servers ${topic} --json exits 1 with the auth error envelope`, async () => {
        if (store) {
          await fs.writeFile(path.join(configDir, SERVER_CONFIG_FILE), JSON.stringify(store))
        }

        // oclif types `Command` as abstract, so the factory-typed exports need
        // a cast to instantiate here. `_run()` is the CLI path minus exit.
        const cmd = new (cmdClass as any)(['--json', ...argv], config) as any
        const logJson = stub() as unknown as SinonStub
        cmd.logJson = logJson
        await cmd._run()

        // The v4 contract: exit 1 (not v5's `err.oclif.exit` of 2) ...
        expect(process.exitCode).to.equal(1)
        // ... with the envelope oclif printed: exactly AuthCommandBase's
        // `toErrorJson` rendering, untouched by the fix-up.
        expect(logJson.calledOnce).to.be.true
        expect(logJson.firstCall.args[0]).to.deep.equal({error: message})
      })
    }

    for (const testCase of cases) {
      registerCase(testCase)
    }
  })
})
