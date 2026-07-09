import {HostConfigCommand} from '@hesed/plugin-lib'
import {ux} from '@oclif/core'

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
