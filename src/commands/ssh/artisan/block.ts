import type {ApiResult} from '@hesed/plugin-lib'

import {Flags} from '@oclif/core'

import {BaseCommand} from '../../../base-command.js'
import {applyListEdits, formatCommandList, getProfileBlacklist, setProfileBlacklist} from '../../../k8s/index.js'

export default class SshArtisanBlock extends BaseCommand {
  static override description = "View or edit a server profile's artisan blacklist"
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
    const {flags} = await this.parse(SshArtisanBlock)
    const {blacklist: current, profileName} = await getProfileBlacklist(this.config, flags.profile)

    if (!flags.add && !flags.remove && !flags.clear) {
      this.log(`Artisan blacklist for '${profileName}':`)
      this.log(formatCommandList(current, '(empty — no artisan commands are blocked)'))
      return {data: {blacklistedArtisanCommands: current, profile: profileName}, success: true}
    }

    const updated = applyListEdits(current, flags.add, flags.remove, flags.clear)
    await setProfileBlacklist(this.config, profileName, updated)

    this.log(`Artisan blacklist for '${profileName}' updated:`)
    this.log(formatCommandList(updated, '(empty — no artisan commands are blocked)'))
    return {data: {blacklistedArtisanCommands: updated, profile: profileName}, success: true}
  }
}
