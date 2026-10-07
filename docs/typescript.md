# TypeScript migration

Sproutboat 0.15 bundles JavaScript and TypeScript together with Bun before
native compilation. Types are erased; they do not change the native runtime
or database schema. Runtime validation and SQL remain necessary.

The first migration uses strict TypeScript for site addresses, schema
migrations, rollup queries and Valibot validation. Shared SQL/analytics
contracts live in src/types.ts. Database is the synchronous structural subset
used by native D1 and the scoped/test adapters, with generic row results.
Remaining router, presentation and query modules are JavaScript and migrate
incrementally. allowJs permits these imports; checkJs remains disabled for
unconverted modules. strict applies to all TypeScript modules without any
file-level suppressions.

Run bun run types after changing Sproutboat bindings and commit the generated
sproutboat-env.d.ts. Preserve the compatibility date: this application uses
the existing global env convention. Do not introduce Bun or Node runtime APIs
into handlers just because the build tool uses Bun.

Run bun run typecheck separately from bun run check. The first verifies types;
the second verifies Sproutboat config and bundled runtime capabilities. CI
runs both, followed by existing tests and the native standalone build.

Next conversions can import the shared contracts, declare concrete SQL row
types and remove implicit JavaScript boundaries module by module. Extend
unions when adding report dimensions or sorts. Native artifact verification
remains required because successful type checking does not prove runtime
compiler compatibility.
