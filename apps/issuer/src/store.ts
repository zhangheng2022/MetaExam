import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(home, 'issuer.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 1) {
      this.db.close();
      throw new Error('STORE_VERSION_UNSUPPORTED');
    }
    if (version === 0)
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL) STRICT;
        CREATE TABLE keys(kid TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK(environment IN ('test','production')), public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
        CREATE TABLE instances(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), device_hash TEXT NOT NULL, floor INTEGER NOT NULL DEFAULT 0 CHECK(floor>=0), reconciled INTEGER NOT NULL DEFAULT 0 CHECK(reconciled IN(0,1))) STRICT;
        CREATE TABLE requests(id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), raw TEXT NOT NULL) STRICT;
        CREATE TABLE packages(id TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK(environment IN('test','production')), version TEXT NOT NULL, raw TEXT NOT NULL) STRICT;
        CREATE TABLE licenses(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL REFERENCES instances(id), kid TEXT NOT NULL REFERENCES keys(kid), sequence INTEGER NOT NULL CHECK(sequence>0), raw TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(instance_id,sequence)) STRICT;
        CREATE TABLE events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, note TEXT NOT NULL) STRICT;
        CREATE TRIGGER immutable_license_update BEFORE UPDATE ON licenses BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LICENSE'); END;
        CREATE TRIGGER immutable_license_delete BEFORE DELETE ON licenses BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LICENSE'); END;
        PRAGMA user_version=1;
      `);
        this.db.prepare('INSERT INTO meta VALUES(?,?)').run('ledgerId', randomUUID());
      });
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(key: string) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value as
      | string
      | undefined;
  }
  set(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  event(kind: string, id: string, note = '') {
    this.db
      .prepare('INSERT INTO events(at,kind,object_id,note) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), kind, id, note);
  }
  close() {
    this.db.close();
  }
}
