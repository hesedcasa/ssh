import {createAuthListCommand} from '@hesed/plugin-lib'

import {SERVER_CONFIG_FILE} from '../../../k8s/index.js'

export default createAuthListCommand({configFile: SERVER_CONFIG_FILE})
