# Contributing

## Ground rules

1. The reasoning layer proposes; deterministic code disposes. Never move sizing,
   slippage, or risk arithmetic into a prompt.
2. Anything that can touch funds must have a paper-mode equivalent behind the
   same interface.
3. New external inputs (APIs, RPC responses, LLM output) must be parsed through
   a zod schema at the boundary.
4. No secrets in the database, the logs, or the reasoning snapshot.

## Workflow

```bash
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm typecheck
pnpm test
```

Keep packages acyclic. The dependency direction is:

```
core -> db -> chain -> data -> {strategies, brain, execution, portfolio} -> keeper -> agent
```

If you need something from a downstream package, the type belongs in `core`.
