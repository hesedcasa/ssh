import {createAuthProfileCommand} from '@hesed/plugin-lib'

import {SERVER_CONFIG_FILE} from '../../../k8s/index.js'

export default createAuthProfileCommand({configFile: SERVER_CONFIG_FILE})
