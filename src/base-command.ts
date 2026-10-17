import {HostConfigCommand} from '@hesed/plugin-lib'
import {type Command, ux} from '@oclif/core'

/** The error shape oclif routes into `catch` (`@oclif/core` `CommandError`). */
type CommandError = Error & {exitCode?: number; oclif?: {exit?: number}}

/**
 * Re-derive, after `Command.catch` has printed a failed command's error, the
 * exit code `@oclif/core` v4 would have exited with.
 *
 * `@hesed/plugin-lib` 0.13.0 runs on `@oclif/core` v5, whose `Command.catch`
 * derives the process exit code from `err.oclif.exit` (2 for `CLIError`)
 * where v4 — shipped with plugin-lib 0.10.1 — used
 * `process.exitCode ?? err.exitCode ?? 1`. Left alone, every `--json` failure
 * would regress from exit 1 to exit 2 and break scripts matching the
 * pre-bump contract.
 *
 * `caught` is the promise returned by the overridden `super.catch(err)`; it
 * prints the error JSON (whose envelope is left untouched) before the exit
 * code is re-derived. `previousExitCode` must be captured before `caught`
 * starts — v5's catch overwrites `process.exitCode` synchronously. Non-`--json`
 * failures rethrow out of `caught` into oclif's top-level handler — which
 * hard-exits `err.oclif.exit` (2) exactly as before — so this only adjusts the
 * `--json` path.
 */
async function restoreJsonErrorExitCode(
  cmd: Command,
  err: CommandError,
  caught: Promise<unknown>,
  previousExitCode: typeof process.exitCode,
): Promise<void> {
  await caught

  if (cmd.jsonEnabled()) {
    process.exitCode = previousExitCode ?? err.exitCode ?? 1
  }
}

/**
 * Patch one of plugin-lib's `createAuth*Command` classes so its commands keep
 * the v4 `--json` error exit-code contract, too: those commands extend
 * plugin-lib's own `AuthCommandBase extends Command`, not {@link BaseCommand},
 * so `BaseCommand`'s `catch` override alone does not cover them. Each command
 * module applies this to its own freshly created factory class, so the patch
 * stays local. (A subclass would not typecheck: oclif's `Command` is abstract
 * and `typeof Command` cannot base a class expression.)
 */
export function preserveV4JsonExitCode<C extends typeof Command>(command: C): C {
  const prototype = command.prototype as unknown as {
    catch: (this: Command, err: CommandError) => Promise<unknown>
  }
  const originalCatch = prototype.catch

  prototype.catch = async function (err: CommandError) {
    const previousExitCode = process.exitCode
    return restoreJsonErrorExitCode(this, err, originalCatch.call(this, err), previousExitCode)
  }

  return command
}

/**
 * Base command for all `ssh` plugin commands.
 *
 * Extends {@link HostConfigCommand} (not oclif's `Command` directly) so that,
 * when this plugin is dispatched from a host CLI, the host's already-loaded
 * `Config` — including any dynamically registered commands — is preserved
 * instead of being rebuilt. See `@hesed/plugin-lib`'s `HostConfigCommand` docs
 * for the full rationale.
 *
 * Every command in this plugin already imports `'../../base-command.js'`, so
 * centralizing here keeps that contract in one place.
 */
export abstract class BaseCommand extends HostConfigCommand {
  /** See {@link restoreJsonErrorExitCode} for why the exit code is re-derived. */
  protected override async catch(err: CommandError): Promise<void> {
    const previousExitCode = process.exitCode
    await restoreJsonErrorExitCode(this, err, super.catch(err), previousExitCode)
  }

  /**
   * Run `action` behind an oclif spinner (writes to stderr, so it never
   * corrupts `--json` output on stdout). Suppressed entirely under `--json`
   * since nothing is watching the spinner in that mode.
   */
  protected async withSpinner<T>(message: string, action: () => Promise<T>): Promise<T> {
    if (this.jsonEnabled()) {
      return action()
    }

    ux.action.start(message)
    try {
      return await action()
    } finally {
      ux.action.stop()
    }
  }
}
