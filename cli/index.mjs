#!/usr/bin/env node
// Entry point (commander). Commands:
//   init      interactive (or flag-driven) selection of gates, per project or globally
//   registry  --check validates registry.json; --list prints the catalog

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  EXIT_CODE,
  LIST_SEPARATOR,
  REGISTRY_PATH,
  REPOSITORY_ROOT,
} from './constants.mjs';
import { loadRegistry, validateRegistry } from './registry.mjs';
import { registerTaskCommand } from './task.mjs';

const packageManifest = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_CODE.FAILURE);
}

function splitList(value) {
  return value
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean);
}

function registryCheck() {
  const problems = validateRegistry(
    JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')),
  );
  if (problems.length > 0) {
    fail(`registry.json is invalid:\n- ${problems.join('\n- ')}`);
  }
  process.stdout.write('registry.json OK\n');
}

function registryList() {
  const registry = loadRegistry();
  for (const family of registry.families) {
    process.stdout.write(`${family.name} (${family.id})\n`);
    for (const gate of family.gates) {
      const marker = gate.default ? '*' : ' ';
      process.stdout.write(`  ${marker} ${gate.id}  ${gate.configKey}\n`);
    }
  }
  process.stdout.write('\n* = recommended default\n');
}

const program = new Command()
  .name(packageManifest.name)
  .description(packageManifest.description)
  .version(packageManifest.version);

program
  .command('init')
  .description('Choose which gates to adopt and write the config.')
  .option('--project', 'apply to this project (<root>/.ai/config.json)')
  .option('--global', 'apply globally (~/.claude/claude-gates/config.json)')
  .option('--defaults', 'enable the recommended defaults')
  .option('--all', 'enable every gate')
  .option('--none', "record a 'no' so you are not asked again")
  .option(
    '--families <ids>',
    'enable whole families, comma-separated',
    splitList,
  )
  .option(
    '--gates <ids>',
    'enable individual gates, comma-separated',
    splitList,
  )
  .option('-y, --yes', 'never prompt; use flags and defaults')
  .option('--no-install', 'write the config but do not install the plugin')
  .option(
    '--no-remove-previous',
    'keep any previously installed plugin version instead of removing it first',
  )
  .option('--dry-run', 'show the selection without writing')
  .action(async (options) => {
    const { runInit } = await import('./init.mjs');
    await runInit(options);
  });

program
  .command('registry')
  .description('Inspect registry.json.')
  .option('--check', 'validate the registry')
  .option('--list', 'print families and gates')
  .action((options) => {
    if (options.check) return registryCheck();
    if (options.list) return registryList();
    return fail('registry needs --check or --list');
  });

registerTaskCommand(program);

program.parseAsync(process.argv).catch((error) => fail(error.message));
