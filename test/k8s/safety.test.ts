import {expect} from 'chai'

import {checkArtisanBlacklist} from '../../src/k8s/safety.js'

describe('k8s:safety', () => {
  // Representative blacklist a profile might configure via `ssh servers
  // safety --add`; checkArtisanBlacklist itself has no built-in defaults.
  const blacklist = [
    'migrate',
    'migrate:rollback',
    'migrate:fresh',
    'migrate:fresh --seed',
    'migrate:status',
    'migrate:install',
    'migrate:reset',
    'migrate:refresh',
    'migrate:change',
  ]

  describe('checkArtisanBlacklist', () => {
    it('blocks bare migrate', () => {
      const result = checkArtisanBlacklist('migrate', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('blocks migrate:status', () => {
      const result = checkArtisanBlacklist('migrate:status', blacklist)
      expect(result.allowed).to.be.false
    })

    it('blocks migrate:fresh --seed (matched via the migrate prefix entry)', () => {
      // `migrate:fresh --seed` starts with `migrate:`, so it matches the bare
      // `migrate` blacklist entry (listed first) rather than the multi-token
      // `migrate:fresh --seed` entry. Either way it is blocked.
      const result = checkArtisanBlacklist('migrate:fresh --seed', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('reports the exact multi-token entry when it is the only match', () => {
      const result = checkArtisanBlacklist('migrate:fresh --seed', ['migrate:fresh --seed'])
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate:fresh --seed')
    })

    it('blocks migrate variants regardless of case', () => {
      expect(checkArtisanBlacklist('MIGRATE', blacklist).allowed).to.be.false
      expect(checkArtisanBlacklist('Migrate:Rollback', blacklist).allowed).to.be.false
    })

    it('blocks migrate with leading/trailing whitespace', () => {
      expect(checkArtisanBlacklist('  migrate  ', blacklist).allowed).to.be.false
    })

    it('allows safe commands', () => {
      expect(checkArtisanBlacklist('cache:clear', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('route:list', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('queue:restart', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('tinker', blacklist).allowed).to.be.true
    })

    it('does not false-positive on commands that merely contain the substring', () => {
      // "migrate" as a substring inside another token must not match.
      expect(checkArtisanBlacklist('migratelog:show', blacklist).allowed).to.be.true
      expect(checkArtisanBlacklist('db:show-migrations', blacklist).allowed).to.be.true
    })

    it('returns an empty allowed result (no blockedCommand) for safe commands', () => {
      const result = checkArtisanBlacklist('cache:clear', blacklist)
      expect(result.allowed).to.be.true
      expect(result.blockedCommand).to.be.undefined
      expect(result.reason).to.be.undefined
    })

    it('respects a custom blacklist', () => {
      expect(checkArtisanBlacklist('cache:clear', ['cache:clear']).allowed).to.be.false
      expect(checkArtisanBlacklist('migrate', []).allowed).to.be.true
    })
  })
})
