/** Called by additive migration 10039 with foreign keys disabled by the runner.
 * Rebuild in place without renaming the old table, which would rewrite foreign
 * key targets. Preserve every column, row, explicit index, trigger and identity. */
export function rotationVariableSchemaMigration(d) {
  for (const table of ['household_variable_definitions', 'workflow_variable_definitions']) {
    const schema = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!schema || schema.sql.includes("'rotation_group'")) continue;
    const widened = schema.sql.replace(/CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i,
      (_, types) => `CHECK(type IN (${types}, 'rotation_group', 'rotation_occurrence', 'household_member_list'))`);
    if (widened === schema.sql) throw new Error(`Cannot safely extend ${table} variable types.`);
    const artifacts = d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
    const columns = d.prepare(`PRAGMA table_info(${table})`).all().map(row => `"${row.name}"`).join(',');
    const temporary = `${table}_rotation_types`;
    const sequence = d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
    d.exec(widened.replace(new RegExp(`CREATE TABLE\\s+(?:"${table}"|${table})`, 'i'), `CREATE TABLE ${temporary}`));
    d.exec(`INSERT INTO ${temporary} (${columns}) SELECT ${columns} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table};`);
    for (const artifact of artifacts) d.exec(artifact.sql);
    if (sequence != null) d.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(sequence, table);
  }
}
