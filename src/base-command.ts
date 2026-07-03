import {HostConfigCommand} from '@hesed/plugin-lib'

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
export abstract class BaseCommand extends HostConfigCommand {}
