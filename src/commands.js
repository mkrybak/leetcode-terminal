import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import * as api from './api.js';
import { getConfig, saveConfig, getMeta, saveMeta, SOLUTIONS_DIR } from './config.js';
import { c, diffColor, htmlToText, hr, block } from './render.js';
import {
  getLeetcodeCookies,
  runningChromiumBrowsers,
  closeBrowser,
  readClipboard,
  parseLeetcodeCookies,
} from './browser-cookies.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const LANG_BY_EXT = { '.js': 'javascript', '.ts': 'typescript' };
const EXT_BY_LANG = { javascript: '.js', typescript: '.ts' };

// ---------- helpers ----------

async function resolveSlug(arg) {
  if (!arg) throw new Error('Missing problem argument (slug or number). Example: lc show two-sum');
  if (/^\d+$/.test(arg)) {
    const meta = getMeta();
    const hit = Object.entries(meta).find(([, m]) => m.frontendId === String(arg));
    if (hit) return hit[0];
    return api.slugFromId(arg);
  }
  return arg.toLowerCase();
}

function findSolutionFile(slug) {
  const meta = getMeta()[slug];
  if (meta?.file && fs.existsSync(meta.file)) return meta.file;
  if (fs.existsSync(SOLUTIONS_DIR)) {
    const found = fs
      .readdirSync(SOLUTIONS_DIR)
      .find((f) => f.replace(/^\d+-/, '').replace(/\.(js|ts)$/, '') === slug);
    if (found) return path.join(SOLUTIONS_DIR, found);
  }
  return null;
}

async function loadProblem(slug) {
  let meta = getMeta()[slug];
  if (!meta?.questionId) {
    const q = await api.fetchQuestion(slug);
    meta = saveMeta(slug, {
      questionId: q.questionId,
      frontendId: q.questionFrontendId,
      title: q.title,
      difficulty: q.difficulty,
      examples: q.exampleTestcaseList,
    });
  }
  return meta;
}

function requireAuth() {
  const cfg = getConfig();
  if (!cfg.LEETCODE_SESSION || !cfg.csrftoken) {
    throw new api.AuthError('Not logged in. Run: lc login');
  }
}

// ---------- commands ----------

async function finishLogin(session, csrf) {
  saveConfig({ LEETCODE_SESSION: session, csrftoken: csrf });
  const u = await api.whoami();
  if (u?.isSignedIn) {
    console.log(c.green(`✓ Logged in as ${c.bold(u.username)}. Cookies saved to .lc/config.json`));
    return true;
  }
  console.log(c.yellow('Cookies saved, but LeetCode reports you are not signed in — the session may be stale.'));
  return false;
}

async function manualLogin(flags) {
  let session = flags.session;
  let csrf = flags.csrf;
  if (!session || !csrf) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Could not read cookies automatically and no interactive terminal to paste into.\n' +
          'Run `lc login` in a real terminal, or pass --session <val> --csrf <val>.'
      );
    }
    console.log(`
${c.bold('Paste your LeetCode cookies:')}
  1. Log in to ${c.cyan('https://leetcode.com')} in your browser.
  2. Open DevTools (F12) -> Application -> Cookies -> https://leetcode.com
  3. Copy the values of ${c.cyan('LEETCODE_SESSION')} and ${c.cyan('csrftoken')}.
`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    session = session || (await rl.question('LEETCODE_SESSION: ')).trim();
    csrf = csrf || (await rl.question('csrftoken: ')).trim();
    rl.close();
  }
  if (!session || !csrf) throw new Error('Both values are required.');
  await finishLogin(session, csrf);
}

async function clipLogin() {
  console.log(c.dim('Reading cookies from your clipboard...'));
  const { LEETCODE_SESSION, csrftoken } = parseLeetcodeCookies(readClipboard());
  if (!LEETCODE_SESSION || !csrftoken) {
    const missing = [!LEETCODE_SESSION && 'LEETCODE_SESSION', !csrftoken && 'csrftoken']
      .filter(Boolean)
      .join(' and ');
    console.log(c.yellow(`Couldn't find ${missing} in the clipboard.`));
    console.log(`
${c.bold('Copy your cookies first, then re-run')} ${c.cyan('lc login --clip')}${c.bold(':')}
  1. On ${c.cyan('leetcode.com')}, open DevTools (F12) -> ${c.cyan('Network')} tab (reload if empty).
  2. Click any request to leetcode.com -> ${c.cyan('Headers')} -> Request Headers.
  3. Right-click the ${c.cyan('Cookie')} header -> Copy value. It holds both cookies.

Or paste them by hand: ${c.cyan('lc login --manual')}`);
    return;
  }
  console.log(c.green('✓ Found both cookies in the clipboard.'));
  await finishLogin(LEETCODE_SESSION, csrftoken);
}

