// Continue the first bootstrap after a process interruption. Never reset credentials or data.
export async function ensureApplicationDatabase(pool, password) {
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('DATABASE_CREDENTIAL_INVALID');
  const role = await pool.query(
    "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='metaexam_app'",
  );
  if (!role.rowCount) {
    await pool.query("CREATE ROLE metaexam_app LOGIN PASSWORD '" + password + "'");
  } else {
    const r = role.rows[0];
    if (
      !r.rolcanlogin ||
      r.rolsuper ||
      r.rolcreatedb ||
      r.rolcreaterole ||
      r.rolreplication ||
      r.rolbypassrls
    )
      throw new Error('DATABASE_ROLE_OWNERSHIP');
  }
  const database = await pool.query(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='metaexam'",
  );
  if (!database.rowCount) await pool.query('CREATE DATABASE metaexam OWNER metaexam_owner');
  else if (database.rows[0].owner !== 'metaexam_owner') throw new Error('DATABASE_OWNERSHIP');
}
