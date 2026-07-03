import {expect} from 'chai'

import type {K8sConfig} from '../../src/k8s/config-loader.js'

import {DEFAULT_ARTISAN_PREFIX, getServerConnectionOptions} from '../../src/k8s/config-loader.js'

describe('k8s/config-loader', () => {
  const mockConfig: K8sConfig = {
    defaultProfile: 'prod',
    profiles: {
      custom: {
        artisanPrefix: 'php /app/artisan',
        bastionHost: 'bastion.example.com',
        blacklistedArtisanCommands: ['migrate', 'migrate:fresh --seed'],
        component: 'worker',
        container: 'app-worker',
        namespace: 'sa-staging',
        role: 'job',
        sshHost: 'k8s.example.com',
        sshUser: 'deploy',
      },
      prod: {
        bastionHost: 'sglogin.example.com',
        component: 'api',
        container: 'app',
        namespace: 'sa-prod',
        role: 'app',
        sshHost: 'k8s-node.example.com',
        sshUser: 'allen',
      },
    },
  }

  describe('getServerConnectionOptions', () => {
    it('resolves a fully-specified profile', () => {
      const conn = getServerConnectionOptions(mockConfig, 'prod')

      expect(conn.profileName).to.equal('prod')
      expect(conn.bastionHost).to.equal('sglogin.example.com')
      expect(conn.sshHost).to.equal('k8s-node.example.com')
      expect(conn.sshUser).to.equal('allen')
      expect(conn.namespace).to.equal('sa-prod')
      expect(conn.component).to.equal('api')
      expect(conn.role).to.equal('app')
      expect(conn.container).to.equal('app')
      // artisanPrefix is still optional and falls back to a default
      expect(conn.artisanPrefix).to.equal(DEFAULT_ARTISAN_PREFIX)
      // no blacklist configured on this profile
      expect(conn.blacklistedArtisanCommands).to.deep.equal([])
    })

    it('preserves explicit overrides on a fully-specified profile', () => {
      const conn = getServerConnectionOptions(mockConfig, 'custom')

      expect(conn.component).to.equal('worker')
      expect(conn.role).to.equal('job')
      expect(conn.container).to.equal('app-worker')
      expect(conn.artisanPrefix).to.equal('php /app/artisan')
      expect(conn.namespace).to.equal('sa-staging')
      expect(conn.blacklistedArtisanCommands).to.deep.equal(['migrate', 'migrate:fresh --seed'])
    })

    it('throws when the profile does not exist', () => {
      expect(() => getServerConnectionOptions(mockConfig, 'nonexistent')).to.throw('nonexistent')
    })

    it('lists available profiles in the error message', () => {
      expect(() => getServerConnectionOptions(mockConfig, 'nope')).to.throw('prod')
    })
  })
})
