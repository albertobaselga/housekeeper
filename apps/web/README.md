# Casa Clara web foundation

SvelteKit + TypeScript foundation for the household-scoped Casa Clara app. It intentionally uses only synthetic fixtures and an ephemeral local demo session; production authentication and persistence are separate work.

## Run locally

```bash
npm install
npm run dev
```

Open `/login`, choose one of the five demo perspectives, and the server will issue an in-memory `HttpOnly` session. The demo login is disabled on non-local production hosts.

## Checks

```bash
npm run check
npm test
npm run build
npm run verify:bundle
```

`verify:bundle` checks the production manifest: the Today route stays below its initial JavaScript budget, the wiki editor remains a route-lazy chunk, and a fixture-only sentinel does not leak into client JavaScript.

## Boundaries

- Authorization is deny-by-default and enforced in `hooks.server.ts`; hidden navigation is only presentation.
- Role and capability identifiers match the shared contracts vocabulary.
- Synthetic fixture corpora live only in `src/lib/server/*.server.ts`.
- IndexedDB owns `criticalSnapshots`, `outbox`, and `blobs`; outbox entries are removed only after an explicit server acknowledgement.
- The service worker caches versioned assets and visited pages, plus a generic offline fallback.
