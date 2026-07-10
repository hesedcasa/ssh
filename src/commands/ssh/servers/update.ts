import {createAuthUpdateCommand, type FieldDef} from '@hesed/plugin-lib'

import {closeConnections, SERVER_CONFIG_FILE, testServerConnection} from '../../../k8s/index.js'

// Must match the field list in `add.ts` so `ssh servers update` edits the same
// shape it was created with.
const fields: FieldDef[] = [
  {
    description: 'Bastion / jump host (first SSH hop, optional — omit for a direct connection to the Kubernetes host)',
    name: 'bastionHost',
    required: false,
    type: 'string',
  },
  {description: 'Kubernetes host (second SSH hop, runs kubectl)', name: 'sshHost', type: 'string'},
  {char: 'u', description: 'SSH username for both hops', name: 'sshUser', type: 'string'},
  {char: 'n', description: 'Kubernetes namespace', name: 'namespace', type: 'string'},
  {description: 'Pod component label', name: 'component', type: 'string'},
  {description: 'Pod role label', name: 'role', type: 'string'},
  {description: 'Container name within the pod', name: 'container', type: 'string'},
]

export default createAuthUpdateCommand({
  clearClients: closeConnections,
  configFile: SERVER_CONFIG_FILE,
  fields,
  serviceName: 'SSH Server',
  testConnection: testServerConnection,
})
