/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai'
import esmock from 'esmock'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {type SinonStub, stub} from 'sinon'

import {getExecAllowlist as getExecAllowlistReal, SERVER_CONFIG_FILE} from '../../src/k8s/index.js'

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

/**
 * Guards the local selection branches of `resolveProfiles` (via the
 * side-effect-free `getExecAllowlist` entry point): explicit flag → recorded
 * default → first profile on disk when `getDefaultProfile` rejects.
 *
 * The command tests esmock-stub `src/k8s/index.js` wholesale, so a behavioral
 * drift behind `createProfileManager` (e.g. `getDefaultProfile` semantics
 * changing in a `@hesed/plugin-lib` bump) would never surface there — the
 * stubs here pin the branches. The library's own on-disk behavior is pinned
 * separately by the suite below.
 */
describe('k8s profile resolution', () => {
  let getExecAllowlist: any
  let createProfileManagerStub: SinonStub
  let readProfilesStub: SinonStub
  let getDefaultProfileStub: SinonStub

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

  /**
   * The stubbed suite above cannot see `@hesed/plugin-lib` itself — a future
   * bump could change how saved defaults are read while all five tests still
   * pass. These cases drive the same entry point through the real
   * `createProfileManager` against a temporary `ssh-servers.json`.
   */
  describe('via the real profile store', () => {
    let configDir: string

    const realConfig = () => ({bin: 'ssh', configDir}) as any

    const writeProfileStore = async (store: object): Promise<void> => {
      await fs.writeFile(path.join(configDir, SERVER_CONFIG_FILE), JSON.stringify(store))
    }

    beforeEach(async () => {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-k8s-profiles-'))
    })

    afterEach(async () => {
      await fs.rm(configDir, {force: true, recursive: true})
    })

    it('uses the defaultProfile recorded on disk', async () => {
      await writeProfileStore({defaultProfile: 'staging', profiles})

      const allowlist = await getExecAllowlistReal(realConfig())

      expect(allowlist).to.deep.equal(['staging-allowlist'])
    })

    it('errors on a store without a defaultProfile key (no silent first-profile fallback)', async () => {
      // `getDefaultProfile` resolves 'default' rather than rejecting when the
      // key is absent, so the first-profile fallback must not kick in — the
      // bump audited this exact outcome.
      await writeProfileStore({profiles})

      try {
        await getExecAllowlistReal(realConfig())
        expect.fail('should have thrown')
      } catch (error: any) {
        expect(error.message).to.match(/Profile "default" not found/)
      }
    })

    it('errors when the profile store is missing entirely', async () => {
      try {
        await getExecAllowlistReal(realConfig())
        expect.fail('should have thrown')
      } catch (error: any) {
        expect(error.message).to.match(/No authentication profiles found/)
      }
    })
  })
})
