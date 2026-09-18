import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config — schema mirrors src/store/postgres.ts.
 * Apply: `pnpm db:migrate` (runs SQL in drizzle/).
 */
export default defineConfig({
  schema: "./src/store/postgres.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/zunia_indexer",
  },
  verbose: true,
  strict: true,
});
