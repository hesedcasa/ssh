import type {ApiResult} from '@hesed/plugin-lib'

import {Flags} from '@oclif/core'

import {BaseCommand} from '../../../base-command.js'
import {getProfileBlacklist, setProfileBlacklist} from '../../../k8s/index.js'

function formatBlacklist(blacklist: string[]): string {
  return blacklist.length > 0
    ? blacklist.map((entry) => `  • ${entry}`).join('\n')
    : '  (empty — no artisan commands are blocked)'
}

export default class SshServersSafety extends BaseCommand {
  static override description =
    "View or edit a server profile's artisan blacklist (subcommand prefixes `ssh artisan` refuses to run)"
  static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> -p prod',
    '<%= config.bin %> <%= command.id %> -p prod --add migrate --add migrate:fresh',
    '<%= config.bin %> <%= command.id %> -p prod --remove migrate:fresh',
    '<%= config.bin %> <%= command.id %> -p prod --clear',
  ]
  static override flags = {
    add: Flags.string({description: 'Add a command prefix to the blacklist (repeatable)', multiple: true}),
    clear: Flags.boolean({default: false, description: "Remove every entry from the profile's blacklist"}),
    profile: Flags.string({char: 'p', description: 'SSH server profile name from config', required: false}),
    remove: Flags.string({description: 'Remove a command prefix from the blacklist (repeatable)', multiple: true}),
  }

  public async run(): Promise<ApiResult> {
    const {flags} = await this.parse(SshServersSafety)
    const {blacklist: current, profileName} = await getProfileBlacklist(this.config, flags.profile)

    if (!flags.add && !flags.remove && !flags.clear) {
      this.log(`Artisan blacklist for '${profileName}':`)
      this.log(formatBlacklist(current))
      return {data: {blacklistedArtisanCommands: current, profile: profileName}, success: true}
    }

    let updated = flags.clear ? [] : [...current]

    if (flags.remove) {
      const toRemove = new Set(flags.remove.map((entry) => entry.trim().toLowerCase()))
      updated = updated.filter((entry) => !toRemove.has(entry.trim().toLowerCase()))
    }

    if (flags.add) {
      for (const raw of flags.add) {
        const entry = raw.trim()
        if (entry && !updated.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
          updated.push(entry)
        }
      }
    }

    await setProfileBlacklist(this.config, profileName, updated)

    this.log(`Artisan blacklist for '${profileName}' updated:`)
    this.log(formatBlacklist(updated))
    return {data: {blacklistedArtisanCommands: updated, profile: profileName}, success: true}
  }
}
