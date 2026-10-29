#!/usr/bin/env node
/**
 * Prepares the PostgreSQL databases the museum app needs and brings their schema up to date.
 *
 * DATABASE_URL (development) and DATABASE_URL_TEST (disposable, used by Vitest) must
 * already point at PostgreSQL. When POSTGRES_ADMIN_URL is supplied (a role allowed to
 * CREATE DATABASE) the script also creates both databases. Otherwise it assumes they
 * already exist and only applies migrations.
 *
 * Schema application prefers real migrations: if prisma/migrations exists it runs
 * `migrate deploy`; otherwise it falls back to `db push` for a fresh checkout.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('dotenv').config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true })

const ROOT = path.resolve(import.meta.dirname, '..')
const hasMigrations = fs.existsSync(path.join(ROOT, 'prisma', 'migrations'))

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function isPostgres(dsn) {
  return typeof dsn === 'string' && (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://'))
}

function parseDsn(dsn) {
  const url = new URL(dsn)
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  }
}

function deriveAdminDsn(dsn) {
  const url = new URL(dsn)
  url.pathname = '/postgres'
  return url.toString()
}

function psql(connection, args) {
  const env = { ...process.env, PGPASSWORD: connection.password }
  const command = [
    '-h',
    connection.host,
    '-p',
    connection.port,
    '-d',
    connection.database,
    '-v',
    'ON_ERROR_STOP=1',
    ...args,
  ]
  if (connection.user) command.unshift('-U', connection.user)
  return spawnSync('psql', command, { encoding: 'utf8', env })
}

function ensureDatabase(adminDsn, name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`)
  const connection = parseDsn(adminDsn)
  const lookup = psql(connection, ['-tAc', `SELECT 1 FROM pg_database WHERE datname = '${name}'`])
  if (lookup.error) {
    throw new Error('psql is not installed or not on PATH. Create the databases manually or install the PostgreSQL client.')
  }
  if (lookup.status !== 0) {
    throw new Error(`Could not inspect PostgreSQL databases: ${lookup.stderr?.trim() || 'unknown error'}`)
  }
  if (lookup.stdout.trim() === '1') {
    console.log(`Database ${name} already exists.`)
    return
  }

  console.log(`Creating database ${name} ...`)
  const created = psql(connection, ['-c', `CREATE DATABASE "${name}"`])
  if (created.status !== 0) {
    throw new Error(
      `Could not create ${name}: ${created.stderr?.trim() || 'unknown error'}\n` +
        '    Create it manually (createdb) or provide POSTGRES_ADMIN_URL with a role that can CREATE DATABASE.',
    )
  }
}

function main() {
  const dev = process.env.DATABASE_URL
  const test = process.env.DATABASE_URL_TEST
  if (!isPostgres(dev)) throw new Error('DATABASE_URL must be a postgresql:// connection string')
  if (!isPostgres(test)) throw new Error('DATABASE_URL_TEST must be a postgresql:// connection string')
  if (!/test/i.test(test)) throw new Error('DATABASE_URL_TEST must reference a database whose name contains "test"')

  const adminDsn = process.env.POSTGRES_ADMIN_URL ?? deriveAdminDsn(dev)
  try {
    ensureDatabase(adminDsn, parseDsn(dev).database)
    ensureDatabase(adminDsn, parseDsn(test).database)
  } catch (error) {
    console.warn(`\n  ! ${error.message}\n`)
    console.warn('  Continuing — assuming both databases already exist.\n')
  }

  for (const [label, url] of [
    ['development', dev],
    ['test', test],
  ]) {
    console.log(`\nApplying schema to the ${label} database ...`)
    if (hasMigrations) run('npx', ['prisma', 'migrate', 'deploy'], { DATABASE_URL: url })
    else run('npx', ['prisma', 'db', 'push', '--skip-generate'], { DATABASE_URL: url })
  }

  run('npx', ['prisma', 'generate'])
  console.log('\nReady. PostgreSQL schema is in sync for development and test.')
}

try {
  main()
} catch (error) {
  console.error(error.message ?? error)
  process.exit(1)
}
