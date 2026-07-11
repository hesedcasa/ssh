import type {ApiResult} from '@hesed/plugin-lib'

import {Flags} from '@oclif/core'

import {BaseCommand} from '../../../base-command.js'
import {closeConnections, discoverPodLabels} from '../../../k8s/index.js'
import {DiscoverLabelsData} from '../../../k8s/pod-runner.js'

export default class SshServersDiscover extends BaseCommand {
  static override description =
    "Discover the component/role label values on a namespace's running pods (valid --component/--role targets)"
  static override enableJsonFlag = true
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> -p prod',
    '<%= config.bin %> <%= command.id %> --namespace sa-testqa',
  ]
  static override flags = {
    namespace: Flags.string({description: 'Override Kubernetes namespace (default: from profile)'}),
    profile: Flags.string({char: 'p', description: 'SSH server profile name from config', required: false}),
  }

  public async run(): Promise<ApiResult> {
    const {flags} = await this.parse(SshServersDiscover)

    const result = await this.withSpinner('Discovering pod labels', () =>
      discoverPodLabels(this.config, flags.profile, flags.namespace),
    )
    await closeConnections()

    if (result.success) {
      this.log(typeof result.data?.result === 'string' ? result.data.result : '')

      delete (result.data as DiscoverLabelsData).result

      return result
    }

    this.error(String(result.error ?? 'Label discovery failed'))
  }
}
