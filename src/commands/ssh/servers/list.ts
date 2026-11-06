import {createAuthListCommand} from '@hesed/plugin-lib'

import {preserveV4JsonExitCode} from '../../../base-command.js'
import {SERVER_CONFIG_FILE} from '../../../k8s/index.js'

export default preserveV4JsonExitCode(createAuthListCommand({configFile: SERVER_CONFIG_FILE}))
