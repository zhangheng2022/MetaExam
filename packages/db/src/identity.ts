import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { transaction, type Database } from './index';
import type { CurrentUser, AdministratorInput } from '@metaexam/contracts';
import type { PoolClient } from 'pg';
export class IdentityError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export interface AuditContext {
  requestId: string;
  ip?: string;
}
export async function audit(
  c: Pick<PoolClient, 'query'>,
  event: string,
  outcome: string,
  context: AuditContext,
  actorId: string | null = null,
) {
  await c.query(
    'INSERT INTO audit_events(id,actor_id,event,outcome,request_id,source_ip) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), actorId, event, outcome, context.requestId, context.ip ?? null],
  );
}
export class AccountsRepository {
  constructor(readonly db: Database) {}
  async current(id: string): Promise<CurrentUser | null> {
    const row = (
      await this.db.pool.query<{ id: string; username: string; display_name: string }>(
        'SELECT id,username,display_name FROM users WHERE id=$1 AND enabled=true',
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const roles = (
      await this.db.pool.query<{ role_code: string }>(
        'SELECT role_code FROM user_roles WHERE user_id=$1 ORDER BY role_code',
        [id],
      )
    ).rows.map((r) => r.role_code);
    const permissions = (
      await this.db.pool.query<{ permission_code: string }>(
        'SELECT DISTINCT permission_code FROM role_permissions JOIN user_roles USING(role_code) WHERE user_id=$1 ORDER BY permission_code',
        [id],
      )
    ).rows.map((r) => r.permission_code);
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      roles,
      permissions,
    };
  }
  async credentials(username: string) {
    return (
      await this.db.pool.query<{
        id: string;
        password_hash: string;
        version: number;
        enabled: boolean;
      }>(
        'SELECT u.id,u.enabled,c.password_hash,c.version FROM users u JOIN user_credentials c ON c.user_id=u.id WHERE username=$1',
        [username],
      )
    ).rows[0];
  }
  async changePassword(id: string, expectedVersion: number, hash: string, context: AuditContext) {
    await transaction(this.db, async (c) => {
      // Serializes password changes against session creation with an old credential version.
      const result = await c.query(
        'UPDATE user_credentials SET password_hash=$1,version=version+1,updated_at=now() WHERE user_id=$2 AND version=$3 RETURNING user_id',
        [hash, id, expectedVersion],
      );
      if (!result.rowCount) throw new IdentityError('CREDENTIALS_CHANGED', 401);
      await c.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      await audit(c, 'password.change', 'success', context, id);
    });
  }
}
export const digestToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
export class BootstrapRepository {
  constructor(readonly db: Database) {}
  async initialized() {
    const row = (await this.db.pool.query('SELECT completed_at FROM bootstrap_state WHERE id=1'))
      .rows[0];
    if (!row) throw new IdentityError('DATABASE_UNAVAILABLE', 503);
    return !!row.completed_at;
  }
  async issue(hash: string, expires: Date, context: AuditContext) {
    await transaction(this.db, async (c) => {
      const state = (
        await c.query('SELECT completed_at FROM bootstrap_state WHERE id=1 FOR UPDATE')
      ).rows[0];
      if (!state) throw new IdentityError('DATABASE_UNAVAILABLE', 503);
      if (state.completed_at) throw new IdentityError('ALREADY_INITIALIZED', 409);
      await c.query('UPDATE bootstrap_state SET token_hash=$1,expires_at=$2 WHERE id=1', [
        hash,
        expires,
      ]);
      await audit(c, 'setup.token', 'issued', context);
    });
  }
  async create(input: AdministratorInput, token: string, hash: string, context: AuditContext) {
    return transaction(this.db, async (c) => {
      const state = (
        await c.query<{
          completed_at: Date | null;
          token_hash: string | null;
          expires_at: Date | null;
        }>('SELECT * FROM bootstrap_state WHERE id=1 FOR UPDATE')
      ).rows[0];
      if (!state) throw new IdentityError('DATABASE_UNAVAILABLE', 503);
      if (state.completed_at) throw new IdentityError('ALREADY_INITIALIZED', 409);
      const supplied = Buffer.from(digestToken(token));
      const expected = Buffer.from(state.token_hash ?? '');
      if (
        !state.expires_at ||
        state.expires_at.getTime() <= Date.now() ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new IdentityError('SETUP_TOKEN_INVALID', 403);
      const id = randomUUID();
      await c.query('INSERT INTO users(id,username,display_name) VALUES($1,$2,$3)', [
        id,
        input.username,
        input.displayName,
      ]);
      await c.query('INSERT INTO user_credentials(user_id,password_hash) VALUES($1,$2)', [
        id,
        hash,
      ]);
      await c.query("INSERT INTO user_roles VALUES($1,'admin')", [id]);
      await c.query(
        'UPDATE bootstrap_state SET completed_at=now(),completed_by=$1,token_hash=NULL,expires_at=NULL WHERE id=1',
        [id],
      );
      await audit(c, 'setup.administrator', 'success', context, id);
      return id;
    });
  }
}
export async function consumeAuthQuota(
  db: Database,
  username: string,
  ip: string,
  limits: { account: number; ip: number },
) {
  const denied = await transaction(db, async (c) => {
    await c.query('DELETE FROM auth_throttle_buckets WHERE expires_at<now()');
    let blocked = false;
    for (const [key, seconds, max] of [
      [digestToken('ip:' + ip), 60, limits.ip],
      [digestToken('account:' + ip + ':' + username), 900, limits.account],
    ] as const) {
      const row = (
        await c.query<{ count: number }>(
          "INSERT INTO auth_throttle_buckets(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=auth_throttle_buckets.count+1 RETURNING count",
          [key, seconds],
        )
      ).rows[0]!;
      blocked ||= row.count > max;
    }
    return blocked;
  });
  if (denied) throw new IdentityError('RATE_LIMITED', 429);
}
