# ssh

CLI for SSH access to Kubernetes pods

[![Version](https://img.shields.io/npm/v/@hesed/ssh.svg)](https://npmjs.org/package/@hesed/ssh)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/ssh.svg)](https://npmjs.org/package/@hesed/ssh)

# Install

```bash
sdkck plugins install @hesed/ssh
```

<!-- toc -->
* [ssh](#ssh)
* [Install](#install)
* [SSH to Kubernetes pods](#ssh-to-kubernetes-pods)
* [1. Add a server profile (interactive, or pass the flags below)](#1-add-a-server-profile-interactive-or-pass-the-flags-below)
* [2. Run a bash command in the first running pod](#2-run-a-bash-command-in-the-first-running-pod)
* [3. Fan out across ALL pods (labelled output — useful for log scanning)](#3-fan-out-across-all-pods-labelled-output--useful-for-log-scanning)
* [4. Laravel artisan](#4-laravel-artisan)
* [Artisan subcommand flags need `--` to separate them from oclif flags:](#artisan-subcommand-flags-need----to-separate-them-from-oclif-flags)
* [5. PHP tinker (no escaping needed — pass raw PHP)](#5-php-tinker-no-escaping-needed--pass-raw-php)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# SSH to Kubernetes pods

This plugin reaches application pods via an SSH bastion chain
(local → bastion → kubectl host → `kubectl exec`). Every connection detail
(bastion host, kubectl host, namespace, pod labels, container, SSH user) lives
in a **server profile** stored in `ssh-servers.json` under oclif's config dir.

```bash
# 1. Add a server profile (interactive, or pass the flags below)
ssh ssh servers add -p prod --bastionHost sglogin.example.com \
  --sshHost k8s.example.com -u allen -n sa-prod

# 2. Run a bash command in the first running pod
ssh ssh exec pwd -p prod

# 3. Fan out across ALL pods (labelled output — useful for log scanning)
ssh ssh exec --all "tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log" -p prod

# 4. Laravel artisan
ssh ssh artisan cache:clear -p prod
# Artisan subcommand flags need `--` to separate them from oclif flags:
ssh ssh artisan -- queue:work --timeout=60

# 5. PHP tinker (no escaping needed — pass raw PHP)
ssh ssh tinker "App\\Models\\User::count()" -p prod
```

> **Migration safety:** `ssh artisan` blocks nothing by default — each
> profile has its own opt-in artisan blacklist (empty until you configure
> it). Migrations are destructive, so lock them down per profile:
>
> ```bash
> ssh ssh servers safety -p prod --add migrate --add migrate:fresh \
>   --add "migrate:fresh --seed" --add migrate:rollback --add migrate:reset \
>   --add migrate:refresh --add migrate:install --add migrate:status \
>   --add migrate:change
> ssh ssh servers safety -p prod  # view the current blacklist
> ```

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/ssh
$ ssh COMMAND
running command...
$ ssh (--version)
@hesed/ssh/0.1.0 darwin-arm64 node-v22.22.3
$ ssh --help [COMMAND]
USAGE
  $ ssh COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`ssh ssh artisan COMMAND`](#ssh-ssh-artisan-command)
* [`ssh ssh exec COMMAND`](#ssh-ssh-exec-command)
* [`ssh ssh servers add`](#ssh-ssh-servers-add)
* [`ssh ssh servers delete`](#ssh-ssh-servers-delete)
* [`ssh ssh servers list`](#ssh-ssh-servers-list)
* [`ssh ssh servers profile`](#ssh-ssh-servers-profile)
* [`ssh ssh servers safety`](#ssh-ssh-servers-safety)
* [`ssh ssh servers test`](#ssh-ssh-servers-test)
* [`ssh ssh servers update`](#ssh-ssh-servers-update)
* [`ssh ssh tinker PHP`](#ssh-ssh-tinker-php)

## `ssh ssh artisan COMMAND`

Run a Laravel artisan command in a Kubernetes pod (blocked by the profile's artisan blacklist, if any — see `ssh servers safety`)

```
USAGE
  $ ssh ssh artisan COMMAND [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>]
    [-p <value>] [--role <value>]

ARGUMENTS
  COMMAND  Artisan command to run (e.g. cache:clear, route:list, queue:restart)

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Run a Laravel artisan command in a Kubernetes pod (blocked by the profile's artisan blacklist, if any — see `ssh
  servers safety`)

EXAMPLES
  $ ssh ssh artisan cache:clear

  $ ssh ssh artisan route:list -p prod

  $ ssh ssh artisan queue:restart --namespace sa-testqa
```

_See code: [src/commands/ssh/artisan.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/artisan.ts)_

## `ssh ssh exec COMMAND`

Execute a bash command in a Kubernetes pod via SSH (local → bastion → kubectl host → pod)

```
USAGE
  $ ssh ssh exec COMMAND [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>]
    [-p <value>] [--role <value>]

ARGUMENTS
  COMMAND  Command to execute in the pod

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Execute a bash command in a Kubernetes pod via SSH (local → bastion → kubectl host → pod)

EXAMPLES
  $ ssh ssh exec pwd

  $ ssh ssh exec "tail -20 storage/logs/laravel-$(date +%Y-%m-%d).log" --all -p prod

  $ ssh ssh exec "grep ERROR storage/logs/laravel.log" --namespace sa-testqa
```

_See code: [src/commands/ssh/exec.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/exec.ts)_

## `ssh ssh servers add`

Add SSH Server authentication

```
USAGE
  $ ssh ssh servers add [--json] [-p <value>] [--bastionHost <value>] [--sshHost <value>] [-u <value>] [-n <value>]
    [--component <value>] [--role <value>] [--container <value>]

FLAGS
  -n, --namespace=<value>    Kubernetes namespace
  -p, --profile=<value>      Profile name
  -u, --sshUser=<value>      SSH username for both hops
      --bastionHost=<value>  Bastion / jump host (first SSH hop)
      --component=<value>    Pod component label
      --container=<value>    Container name within the pod
      --role=<value>         Pod role label
      --sshHost=<value>      Kubernetes host (second SSH hop, runs kubectl)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Add SSH Server authentication

EXAMPLES
  $ ssh ssh servers add

  $ ssh ssh servers add -p prod
```

_See code: [src/commands/ssh/servers/add.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/add.ts)_

## `ssh ssh servers delete`

Delete an authentication profile

```
USAGE
  $ ssh ssh servers delete [--json] [-p <value>]

FLAGS
  -p, --profile=<value>  Profile to delete

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete an authentication profile

EXAMPLES
  $ ssh ssh servers delete

  $ ssh ssh servers delete -p prod
```

_See code: [src/commands/ssh/servers/delete.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/delete.ts)_

## `ssh ssh servers list`

List authentication profiles

```
USAGE
  $ ssh ssh servers list [--json]

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List authentication profiles

EXAMPLES
  $ ssh ssh servers list
```

_See code: [src/commands/ssh/servers/list.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/list.ts)_

## `ssh ssh servers profile`

Set or show the default authentication profile

```
USAGE
  $ ssh ssh servers profile [--json] [--default <value>]

FLAGS
  --default=<value>  Profile to set as default

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set or show the default authentication profile

EXAMPLES
  $ ssh ssh servers profile

  $ ssh ssh servers profile --default test
```

_See code: [src/commands/ssh/servers/profile.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/profile.ts)_

## `ssh ssh servers safety`

View or edit a server profile's artisan blacklist (subcommand prefixes `ssh artisan` refuses to run)

```
USAGE
  $ ssh ssh servers safety [--json] [--add <value>...] [--clear] [-p <value>] [--remove <value>...]

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --add=<value>...     Add a command prefix to the blacklist (repeatable)
      --clear              Remove every entry from the profile's blacklist
      --remove=<value>...  Remove a command prefix from the blacklist (repeatable)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  View or edit a server profile's artisan blacklist (subcommand prefixes `ssh artisan` refuses to run)

EXAMPLES
  $ ssh ssh servers safety

  $ ssh ssh servers safety -p prod

  $ ssh ssh servers safety -p prod --add migrate --add migrate:fresh

  $ ssh ssh servers safety -p prod --remove migrate:fresh

  $ ssh ssh servers safety -p prod --clear
```

_See code: [src/commands/ssh/servers/safety.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/safety.ts)_

## `ssh ssh servers test`

Test authentication and connection

```
USAGE
  $ ssh ssh servers test [--json] [-p <value>]

FLAGS
  -p, --profile=<value>  Authentication profile name

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Test authentication and connection

EXAMPLES
  $ ssh ssh servers test

  $ ssh ssh servers test -p prod
```

_See code: [src/commands/ssh/servers/test.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/test.ts)_

## `ssh ssh servers update`

Update SSH Server authentication

```
USAGE
  $ ssh ssh servers update [--json] [-p <value>] [--bastionHost <value>] [--sshHost <value>] [-u <value>] [-n <value>]
    [--component <value>] [--role <value>] [--container <value>]

FLAGS
  -n, --namespace=<value>    Kubernetes namespace
  -p, --profile=<value>      Profile name
  -u, --sshUser=<value>      SSH username for both hops
      --bastionHost=<value>  Bastion / jump host (first SSH hop)
      --component=<value>    Pod component label
      --container=<value>    Container name within the pod
      --role=<value>         Pod role label
      --sshHost=<value>      Kubernetes host (second SSH hop, runs kubectl)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Update SSH Server authentication

EXAMPLES
  $ ssh ssh servers update

  $ ssh ssh servers update -p test
```

_See code: [src/commands/ssh/servers/update.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/servers/update.ts)_

## `ssh ssh tinker PHP`

Execute PHP code in a Kubernetes pod via `artisan tinker --execute` (no shell escaping needed)

```
USAGE
  $ ssh ssh tinker PHP [--json] [--all] [--component <value>] [--container <value>] [--namespace <value>] [-p
    <value>] [--role <value>]

ARGUMENTS
  PHP  PHP code to execute via tinker (no escaping needed)

FLAGS
  -p, --profile=<value>    SSH server profile name from config
      --all                Run on ALL running pods; output is labelled per pod
      --component=<value>  Override pod component label (default: from profile)
      --container=<value>  Override container name (default: from profile)
      --namespace=<value>  Override Kubernetes namespace (default: from profile)
      --role=<value>       Override pod role label (default: from profile)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Execute PHP code in a Kubernetes pod via `artisan tinker --execute` (no shell escaping needed)

EXAMPLES
  $ ssh ssh tinker "App\\Models\\User::count()"

  $ ssh ssh tinker "echo User::first()->email;" -p prod

  $ ssh ssh tinker "Cache::forget('some_key')"
```

_See code: [src/commands/ssh/tinker.ts](https://github.com/hesedcasa/ssh/blob/v0.1.0/src/commands/ssh/tinker.ts)_
<!-- commandsstop -->
