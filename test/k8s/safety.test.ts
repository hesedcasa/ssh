import {expect} from 'chai'

import {applyListEdits, checkCommandAllowlist, checkCommandBlacklist, formatCommandList} from '../../src/k8s/safety.js'

describe('k8s:safety', () => {
  // Representative blacklist a profile might configure via `ssh servers
  // safety --add`; checkCommandBlacklist itself has no built-in defaults.
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

  describe('checkCommandBlacklist', () => {
    it('blocks bare migrate', () => {
      const result = checkCommandBlacklist('migrate', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('blocks migrate:status', () => {
      const result = checkCommandBlacklist('migrate:status', blacklist)
      expect(result.allowed).to.be.false
    })

    it('blocks migrate:fresh --seed (matched via the migrate prefix entry)', () => {
      // `migrate:fresh --seed` starts with `migrate:`, so it matches the bare
      // `migrate` blacklist entry (listed first) rather than the multi-token
      // `migrate:fresh --seed` entry. Either way it is blocked.
      const result = checkCommandBlacklist('migrate:fresh --seed', blacklist)
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate')
    })

    it('reports the exact multi-token entry when it is the only match', () => {
      const result = checkCommandBlacklist('migrate:fresh --seed', ['migrate:fresh --seed'])
      expect(result.allowed).to.be.false
      expect(result.blockedCommand).to.equal('migrate:fresh --seed')
    })

    it('blocks migrate variants regardless of case', () => {
      expect(checkCommandBlacklist('MIGRATE', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('Migrate:Rollback', blacklist).allowed).to.be.false
    })

    it('blocks migrate with leading/trailing whitespace', () => {
      expect(checkCommandBlacklist('  migrate  ', blacklist).allowed).to.be.false
    })

    it('allows safe commands', () => {
      expect(checkCommandBlacklist('cache:clear', blacklist).allowed).to.be.true
      expect(checkCommandBlacklist('route:list', blacklist).allowed).to.be.true
      expect(checkCommandBlacklist('queue:restart', blacklist).allowed).to.be.true
      expect(checkCommandBlacklist('tinker', blacklist).allowed).to.be.true
    })

    it('does not false-positive on commands that merely contain the substring', () => {
      // "migrate" as a substring inside another token must not match.
      expect(checkCommandBlacklist('migratelog:show', blacklist).allowed).to.be.true
      expect(checkCommandBlacklist('db:show-migrations', blacklist).allowed).to.be.true
    })

    it('returns an empty allowed result (no blockedCommand) for safe commands', () => {
      const result = checkCommandBlacklist('cache:clear', blacklist)
      expect(result.allowed).to.be.true
      expect(result.blockedCommand).to.be.undefined
      expect(result.reason).to.be.undefined
    })

    it('respects a custom blacklist', () => {
      expect(checkCommandBlacklist('cache:clear', ['cache:clear']).allowed).to.be.false
      expect(checkCommandBlacklist('migrate', []).allowed).to.be.true
    })

    it('ignores blank blacklist entries', () => {
      expect(checkCommandBlacklist('cache:clear', ['', '   ']).allowed).to.be.true
    })

    it('labels the reason with the given command kind', () => {
      expect(checkCommandBlacklist('migrate', blacklist, 'artisan').reason).to.include('artisan command "migrate"')
      expect(checkCommandBlacklist('migrate', blacklist, 'tinker').reason).to.include('tinker command "migrate"')
      // Defaults to a generic label when no kind is given.
      expect(checkCommandBlacklist('migrate', blacklist).reason).to.include('command "migrate"')
    })

    it('blocks a blacklisted command smuggled in as one link of a chain', () => {
      expect(checkCommandBlacklist('cache:clear && migrate', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('cache:clear; migrate', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('cache:clear | migrate', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('cache:clear `migrate`', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('cache:clear $(migrate)', blacklist).allowed).to.be.false
      expect(checkCommandBlacklist('cache:clear\nmigrate', blacklist).allowed).to.be.false
    })

    it('allows a chain of safe commands when nothing in it is blacklisted', () => {
      expect(checkCommandBlacklist('cache:clear && route:list', blacklist).allowed).to.be.true
      expect(checkCommandBlacklist('cache:clear; route:list', blacklist).allowed).to.be.true
    })

    it('rejects redirection outright even when nothing in the chain is blacklisted', () => {
      expect(checkCommandBlacklist('cache:clear > /etc/passwd', blacklist).allowed).to.be.false
    })

    it('allows chaining and redirection when the blacklist is empty (guard disabled)', () => {
      expect(checkCommandBlacklist('cache:clear && migrate', []).allowed).to.be.true
      expect(checkCommandBlacklist('cache:clear > /etc/passwd', []).allowed).to.be.true
    })
  })

  describe('checkCommandAllowlist', () => {
    // Representative allowlist a profile might configure; an empty list
    // disables the guard entirely.
    const allowlist = ['tail', 'grep', 'php artisan cache:clear']

    it('allows every command when the allowlist is empty', () => {
      expect(checkCommandAllowlist('rm -rf /', []).allowed).to.be.true
      expect(checkCommandAllowlist('pwd', []).allowed).to.be.true
    })

    it('allows an exact match', () => {
      expect(checkCommandAllowlist('tail', allowlist).allowed).to.be.true
    })

    it('allows a command starting with an allowed prefix', () => {
      expect(checkCommandAllowlist('tail -20 storage/logs/laravel.log', allowlist).allowed).to.be.true
      expect(checkCommandAllowlist('grep ERROR storage/logs/laravel.log', allowlist).allowed).to.be.true
    })

    it('allows a multi-token entry to match with extra arguments', () => {
      expect(checkCommandAllowlist('php artisan cache:clear --quiet', allowlist).allowed).to.be.true
    })

    it('blocks a command not covered by any entry, with a reason', () => {
      const result = checkCommandAllowlist('rm -rf /', allowlist)
      expect(result.allowed).to.be.false
      expect(result.reason).to.match(/allowlist/i)
      expect(result.reason).to.include('rm -rf /')
    })

    it('does not false-positive on commands that merely share a token prefix', () => {
      expect(checkCommandAllowlist('tailscale status', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('grepx foo', allowlist).allowed).to.be.false
    })

    it('matches case-insensitively and ignores extra whitespace', () => {
      expect(checkCommandAllowlist('  TAIL   -20   log  ', allowlist).allowed).to.be.true
    })

    it('ignores blank allowlist entries (all-blank list allows everything)', () => {
      expect(checkCommandAllowlist('rm -rf /', ['', '   ']).allowed).to.be.true
      expect(checkCommandAllowlist('tail -1 log', ['', 'tail']).allowed).to.be.true
    })

    it('labels the reason with the given command kind', () => {
      expect(checkCommandAllowlist('rm -rf /', allowlist, 'exec').reason).to.include('exec allowlist')
      expect(checkCommandAllowlist('rm -rf /', allowlist, 'tinker').reason).to.include('tinker allowlist')
    })

    it('blocks a chained/substituted command when any link is not allowlisted', () => {
      expect(checkCommandAllowlist('tail -1 log && rm -rf /', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('tail -1 log; rm -rf /', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('tail -1 log | tee /etc/passwd', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('tail `id`', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('tail $(id)', allowlist).allowed).to.be.false
    })

    it('treats a bare newline as a command separator, same as ;', () => {
      expect(checkCommandAllowlist('tail -1 log\nrm -rf /', allowlist).allowed).to.be.false
      expect(checkCommandAllowlist('tail -1 log\r\nrm -rf /', allowlist).allowed).to.be.false
    })

    it('rejects redirection outright, since there is no command to check', () => {
      expect(checkCommandAllowlist('tail -1 log > /etc/passwd', allowlist).allowed).to.be.false
    })

    it('allows a chain where every link matches the allowlist', () => {
      expect(checkCommandAllowlist('tail -1 log && grep ERROR log', allowlist).allowed).to.be.true
      expect(checkCommandAllowlist('tail -1 log; grep ERROR log', allowlist).allowed).to.be.true
      expect(checkCommandAllowlist('grep ERROR log | tail -20', allowlist).allowed).to.be.true
    })

    it('does not split on chain-looking characters inside quotes', () => {
      expect(checkCommandAllowlist('grep "a && b" file', allowlist).allowed).to.be.true
    })

    it('ignores a trailing separator with nothing after it', () => {
      expect(checkCommandAllowlist('tail -1 log;', allowlist).allowed).to.be.true
    })

    it('allows chaining and redirection when the allowlist is empty (guard disabled)', () => {
      expect(checkCommandAllowlist('pwd && whoami', []).allowed).to.be.true
      expect(checkCommandAllowlist('pwd > /etc/passwd', []).allowed).to.be.true
    })
  })

  describe('formatCommandList', () => {
    it('bullets each entry', () => {
      expect(formatCommandList(['migrate', 'migrate:fresh'], 'empty')).to.equal('  • migrate\n  • migrate:fresh')
    })

    it('falls back to the empty message for an empty list', () => {
      expect(formatCommandList([], 'nothing blocked')).to.equal('  nothing blocked')
    })
  })

  describe('applyListEdits', () => {
    it('adds new entries without duplicating existing ones (case-insensitive)', () => {
      expect(applyListEdits(['migrate'], ['MIGRATE', 'migrate:fresh'])).to.deep.equal(['migrate', 'migrate:fresh'])
    })

    it('removes entries case-insensitively', () => {
      expect(applyListEdits(['migrate', 'migrate:fresh'], undefined, ['MIGRATE:FRESH'])).to.deep.equal(['migrate'])
    })

    it('clears the list', () => {
      expect(applyListEdits(['migrate'], undefined, undefined, true)).to.deep.equal([])
    })

    it('applies clear before remove and add, so clear+add replaces the list', () => {
      expect(applyListEdits(['migrate'], ['db:wipe'], undefined, true)).to.deep.equal(['db:wipe'])
    })
  })
})
