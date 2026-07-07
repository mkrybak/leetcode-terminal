#!/usr/bin/env node
import * as cmd from '../src/commands.js';
import { AuthError } from '../src/api.js';
import { c } from '../src/render.js';

const HELP = `
${c.bold('lc')} — LeetCode from your terminal

${c.bold('Setup')}
  lc login                      save your LeetCode session cookies
  lc whoami                     verify authentication

${c.bold('Problems')}
  lc list [--difficulty easy|medium|hard] [--search word] [--limit N] [--skip N]
  lc daily [--pull]             today's daily challenge
  lc show <slug|number>         print the problem statement
  lc pull <slug|number> [--lang javascript|typescript] [--force]
                                create solutions/NNNN-slug.js from the official template

${c.bold('Solve')}
  lc test <slug|number>         run your file against the example testcases (LeetCode judge)
     [--input "..."]            custom testcase ("\\n" for newlines)
     [--input-file file.txt]    custom testcases from a file
  lc submit <slug|number>       real submission — shows verdict and the exact failing case

${c.dim('Problems are matched to files in solutions/ automatically.')}
`;

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

const [, , command, ...rest] = process.argv;
const { args, flags } = parseArgv(rest);

const commands = {
  login: () => cmd.login(flags),
  whoami: () => cmd.whoami(),
  list: () => cmd.list(flags),
  show: () => cmd.show(args),
  pull: () => cmd.pull(args, flags),
  test: () => cmd.test(args, flags),
  submit: () => cmd.submitCmd(args),
  daily: () => cmd.daily(args, flags),
};

if (!command || command === 'help' || flags.help) {
  console.log(HELP);
  process.exit(0);
}

const fn = commands[command];
if (!fn) {
  console.error(c.red(`Unknown command: ${command}`));
  console.log(HELP);
  process.exit(2);
}

try {
  await fn();
} catch (e) {
  if (e instanceof AuthError) {
    console.error(c.red('✗ ' + e.message));
  } else {
    console.error(c.red('✗ ' + (e.message || e)));
  }
  process.exit(1);
}
