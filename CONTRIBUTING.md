# Contributing to Ragent

## Getting started

1. Fork the repo on GitHub
2. Clone your fork: `git clone https://github.com/your-username/ragent`
3. Create a branch: `git checkout -b feat/my-feature`
4. Install deps: `npm install`
5. Copy env: `cp .env.example .env` and set `ANTHROPIC_API_KEY`

## Making changes

- Keep changes focused — one feature or fix per PR
- Run tests before submitting: `npm test`
- Run typecheck: `npm run typecheck`
- Both must pass with no errors

## Code style

- TypeScript strict mode
- No unnecessary comments — code should be self-documenting
- No external dependencies unless clearly justified

## Submitting a PR

1. Push your branch to your fork
2. Open a PR against `main` on the GitHub mirror
3. Describe what the change does and why
4. CI must pass (tests + typecheck)

## Skill contributions

Skills live in `skills/` (gitignored). To share a skill, add it under `examples/` with a `README.md`.

## Questions

Open a GitHub issue for bugs, feature requests, or questions.
