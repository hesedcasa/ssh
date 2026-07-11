import type {ApiResult} from '@hesed/plugin-lib'

import {Flags} from '@oclif/core'

import {BaseCommand} from '../../../base-command.js'
import {
  applyListEdits,
  formatCommandList,
  getProfileExecAllowlist,
  setProfileExecAllowlist,
} from '../../../k8s/index.js'

export default class SshExecAllow extends BaseCommand {
  static override description = "View or edit a server profile's exec allowlist"
  static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> -p prod',
    '<%= config.bin %> <%= command.id %> -p prod --add tail --add grep',
    '<%= config.bin %> <%= command.id %> -p prod --remove grep',
    '<%= config.bin %> <%= command.id %> -p prod --clear',
  ]
  static override flags = {
    add: Flags.string({description: 'Add a command prefix to the allowlist (repeatable)', multiple: true}),
    clear: Flags.boolean({default: false, description: "Remove every entry from the profile's allowlist"}),
    profile: Flags.string({char: 'p', description: 'SSH server profile name from config', required: false}),
    remove: Flags.string({description: 'Remove a command prefix from the allowlist (repeatable)', multiple: true}),
  }

  public async run(): Promise<ApiResult> {
    const {flags} = await this.parse(SshExecAllow)
    const {allowlist: current, profileName} = await getProfileExecAllowlist(this.config, flags.profile)

    if (!flags.add && !flags.remove && !flags.clear) {
      this.log(`Exec allowlist for '${profileName}':`)
      this.log(formatCommandList(current, '(empty — every exec command is allowed)'))
      return {data: {allowedExecCommands: current, profile: profileName}, success: true}
    }

    const updated = applyListEdits(current, flags.add, flags.remove, flags.clear)
    await setProfileExecAllowlist(this.config, profileName, updated)

    this.log(`Exec allowlist for '${profileName}' updated:`)
    this.log(formatCommandList(updated, '(empty — every exec command is allowed)'))
    return {data: {allowedExecCommands: updated, profile: profileName}, success: true}
  }
}
