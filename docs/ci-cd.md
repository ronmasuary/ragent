# CI/CD Guide

## What is CI/CD?

**CI (Continuous Integration)** — every time you push code to GitHub, a robot automatically runs your tests and type checks. It catches broken code before anyone else sees it.

**CD (Continuous Deployment)** — automated deployment after tests pass. Ragent does **not** do auto-deploy. You deploy manually with `./deploy.sh`. Only CI is set up.

**Why bother with CI?** Prevents "works on my machine" bugs. Tests run in a clean Ubuntu environment on every push, independent of your local setup.

---

## How Ragent's CI works

**Trigger:** any push to `main`, or any pull request targeting `main`.

**Steps the robot runs:**

1. `npm ci` — install the exact dependency versions from `package-lock.json` (reproducible builds)
2. `npm run typecheck` — TypeScript checks every file for type errors without producing output files
3. `npm test` — runs all test files under `tests/`

If any step fails → GitHub marks the commit with a red ✗. Fix the problem, push again.

---

## Where to see CI results

- **GitHub repo → Actions tab** — click any workflow run to see full logs
- **On a PR** — green checkmark ✓ or red ✗ shown inline next to the commit

---

## The CI workflow file explained

File: `.github/workflows/ci.yml`

```yaml
# Runs on push to main, and on PRs targeting main
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest   # GitHub spins up a fresh Ubuntu VM for every run

    steps:
      - uses: actions/checkout@v4      # Step 1: download your code into the VM

      - uses: actions/setup-node@v4    # Step 2: install Node.js
        with:
          node-version: '22'
          cache: 'npm'                 # cache node_modules so subsequent runs are faster

      - run: npm ci                    # Step 3: install exact deps from package-lock.json

      - run: npm run typecheck         # Step 4: TypeScript type check

      - run: npm test                  # Step 5: run all tests
```

The VM is **ephemeral** — thrown away after each run. No state carries over between runs (except the npm cache).

---

## Pushing to both GitLab and GitHub

GitLab is the private source-of-truth. GitHub is the public mirror. Push to both manually:

```bash
# One-time setup: add both remotes
git remote set-url origin git@gitlab.com:your-username/ragent.git
git remote add github git@github.com:your-username/ragent.git

# Push to both
git push origin main
git push github main
```

CI runs when GitHub receives the push. GitLab does not have CI configured.

**Tip:** add a git alias to push both at once. Add to `~/.gitconfig`:

```ini
[alias]
    pushall = !git push origin main && git push github main
```

Then just run `git pushall`.

---

## Running CI locally

Before pushing, run the same checks locally:

```bash
npm run typecheck   # TypeScript check
npm test            # all tests
```

Both should complete with no errors. Same commands the CI robot runs.
