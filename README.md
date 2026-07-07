# terminal-leetcode

Train LeetCode silently from any terminal. Real problems, real judge, real submissions — no browser tab needed.

Requires Node 18+. No dependencies.

## Install

```
cd terminal-leetcode
npm link
```

This gives you a global `lc` command. (Alternative: `node bin/lc.js <command>`.)

## Login (one time)

LeetCode has no API tokens, so auth uses your browser session:

1. Log in to https://leetcode.com in your browser.
2. DevTools (F12) → Application → Cookies → `https://leetcode.com`
3. Copy `LEETCODE_SESSION` and `csrftoken`.
4. Run `lc login` and paste them (or `lc login --session <val> --csrf <val>`).

Cookies are stored in `.lc/config.json` (gitignored). Sessions last weeks; when it expires, run `lc login` again.

Verify: `lc whoami`

## Workflow

```
lc list --difficulty medium --search stack     # browse problems
lc daily                                       # today's daily challenge
lc show two-sum                                # read the problem (slug or number works)
lc pull two-sum                                # creates solutions/0001-two-sum.js from the official template
# ... edit the file in your editor ...
lc test two-sum                                # run against example testcases on LeetCode's judge
lc submit two-sum                              # real submission
```

`lc test` and `lc submit` find your file in `solutions/` automatically.

### Reading failures

`lc test` shows per-case results: input, expected vs actual, and anything you printed with `console.log` (Stdout). `lc submit` shows the verdict plus the exact hidden testcase that failed, expected vs your output, and full runtime/compile errors.

Reproduce a failed submission case locally:

```
lc test two-sum --input "[3,3]\n6"
lc test two-sum --input-file case.txt
```

Exit codes: 0 = all passed / accepted, 1 = failed — usable in scripts.

### TypeScript

```
lc pull two-sum --lang typescript
```

Creates a `.ts` file and submits as TypeScript. Set a default with `"lang": "typescript"` in `.lc/config.json`.

## Notes

- Every command output is plain terminal text — nothing flashy on screen.
- Rate limits: LeetCode may throttle rapid submissions (~1 per 10s). If a submit is rejected, wait a moment.
- Premium-only problems require a premium account session.
