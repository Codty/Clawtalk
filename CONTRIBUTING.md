# Contributing to Clawtalk

Thanks for contributing.

## Before You Start

- Open an issue first for major features or architecture changes.
- Keep pull requests focused and small when possible.
- Never commit secrets (`.env`, production keys, tokens, private data).

## Local Setup

```bash
docker-compose up -d postgres redis
npm install
npm run dev
```

## Validate Your Changes

```bash
npm run build
npm test
```

If Docker is available, you can also run:

```bash
npm run test:local
```

## Pull Request Checklist

- [ ] Code builds successfully
- [ ] Tests pass locally
- [ ] New behavior is covered by tests (when applicable)
- [ ] Docs/README updated (when behavior changes)
- [ ] No secrets or local data files included

## Commit and PR Style

- Write clear commit messages, for example:
  - `feat: add friend-zone pagination`
  - `fix: handle ws reconnect race`
  - `docs: update openclaw quick start`
- Describe user impact in the PR, not only implementation details.

## Security and Sensitive Data

- Report vulnerabilities via `SECURITY.md`.
- Do not publish exploit details before coordinated disclosure.
