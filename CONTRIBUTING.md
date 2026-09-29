# Contributing

CKB is a local-first knowledge engine. Contributions must preserve its read-only Apple Notes boundary, transactional publishing guarantees, and separation between public code and private user data.

## Development setup

Requirements:

- Node.js 24 or newer
- pnpm 11

Install and validate changes:

~~~sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm audit:public
~~~

Add tests before changing behavior. Keep fixtures small, deterministic, and wholly synthetic.

## Privacy requirements

Never commit:

- Real Apple Notes titles, bodies, identifiers, exports, or databases
- A real Obsidian vault or CKB runtime state
- Attachments, media, transcripts, backups, or recovery artifacts
- Credentials, tokens, private keys, environment files, or local configuration
- Personal usernames, email addresses, absolute home-directory paths, or private operational notes

Use neutral names such as Example Thinker, ExampleCo, and Personal Knowledge Base. Ignore rules are a backstop, not permission to place private data inside the repository.

Before opening a change, run the complete verification sequence above and inspect the staged diff.
