import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type SessionRecord,
  type SessionStore,
} from '@nestjs/authentication';
import { transaction, IdentityError } from '@metaexam/db';
import { Runtime } from '../database/database.module';
interface Row {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  last_active_at: Date;
  record: Pick<SessionRecord, 'metadata' | 'mfa'>;
}
function record(r: Row): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastActiveAt: r.last_active_at,
    ...r.record,
  };
}
@Injectable()
export class PgSessionStore implements SessionStore {
  constructor(
    private readonly runtime: Runtime,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ sessions: this });
  }
  async getSession(id: string) {
    const r = (
      await this.runtime.db.pool.query<Row>('SELECT * FROM auth_sessions WHERE id=$1', [id])
    ).rows[0];
    return r ? record(r) : undefined;
  }
  async createSession(s: SessionRecord) {
    await transaction(this.runtime.db, async (c) => {
      const credential = (
        await c.query<{ version: number; enabled: boolean }>(
          'SELECT version,enabled FROM user_credentials JOIN users ON users.id=user_id WHERE user_id=$1 FOR SHARE OF user_credentials,users',
          [s.userId],
        )
      ).rows[0];
      if (!credential?.enabled || credential.version !== s.metadata?.credentialVersion)
        throw new IdentityError('CREDENTIALS_CHANGED', 401);
      await c.query('DELETE FROM auth_sessions WHERE expires_at<$1', [s.createdAt]);
      await c.query(
        'INSERT INTO auth_sessions(id,user_id,created_at,last_active_at,expires_at,record) VALUES($1,$2,$3,$4,$5,$6)',
        [
          s.id,
          s.userId,
          s.createdAt,
          s.lastActiveAt,
          s.expiresAt,
          JSON.stringify({
            ...(s.metadata ? { metadata: s.metadata } : {}),
            ...(s.mfa ? { mfa: s.mfa } : {}),
          }),
        ],
      );
    });
  }
  async touchSession(id: string, date: Date) {
    await this.runtime.db.pool.query(
      'UPDATE auth_sessions SET last_active_at=$2 WHERE id=$1 AND last_active_at<$2',
      [id, date],
    );
  }
  async deleteSession(id: string) {
    return !!(await this.runtime.db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [id]))
      .rowCount;
  }
  async listUserSessions(id: string) {
    return (
      await this.runtime.db.pool.query<Row>('SELECT * FROM auth_sessions WHERE user_id=$1', [id])
    ).rows.map(record);
  }
  async deleteUserSessions(id: string) {
    await this.runtime.db.pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
  }
}
