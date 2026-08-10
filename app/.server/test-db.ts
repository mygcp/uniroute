/** Prepare the DB module to connect to the current DATABASE_URL. */
export async function resetTestDb(): Promise<void> {
  const db = await import("./db");
  db.resetDb();
}
