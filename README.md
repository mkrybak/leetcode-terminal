# leetcode-terminal

Train LeetCode silently from any terminal. Real problems, real judge, real submissions — no browser tab needed.

Requires Node 18+. No dependencies.

## Install

```
cd leetcode-terminal
npm link
```

This gives you a global `lc` command. (Alternative: `node bin/lc.js <command>`.)

## Login (one time)

LeetCode has no API tokens, so auth uses your browser session. Log in to
https://leetcode.com in your browser first. Then pick whichever route fits your
browser:

### Fastest for Chrome / Edge: clipboard

Recent Chrome/Edge (v127+) use *app-bound encryption*, which no user-level tool
can decrypt. The quickest path there:

1. On leetcode.com, open DevTools (F12) → **Network** tab (reload if it's empty).
2. Click any request to `leetcode.com` → **Headers** → **Request Headers**.
3. Right-click the **Cookie** header → **Copy value** (it contains both cookies).
4. Run:

```
lc login --clip
```

It reads your clipboard and extracts `LEETCODE_SESSION` + `csrftoken` automatically.

### Fully automatic: Firefox

If you're logged into leetcode in **Firefox**, just run:

```
lc login
```

Firefox stores cookies unencrypted and doesn't lock them, so this reads them
directly — no DevTools, works even while Firefox is open. (`lc login` also tries
Chrome/Edge, decrypting their DPAPI + AES-256-GCM cookies when possible; for those
you must fully close the browser first, and it still can't beat v20 app-bound
encryption — use `--clip` instead.)

Options: `lc login --browser firefox|chrome|edge` forces one; `--close-browser`
auto-closes a locked Chrome/Edge (tabs restore on relaunch).

### Manual fallback

```
lc login --manual        # prompts for the two cookie values
# or non-interactively:
lc login --session <LEETCODE_SESSION> --csrf <csrftoken>
```

Grab the values from DevTools → Application → Cookies → `https://leetcode.com`.

Cookies are stored in `.lc/config.json` (gitignored). Sessions last weeks; when it
expires, log in again. Verify anytime with `lc whoami`.

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