export async function login(flags) {
  // Explicit values passed -> straight to manual path.
  if (flags.session && flags.csrf) return manualLogin(flags);
  // Read the two cookies from whatever is on the clipboard.
  if (flags.clip) return clipLogin();
  // User explicitly wants to paste.
  if (flags.manual) return manualLogin(flags);

  // Default: read cookies straight from the browser. --browser <name> forces one.
  const preferred = typeof flags.browser === 'string' ? flags.browser : undefined;
  const wantClose = flags['close-browser'];
  console.log(c.dim(preferred ? `Reading LeetCode cookies from ${preferred}...` : 'Reading LeetCode cookies from your browser...'));
  let found;
  try {
    found = await getLeetcodeCookies(preferred);
  } catch (e) {
    // If a Chromium browser is locking its cookie DB and --close-browser was
    // passed, close it (tabs restore on relaunch) and retry once.
    if (e.locked && wantClose) {
      const targets =
        preferred && preferred.toLowerCase() !== 'firefox'
          ? [cap(preferred)]
          : runningChromiumBrowsers();
      if (targets.length) {
        console.log(c.yellow(`Closing ${targets.join(', ')} to read cookies — your tabs will be restored on relaunch...`));
        for (const t of targets) closeBrowser(t);
        await sleep(2500);
        try {
          found = await getLeetcodeCookies(preferred);
        } catch (e2) {
          console.log(c.yellow(`Browser read still failed: ${e2.message}`));
          return manualLogin(flags);
        }
      } else {
        console.log(c.yellow(`Browser read failed: ${e.message}`));
        return manualLogin(flags);
      }
    } else {
      console.log(c.yellow(`Browser read failed: ${e.message}`));
      if (e.locked) console.log(c.dim('Tip: re-run with --close-browser to close it automatically.'));
      console.log(c.dim('Falling back to manual paste. (Use `lc login --manual` to skip straight here.)'));
      return manualLogin(flags);
    }
  }
  if (!found?.cookies?.LEETCODE_SESSION) {
    console.log(c.yellow('No LeetCode session cookie found in your browser(s).'));
    console.log(c.dim('Make sure you are logged in to leetcode.com, then retry — or paste manually below.'));
    return manualLogin(flags);
  }
  const { source, cookies } = found;
  if (!cookies.csrftoken) {
    console.log(c.yellow(`Found LEETCODE_SESSION in ${source} but no csrftoken — paste it manually below.`));
    return manualLogin({ ...flags, session: cookies.LEETCODE_SESSION });
  }
  console.log(c.green(`✓ Read cookies from ${c.bold(source)}.`));
  await finishLogin(cookies.LEETCODE_SESSION, cookies.csrftoken);
}

export async function whoami() {
  const u = await api.whoami();
  console.log(u?.isSignedIn ? c.green(`Signed in as ${c.bold(u.username)}`) : c.red('Not signed in.'));
}

export async function list(flags) {
  const res = await api.fetchProblemList({
    limit: Number(flags.limit || 25),
    skip: Number(flags.skip || 0),
    difficulty: flags.difficulty,
    search: flags.search,
  });
  console.log(c.dim(`${res.total} problems (showing ${res.questions.length})`));
  for (const q of res.questions) {
    const status = q.status === 'ac' ? c.green('✓') : q.status === 'notac' ? c.yellow('~') : ' ';
    const lock = q.isPaidOnly ? c.gray(' 🔒') : '';
    const id = String(q.frontendQuestionId).padStart(4);
    const rate = (q.acRate ?? 0).toFixed(1) + '%';
    console.log(
      ` ${status} ${c.dim(id)}  ${q.title.padEnd(45).slice(0, 45)} ${diffColor(q.difficulty).padEnd(6)} ${c.dim(rate)}${lock}`
    );
  }
  console.log(c.dim(`\nUse: lc show <slug|number> · lc pull <slug|number>`));
}

