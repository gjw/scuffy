# Quality Floor — Non-Negotiable Constraints

These rules are injected into every Scuffy rebuild session. They are NOT
architectural choices — Scuffy makes all architecture decisions. These are minimum
quality standards that must hold regardless of what Scuffy builds.

## TypeScript

- `strict: true` in tsconfig (includes strictNullChecks, noImplicitAny, etc.)
- `noUncheckedIndexedAccess: true`
- No `any` — use `unknown` + type narrowing
- No `as X` type assertions without a preceding runtime check
- No `// @ts-ignore` or `// @ts-expect-error`
- No floating promises — every async operation must be awaited, returned, or
  explicitly voided

## Validation

- All external input validated before trusting as typed: API request bodies,
  query parameters, environment variables
- Use a schema validation library (Zod, Valibot, etc. — Scuffy's choice)
- Schemas are the source of truth for shared types where applicable

## Error Handling

- No swallowed errors — every catch block must log, re-throw, or return a
  meaningful error response
- API endpoints return appropriate HTTP status codes, not just 500 for everything
- Error responses include enough context to debug (but no stack traces in
  production)

## Git Discipline

- Set up .gitignore early — at minimum exclude node_modules, dist, and build
  artifacts. Tools that respect .gitignore depend on this.
- Commit after completing each logical unit of work
- Commit messages describe what changed and why
- Never commit node_modules, .env files, or build artifacts

## Testing

- Write tests for non-trivial logic — at minimum, API route handlers should have
  basic happy-path tests
- Tests must actually run and pass — `finishBead` will verify this
- Do not mock things you own — if you wrote the database layer, test against it

## Code Organization

- One concern per file — don't put route handlers, database queries, and
  validation schemas in the same file
- Exports should be intentional — don't export everything by default
- Dead code gets deleted, not commented out
