import pg from 'pg';

const database = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 5000 });
try {
  await database.connect();
  await database.query('CREATE TABLE IF NOT EXISTS previewd_demo_notes (id uuid PRIMARY KEY, text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 160), revision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
  console.log('Notes schema ready.');
} catch {
  console.error('Migration failed. Inspect the local database before retrying.');
  process.exitCode = 1;
} finally {
  await database.end();
}