export async function show(args) {
  const slug = await resolveSlug(args[0]);
  const q = await api.fetchQuestion(slug);
  let acRate = '';
  try { acRate = JSON.parse(q.stats).acRate; } catch { /* ignore */ }
  console.log('');
  console.log(`${c.bold(`${q.questionFrontendId}. ${q.title}`)}  ${diffColor(q.difficulty)}  ${c.dim(acRate)}`);
  console.log(c.dim(`https://leetcode.com/problems/${q.titleSlug}/`));
  if (q.topicTags?.length) console.log(c.gray('tags: ' + q.topicTags.map((t) => t.name).join(', ')));
  console.log(hr());
  console.log(htmlToText(q.content));
  console.log(hr());
  console.log(c.dim(`Next: lc pull ${slug}`));
}

export async function pull(args, flags) {
  const slug = await resolveSlug(args[0]);
  const q = await api.fetchQuestion(slug);
  const lang = flags.lang || getConfig().lang || 'javascript';
  const snippet = q.codeSnippets?.find((s) => s.langSlug === lang);
  if (!snippet) {
    const avail = q.codeSnippets?.map((s) => s.langSlug).join(', ') || 'none';
    throw new Error(`No ${lang} snippet for this problem. Available: ${avail}`);
  }
  fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  const file = path.join(
    SOLUTIONS_DIR,
    `${q.questionFrontendId.padStart(4, '0')}-${slug}${EXT_BY_LANG[lang]}`
  );
  if (fs.existsSync(file) && !flags.force) {
    console.log(c.yellow(`File already exists (use --force to overwrite): ${path.relative(process.cwd(), file)}`));
  } else {
    const exampleComment = (q.exampleTestcaseList || [])
      .map((t, i) => ` * Example ${i + 1} input:\n${t.split('\n').map((l) => ' *   ' + l).join('\n')}`)
      .join('\n');
    const header = `/**\n * ${q.questionFrontendId}. ${q.title} [${q.difficulty}]\n * https://leetcode.com/problems/${slug}/\n *\n${exampleComment}\n */\n\n`;
    fs.writeFileSync(file, header + snippet.code + '\n');
    console.log(c.green(`✓ Created ${path.relative(process.cwd(), file)}`));
  }
  saveMeta(slug, {
    questionId: q.questionId,
    frontendId: q.questionFrontendId,
    title: q.title,
    difficulty: q.difficulty,
    examples: q.exampleTestcaseList,
    file,
    lang,
  });
  console.log(c.dim(`Edit it, then: lc test ${slug} · lc submit ${slug}`));
}

function readSolution(slug) {
  const file = findSolutionFile(slug);
  if (!file) throw new Error(`No solution file for "${slug}". Run: lc pull ${slug}`);
  const code = fs.readFileSync(file, 'utf8');
  const lang = LANG_BY_EXT[path.extname(file)] || 'javascript';
  return { file, code, lang };
}

export async function test(args, flags) {
  requireAuth();
  const slug = await resolveSlug(args[0]);
  const meta = await loadProblem(slug);
  const { file, code, lang } = readSolution(slug);

  let cases;
  if (flags.input) {
    cases = [String(flags.input).replace(/\\n/g, '\n')];
  } else if (flags['input-file']) {
    cases = [fs.readFileSync(flags['input-file'], 'utf8').trim()];
  } else {
    cases = meta.examples || [];
    if (!cases.length) throw new Error('No example testcases found; pass --input.');
  }
  const dataInput = cases.join('\n');

  console.log(c.dim(`Running ${path.basename(file)} against ${cases.length} testcase(s) on LeetCode...`));
  const r = await api.runTests({
    slug,
    questionId: meta.questionId,
    lang,
    code,
    dataInput,
  });
  printRunResult(r, cases);
  process.exitCode = r.run_success && r.correct_answer !== false ? 0 : 1;
}

export async function submitCmd(args) {
  requireAuth();
  const slug = await resolveSlug(args[0]);
  const meta = await loadProblem(slug);
  const { file, code, lang } = readSolution(slug);
  console.log(c.dim(`Submitting ${path.basename(file)} to LeetCode...`));
  const r = await api.submit({ slug, questionId: meta.questionId, lang, code });
  printSubmitResult(r);
  process.exitCode = r.status_code === 10 ? 0 : 1;
}

