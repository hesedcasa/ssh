/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import {type SinonStub, stub} from 'sinon'

import {SERVER_CONFIG_FILE} from '../../src/k8s/index.js'

/**
 * Guards the profile-resolution contract of `resolveProfiles` (via the
 * side-effect-free `getExecAllowlist` entry point): explicit flag → recorded
 * default → first profile on disk when `getDefaultProfile` rejects.
 *
 * The command tests esmock-stub `src/k8s/index.js` wholesale, so a behavioral
 * drift behind `createProfileManager` (e.g. `getDefaultProfile` semantics
 * changing in a `@hesed/plugin-lib` bump) would never surface there — this
 * suite pins it.
 */
describe('k8s profile resolution', () => {
  let getExecAllowlist: any
  let createProfileManagerStub: SinonStub
  let readProfilesStub: SinonStub
  let getDefaultProfileStub: SinonStub

  // Two profiles whose allowlists name the profile they belong to, so each
  // assertion can tell which profile resolved.
  const profiles = {
    production: {
      allowedExecCommands: ['production-allowlist'],
      component: 'api',
      container: 'app',
      namespace: 'sa-prod',
      role: 'app',
      sshHost: 'k8s-node.example.com',
      sshUser: 'allen',
    },
    staging: {
      allowedExecCommands: ['staging-allowlist'],
      component: 'api',
      container: 'app',
      namespace: 'sa-staging',
      role: 'app',
      sshHost: 'k8s-staging.example.com',
      sshUser: 'deploy',
    },
  }

  const mockConfig = {bin: 'ssh', configDir: '/tmp/unused'} as any

  beforeEach(async () => {
    readProfilesStub = stub().resolves(profiles)
    getDefaultProfileStub = stub().resolves('production')
    createProfileManagerStub = stub().returns({
      getDefaultProfile: getDefaultProfileStub,
      readProfiles: readProfilesStub,
    })

    const imported = await esmock(
      '../../src/k8s/index.js',
      {},
      {'@hesed/plugin-lib': {createProfileManager: createProfileManagerStub}},
    )
    getExecAllowlist = imported.getExecAllowlist
  })

  it('opens the profile store from SERVER_CONFIG_FILE', async () => {
    await getExecAllowlist(mockConfig)

    expect(createProfileManagerStub.calledOnce).to.be.true
    expect(createProfileManagerStub.firstCall.args[2]).to.equal(SERVER_CONFIG_FILE)
  })

  it('prefers the explicit profile flag over the recorded default', async () => {
    const allowlist = await getExecAllowlist(mockConfig, 'staging')

    expect(allowlist).to.deep.equal(['staging-allowlist'])
  })

  it('uses the recorded default profile when no flag is given', async () => {
    getDefaultProfileStub.resolves('staging')

    const allowlist = await getExecAllowlist(mockConfig)

    expect(allowlist).to.deep.equal(['staging-allowlist'])
  })

  it('falls back to the first profile when getDefaultProfile rejects', async () => {
    getDefaultProfileStub.rejects(new Error('Missing authentication config'))

    const allowlist = await getExecAllowlist(mockConfig)

    expect(allowlist).to.deep.equal(['production-allowlist'])
  })

  it('refuses to resolve when no profile exists at all', async () => {
    readProfilesStub.resolves({})

    try {
      await getExecAllowlist(mockConfig)
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/No SSH server profile found/)
    }
  })
})