export async function daily(_args, flags) {
  const d = await api.fetchDaily();
  const q = d.question;
  console.log(
    `${c.bold('Daily')} ${c.dim(d.date)}  ${q.questionFrontendId}. ${q.title}  ${diffColor(q.difficulty)}`
  );
  console.log(c.dim(`lc show ${q.titleSlug} · lc pull ${q.titleSlug}`));
  if (flags.pull) await pull([q.titleSlug], flags);
}

// ---------- result printers ----------

function printRunResult(r, cases) {
  console.log('');
  if (r.full_compile_error || r.compile_error) {
    console.log(c.red(c.bold('✗ Compile Error')));
    console.log(block('Details:', r.full_compile_error || r.compile_error, c.red));
    return;
  }
  if (!r.run_success) {
    console.log(c.red(c.bold(`✗ ${r.status_msg || 'Runtime Error'}`)));
    if (r.full_runtime_error || r.runtime_error) {
      console.log(block('Error:', r.full_runtime_error || r.runtime_error, c.red));
    }
    return;
  }

  const dropTrailingEmpty = (a) => {
    const out = [...(a || [])];
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };
  const got = dropTrailingEmpty(r.code_answer);
  const want = dropTrailingEmpty(r.expected_code_answer);
  const stdout = r.std_output_list || [];
  const cmp = r.compare_result || '';
  const n = Math.max(got.length, want.length, cases.length);
  let passed = 0;

  for (let i = 0; i < n; i++) {
    const ok = cmp[i] === '1' || (cmp === '' && got[i] === want[i]);
    if (ok) passed++;
    const mark = ok ? c.green('✓ PASS') : c.red('✗ FAIL');
    console.log(`${mark}  ${c.bold(`Case ${i + 1}`)}`);
    if (!ok) {
      console.log(block('Input:', cases[i] ?? '(custom)'));
      console.log(block('Expected:', want[i] ?? '?', c.green));
      console.log(block('Got:', got[i] ?? '(nothing)', c.red));
      if (stdout[i]) console.log(block('Stdout:', stdout[i], c.gray));
    }
  }
  console.log(hr());
  const all = passed === n;
  const summary = `${passed}/${n} testcases passed`;
  console.log(all ? c.green(c.bold(`✓ ${summary}`)) : c.red(c.bold(`✗ ${summary}`)));
  if (r.status_runtime) console.log(c.dim(`runtime: ${r.status_runtime}  memory: ${r.status_memory || ''}`));
  if (all) console.log(c.dim('Looks good — try: lc submit <slug>'));
}

function printSubmitResult(r) {
  console.log('');
  const code = r.status_code;
  if (code === 10) {
    console.log(c.green(c.bold('✓ Accepted')) + c.dim(`  (${r.total_correct}/${r.total_testcases} testcases)`));
    const rt = r.status_runtime || '';
    const rtp = r.runtime_percentile != null ? `beats ${r.runtime_percentile.toFixed(1)}%` : '';
    const mem = r.status_memory || '';
    const memp = r.memory_percentile != null ? `beats ${r.memory_percentile.toFixed(1)}%` : '';
    console.log(`  ${c.bold('Runtime:')} ${rt} ${c.dim(rtp)}`);
    console.log(`  ${c.bold('Memory:')}  ${mem} ${c.dim(memp)}`);
    return;
  }

  console.log(c.red(c.bold(`✗ ${r.status_msg || 'Failed'}`)));
  if (r.total_testcases != null) {
    console.log(c.dim(`  ${r.total_correct}/${r.total_testcases} testcases passed`));
  }
  console.log('');

  if (code === 20) {
    // Compile error
    console.log(block('Compile error:', r.full_compile_error || r.compile_error, c.red));
    return;
  }
  const input = r.input_formatted || r.last_testcase;
  if (input) console.log(block('Failing input:', input));
  if (code === 15 || r.full_runtime_error || r.runtime_error) {
    console.log(block('Runtime error:', r.full_runtime_error || r.runtime_error || '', c.red));
  }
  if (r.expected_output) console.log(block('Expected:', r.expected_output, c.green));
  if (r.code_output && typeof r.code_output === 'string') {
    console.log(block('Got:', r.code_output, c.red));
  }
  if (r.std_output) console.log(block('Stdout:', r.std_output, c.gray));
  console.log(c.dim('\nReproduce locally: lc test <slug> --input "<failing input>"'));
}
