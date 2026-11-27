import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { z } from 'zod';
import {
  issuerCustomerSchema,
  issuerDraftSchema,
  issuerEnvironmentSchema,
  issuerTrustSchema,
  licenseRequestSchema,
  licensePayloadSchema,
  type IssuerDraft,
  type IssuerPreview,
  type IssuerSnapshot,
  type LicensePayload,
} from '@metaexam/contracts';
import { strictJson, verifyLicense } from '@metaexam/domain';
import { Store } from './store';
import { passwordSchema, seal, unseal } from './crypto';
import { backupSchema } from './backup';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const digest = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
export function publicFingerprint(pem: string) {
  if (!pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('KEY_INVALID');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('KEY_INVALID');
  if (
    pem.replaceAll('\r\n', '\n').trim() !==
    key.export({ type: 'spki', format: 'pem' }).toString().trim()
  )
    throw new Error('KEY_INVALID');
  return digest(key.export({ type: 'spki', format: 'der' }));
}
function parse(raw: string) {
  if (Buffer.byteLength(raw) > 65536) throw new Error('FILE_TOO_LARGE');
  return strictJson(raw);
}
function payloadOf(raw: string): LicensePayload {
  const envelope = z
    .object({ protected: z.string(), payload: z.string(), signature: z.string() })
    .strict()
    .parse(parse(raw));
  return licensePayloadSchema.parse(
    strictJson(Buffer.from(envelope.payload, 'base64url').toString('utf8')),
  );
}
const idSchema = z.string().min(1).max(128);
type KeyRow = {
  kid: string;
  environment: 'test' | 'production';
  public_key: string;
  fingerprint: string;
  secret: string;
  enabled: number;
};
type InstanceRow = {
  id: string;
  customer_id: string;
  device_hash: string;
  floor: number;
  reconciled: number;
};
type LicenseRow = {
  id: string;
  operation_id: string;
  instance_id: string;
  kid: string;
  sequence: number;
  raw: string;
  digest: string;
  created_at: string;
};

export class IssuerService {
  readonly store: Store;
  private master?: Buffer;
  private previewState?: {
    id: string;
    operationId: string;
    draft: IssuerDraft;
    expires: number;
    floor: number;
    licenseId: string;
  };
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new Store(home);
  }
  get initialized() {
    return !!this.store.get('vault');
  }
  private secret() {
    if (!this.master) throw new Error('LOCKED');
    return this.master.toString('base64');
  }
  async unlock(password: string) {
    passwordSchema.parse(password);
    const existing = this.store.get('vault');
    if (existing) this.master = await unseal(existing, password, 'vault');
    else {
      const master = randomBytes(32),
        vault = await seal(master, password, 'vault');
      this.store.transaction(() => {
        if (this.store.get('vault')) throw new Error('VAULT_CHANGED');
        this.store.set('vault', vault);
      });
      this.master = master;
    }
    if (this.master.length !== 32) {
      this.close();
      throw new Error('UNLOCK_FAILED');
    }
  }
  close() {
    this.master?.fill(0);
    this.master = undefined;
    this.previewState = undefined;
    this.store.close();
  }
  async changePassword(password: string) {
    this.secret();
    const vault = await seal(this.master!, password, 'vault');
    this.store.transaction(() => {
      this.store.set('vault', vault);
      this.store.event('password.changed', 'vault');
    });
  }
  private key(kid: string) {
    const key = this.store.db.prepare('SELECT * FROM keys WHERE kid=?').get(idSchema.parse(kid)) as
      | KeyRow
      | undefined;
    if (!key) throw new Error('KEY_NOT_FOUND');
    return key;
  }
  async createKey(environment: unknown) {
    this.secret();
    const env = issuerEnvironmentSchema.parse(environment),
      pair = generateKeyPairSync('ed25519');
    const kid = `${env}-${randomUUID()}`;
    await this.addKey(
      kid,
      env,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    return { kid };
  }
  async importTestKey(privatePem: string, publicRaw: string) {
    this.secret();
    const keys = z
      .object({ 'internal-test': z.string().max(4096) })
      .strict()
      .parse(parse(publicRaw));
    await this.addKey('internal-test', 'test', privatePem, keys['internal-test']);
  }
  private async addKey(
    kid: string,
    environment: 'test' | 'production',
    privatePem: string,
    publicPem: string,
  ) {
    const privateKey = createPrivateKey(privatePem),
      publicKey = createPublicKey(privateKey);
    if (
      privateKey.asymmetricKeyType !== 'ed25519' ||
      publicFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString()) !==
        publicFingerprint(publicPem)
    )
      throw new Error('KEY_MISMATCH');
    const secret = await seal(
      Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      this.secret(),
      `key:${kid}`,
    );
    this.store.transaction(() => {
      if (this.store.db.prepare('SELECT kid FROM keys WHERE kid=?').get(kid))
        throw new Error('KEY_EXISTS');
      this.store.db
        .prepare('INSERT INTO keys VALUES(?,?,?,?,?,1)')
        .run(kid, environment, publicPem, publicFingerprint(publicPem), secret);
      this.store.event('key.created', kid);
    });
  }
  disableKey(kid: string) {
    this.secret();
    this.key(kid);
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE keys SET enabled=0 WHERE kid=?').run(kid);
      this.store.event('key.disabled', kid);
    });
    this.previewState = undefined;
  }
  exportTrust(kid: string, version: string) {
    this.secret();
    const key = this.key(kid);
    return issuerTrustSchema.parse({
      schemaVersion: 1,
      product: 'MetaExam',
      environment: key.environment,
      version,
      keys: [{ kid, publicKey: key.public_key, fingerprint: key.fingerprint }],
    });
  }
  importTrust(raw: string) {
    this.secret();
    const trust = issuerTrustSchema.parse(parse(raw));
    if (new Set(trust.keys.map((k) => k.kid)).size !== trust.keys.length)
      throw new Error('KEY_INVALID');
    for (const key of trust.keys) {
      if (
        publicFingerprint(key.publicKey) !== key.fingerprint ||
        (trust.environment === 'production' && key.kid === 'internal-test')
      )
        throw new Error('KEY_MISMATCH');
    }
    const canonical = JSON.stringify(trust),
      id = digest(canonical);
    this.store.db
      .prepare('INSERT OR IGNORE INTO packages VALUES(?,?,?,?)')
      .run(id, trust.environment, trust.version, canonical);
    return { id };
  }
  importLegacyTrust(raw: string, version: string) {
    const keys = z
      .object({ 'internal-test': z.string().max(4096) })
      .strict()
      .parse(parse(raw));
    return this.importTrust(
      JSON.stringify({
        schemaVersion: 1,
        product: 'MetaExam',
        environment: 'test',
        version,
        keys: [
          {
            kid: 'internal-test',
            publicKey: keys['internal-test'],
            fingerprint: publicFingerprint(keys['internal-test']),
          },
        ],
      }),
    );
  }
  saveCustomer(input: unknown) {
    this.secret();
    const c = issuerCustomerSchema.parse(input);
    this.store.db
      .prepare(
        'INSERT INTO customers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,note=excluded.note',
      )
      .run(c.id, c.name, c.note);
  }
  importRequest(raw: string, customerId: string) {
    this.secret();
    const request = licenseRequestSchema.parse(parse(raw));
    idSchema.parse(customerId);
    this.store.transaction(() => {
      const instance = this.store.db
        .prepare('SELECT * FROM instances WHERE id=?')
        .get(request.installationId) as InstanceRow | undefined;
      if (
        instance &&
        (instance.customer_id !== customerId || instance.device_hash !== request.deviceHash)
      )
        throw new Error('INSTANCE_MISMATCH');
      if (!this.store.db.prepare('SELECT id FROM customers WHERE id=?').get(customerId))
        throw new Error('CUSTOMER_NOT_FOUND');
      this.store.db
        .prepare('INSERT OR IGNORE INTO instances VALUES(?,?,?,0,0)')
        .run(request.installationId, customerId, request.deviceHash);
      const previous = this.store.db
        .prepare('SELECT raw FROM requests WHERE id=?')
        .get(request.requestId);
      const canonical = JSON.stringify(request);
      if (previous && previous.raw !== canonical) throw new Error('REQUEST_CONFLICT');
      this.store.db
        .prepare('INSERT OR IGNORE INTO requests VALUES(?,?,?)')
        .run(request.requestId, request.installationId, canonical);
    });
    return request;
  }
  setFloor(instanceId: string, floor: number, reason: string, neverIssued: boolean) {
    this.secret();
    z.number().int().nonnegative().safe().parse(floor);
    z.string().trim().min(1).max(1000).parse(reason);
    z.boolean().parse(neverIssued);
    this.store.transaction(() => {
      const i = this.store.db
        .prepare('SELECT * FROM instances WHERE id=?')
        .get(idSchema.parse(instanceId)) as InstanceRow | undefined;
      if (!i) throw new Error('INSTANCE_NOT_FOUND');
      if (floor < i.floor || (floor === 0 && !neverIssued) || (neverIssued && floor !== 0))
        throw new Error('SEQUENCE_INVALID');
      this.store.db
        .prepare('UPDATE instances SET floor=?,reconciled=1 WHERE id=?')
        .run(floor, instanceId);
      this.store.event('sequence.reconciled', instanceId, reason);
    });
    this.previewState = undefined;
  }
  private trustedKeys() {
    return new Map(
      (this.store.db.prepare('SELECT * FROM keys').all() as KeyRow[]).map((k) => [
        k.kid,
        k.public_key,
      ]),
    );
  }
  importHistory(raw: string) {
    this.secret();
    const payload = payloadOf(raw);
    const instance = this.store.db
      .prepare('SELECT * FROM instances WHERE id=?')
      .get(payload.installationId) as InstanceRow | undefined;
    if (!instance || payload.customerId !== instance.customer_id)
      throw new Error('INSTANCE_MISMATCH');
    const verified = verifyLicense(raw, this.trustedKeys(), {
      installationId: instance.id,
      deviceHash: instance.device_hash,
      appVersion: payload.minAppVersion,
      now: new Date(payload.notBefore),
    });
    const envelope = parse(raw) as { protected: string };
    const header = JSON.parse(Buffer.from(envelope.protected, 'base64url').toString('utf8')) as {
      kid: string;
    };
    this.store.transaction(() => {
      const existing = this.store.db
        .prepare('SELECT * FROM licenses WHERE instance_id=? AND sequence=?')
        .get(instance.id, payload.sequence) as LicenseRow | undefined;
      if (existing && existing.digest !== verified.digest) throw new Error('SEQUENCE_CONFLICT');
      if (!existing)
        this.store.db
          .prepare('INSERT INTO licenses VALUES(?,?,?,?,?,?,?,?)')
          .run(
            payload.licenseId,
            `history-${randomUUID()}`,
            instance.id,
            header.kid,
            payload.sequence,
            raw,
            verified.digest,
            payload.issuedAt,
          );
      this.store.db
        .prepare('UPDATE instances SET floor=max(floor,?),reconciled=1 WHERE id=?')
        .run(payload.sequence, instance.id);
      this.store.event('license.imported', payload.licenseId);
    });
    this.previewState = undefined;
  }
  private prepare(draft: IssuerDraft, sequence?: number) {
    if (this.store.get('reviewRequired') === 'true') throw new Error('REVIEW_REQUIRED');
    const row = this.store.db.prepare('SELECT raw FROM requests WHERE id=?').get(draft.requestId);
    if (!row) throw new Error('REQUEST_NOT_FOUND');
    const request = licenseRequestSchema.parse(JSON.parse(row.raw as string));
    const instance = this.store.db
      .prepare('SELECT * FROM instances WHERE id=?')
      .get(request.installationId) as InstanceRow;
    if (!instance.reconciled) throw new Error('SEQUENCE_UNKNOWN');
    const key = this.key(draft.kid);
    if (!key.enabled || key.environment !== draft.environment) throw new Error('KEY_DISABLED');
    const pkg = this.store.db.prepare('SELECT raw FROM packages WHERE id=?').get(draft.packageId);
    if (!pkg) throw new Error('TRUST_REQUIRED');
    const trust = issuerTrustSchema.parse(JSON.parse(pkg.raw as string));
    if (
      trust.environment !== draft.environment ||
      trust.version !== request.appVersion ||
      !trust.keys.some((k) => k.kid === key.kid && k.fingerprint === key.fingerprint)
    )
      throw new Error('TRUST_MISMATCH');
    if (draft.expiresAt === null && !draft.permanentConfirmed)
      throw new Error('PERMANENT_CONFIRMATION_REQUIRED');
    const issuedAt = new Date(this.now()).toISOString(),
      notBefore = draft.notBefore ?? issuedAt;
    if (
      (draft.notBefore !== null && Date.parse(notBefore) < Date.parse(issuedAt)) ||
      (draft.expiresAt !== null && Date.parse(draft.expiresAt) <= Date.parse(notBefore))
    )
      throw new Error('DATES_INVALID');
    const payload = licensePayloadSchema.parse({
      schemaVersion: 1,
      product: 'MetaExam',
      licenseId: `${draft.environment === 'test' ? 'TEST' : 'LIC'}-${randomUUID()}`,
      customerId: instance.customer_id,
      installationId: instance.id,
      fingerprintVersion: 1,
      deviceHash: instance.device_hash,
      sequence: sequence ?? instance.floor + 1,
      issuedAt,
      notBefore,
      expiresAt: draft.expiresAt,
      maxConcurrentAttempts: draft.maxConcurrentAttempts,
      features: ['exam.core', 'reports.basic'],
      minAppVersion: draft.minAppVersion,
      maxAppMajor: draft.maxAppMajor,
    });
    return { key, instance, request, payload };
  }
  async preview(input: unknown): Promise<IssuerPreview> {
    this.secret();
    const draft = issuerDraftSchema.parse(input),
      { payload, instance } = this.prepare(draft);
    // Validate compatibility through the same verifier used by customers.
    await this.signPayload(
      payload,
      this.key(draft.kid),
      licenseRequestSchema.parse(
        JSON.parse(
          this.store.db.prepare('SELECT raw FROM requests WHERE id=?').get(draft.requestId)!
            .raw as string,
        ),
      ).appVersion,
    );
    const id = randomUUID(),
      operationId = randomUUID();
    this.previewState = {
      id,
      operationId,
      draft,
      expires: this.now() + 600000,
      floor: instance.floor,
      licenseId: payload.licenseId,
    };
    const previous = this.store.db
      .prepare('SELECT raw FROM licenses WHERE instance_id=? ORDER BY sequence DESC LIMIT 1')
      .get(instance.id);
    return {
      id,
      operationId,
      payload,
      previous: previous ? payloadOf(previous.raw as string) : null,
    };
  }
  cancelPreview() {
    this.previewState = undefined;
  }
  private async signPayload(payload: LicensePayload, key: KeyRow, appVersion: string) {
    const bytes = await unseal(key.secret, this.secret(), `key:${key.kid}`);
    try {
      const protectedPart = Buffer.from(
        JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid: key.kid }),
      ).toString('base64url');
      const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = sign(
        null,
        Buffer.from(`MetaExam-License-v1.${protectedPart}.${part}`, 'ascii'),
        createPrivateKey(bytes),
      ).toString('base64url');
      const raw = JSON.stringify({ protected: protectedPart, payload: part, signature });
      verifyLicense(raw, new Map([[key.kid, key.public_key]]), {
        installationId: payload.installationId,
        deviceHash: payload.deviceHash,
        appVersion,
        now: new Date(payload.notBefore),
      });
      return raw;
    } finally {
      bytes.fill(0);
    }
  }
  async confirm(id: string, operationId: string) {
    this.secret();
    z.string().uuid().parse(id);
    z.string().uuid().parse(operationId);
    const old = this.store.db
      .prepare('SELECT id FROM licenses WHERE operation_id=?')
      .get(operationId);
    if (old) return { id: old.id as string };
    const selected = this.previewState;
    if (
      !selected ||
      selected.id !== id ||
      selected.operationId !== operationId ||
      selected.expires <= this.now()
    )
      throw new Error('PREVIEW_EXPIRED');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const { payload, key, instance, request } = this.prepare(selected.draft);
      payload.licenseId = selected.licenseId;
      if (instance.floor !== selected.floor) throw new Error('PREVIEW_CHANGED');
      const raw = await this.signPayload(payload, key, request.appVersion);
      this.store.db
        .prepare('INSERT INTO licenses VALUES(?,?,?,?,?,?,?,?)')
        .run(
          payload.licenseId,
          operationId,
          instance.id,
          key.kid,
          payload.sequence,
          raw,
          digest(raw),
          payload.issuedAt,
        );
      this.store.db
        .prepare('UPDATE instances SET floor=? WHERE id=?')
        .run(payload.sequence, instance.id);
      this.store.event('license.signed', payload.licenseId);
      this.store.db.exec('COMMIT');
      this.previewState = undefined;
      return { id: payload.licenseId };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      this.previewState = undefined;
      throw error;
    }
  }
  license(id: string) {
    this.secret();
    const row = this.store.db
      .prepare('SELECT raw FROM licenses WHERE id=?')
      .get(idSchema.parse(id));
    if (!row) throw new Error('LICENSE_NOT_FOUND');
    return row.raw as string;
  }
  completeReview(note: string) {
    this.secret();
    z.string().trim().min(1).max(1000).parse(note);
    if (this.store.db.prepare('SELECT id FROM instances WHERE reconciled=0 LIMIT 1').get())
      throw new Error('SEQUENCE_UNKNOWN');
    this.store.transaction(() => {
      this.store.set('reviewRequired', 'false');
      this.store.event('restore.reviewed', 'ledger', note);
    });
  }
  async backup(password: string) {
    this.secret();
    const snapshot = this.store.transaction(() => ({
      version: 1,
      ledgerId: this.store.get('ledgerId'),
      master: this.secret(),
      customers: this.store.db.prepare('SELECT * FROM customers').all(),
      instances: this.store.db.prepare('SELECT * FROM instances').all(),
      keys: this.store.db.prepare('SELECT * FROM keys').all(),
      requests: this.store.db.prepare('SELECT * FROM requests').all(),
      packages: this.store.db.prepare('SELECT * FROM packages').all(),
      licenses: this.store.db.prepare('SELECT * FROM licenses').all(),
      events: this.store.db.prepare('SELECT * FROM events').all(),
    }));
    const bytes = Buffer.from(JSON.stringify(backupSchema.parse(snapshot)));
    if (bytes.length > 64 * 1024 * 1024) throw new Error('BACKUP_TOO_LARGE');
    try {
      return await seal(bytes, password, 'backup');
    } finally {
      bytes.fill(0);
    }
  }
  async restore(raw: string, password: string) {
    this.secret();
    if (Buffer.byteLength(raw) > 140 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const bytes = await unseal(raw, password, 'backup');
    let restored: z.infer<typeof backupSchema>;
    try {
      restored = backupSchema.parse(strictJson(bytes.toString('utf8')));
    } finally {
      bytes.fill(0);
    }
    const db = this.store.db;
    const populated = ['customers', 'instances', 'keys', 'licenses', 'packages', 'requests'].some(
      (table) => Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count) > 0,
    );
    if (populated && restored.ledgerId !== this.store.get('ledgerId'))
      throw new Error('LEDGER_MISMATCH');
    const keys = new Map<string, string>();
    for (const key of restored.keys) {
      if (
        keys.has(key.kid) ||
        publicFingerprint(key.public_key) !== key.fingerprint ||
        (key.environment === 'production' && key.kid === 'internal-test')
      )
        throw new Error('BACKUP_INVALID');
      const plaintext = await unseal(key.secret, restored.master, `key:${key.kid}`);
      try {
        const derived = createPublicKey(createPrivateKey(plaintext))
          .export({ type: 'spki', format: 'pem' })
          .toString();
        if (publicFingerprint(derived) !== key.fingerprint) throw new Error('KEY_MISMATCH');
        key.secret = await seal(plaintext, this.secret(), `key:${key.kid}`);
      } finally {
        plaintext.fill(0);
      }
      keys.set(key.kid, key.public_key);
    }
    for (const req of restored.requests) {
      const parsed = licenseRequestSchema.parse(parse(req.raw));
      const inst = restored.instances.find((i) => i.id === req.instance_id);
      if (
        parsed.requestId !== req.id ||
        parsed.installationId !== req.instance_id ||
        parsed.deviceHash !== inst?.device_hash
      )
        throw new Error('BACKUP_INVALID');
    }
    for (const pkg of restored.packages) {
      const parsed = issuerTrustSchema.parse(parse(pkg.raw));
      if (
        digest(pkg.raw) !== pkg.id ||
        parsed.environment !== pkg.environment ||
        parsed.version !== pkg.version ||
        new Set(parsed.keys.map((k) => k.kid)).size !== parsed.keys.length
      )
        throw new Error('BACKUP_INVALID');
      for (const k of parsed.keys)
        if (publicFingerprint(k.publicKey) !== k.fingerprint) throw new Error('KEY_MISMATCH');
    }
    for (const record of restored.licenses) {
      const p = payloadOf(record.raw),
        i = restored.instances.find((i) => i.id === record.instance_id);
      const header = JSON.parse(
        Buffer.from((parse(record.raw) as { protected: string }).protected, 'base64url').toString(
          'utf8',
        ),
      ) as { kid: string };
      if (
        !i ||
        p.customerId !== i.customer_id ||
        p.installationId !== i.id ||
        p.sequence > i.floor ||
        p.sequence !== record.sequence ||
        p.licenseId !== record.id ||
        digest(record.raw) !== record.digest ||
        p.issuedAt !== record.created_at ||
        header.kid !== record.kid
      )
        throw new Error('BACKUP_INVALID');
      verifyLicense(record.raw, keys, {
        installationId: i.id,
        deviceHash: i.device_hash,
        appVersion: p.minAppVersion,
        now: new Date(p.notBefore),
      });
    }
    // Retain an encrypted pre-restore snapshot before making any database changes.
    const recovery = await this.backup(password);
    writeFileSync(path.join(this.store.home, `before-restore-${randomUUID()}.missuer`), recovery, {
      flag: 'wx',
      mode: 0o600,
    });
    this.store.transaction(() => {
      if (!populated) this.store.set('ledgerId', restored.ledgerId);
      for (const c of restored.customers)
        db.prepare('INSERT OR IGNORE INTO customers VALUES(?,?,?)').run(c.id, c.name, c.note);
      for (const k of restored.keys) {
        const old = db.prepare('SELECT * FROM keys WHERE kid=?').get(k.kid) as KeyRow | undefined;
        if (old && (old.fingerprint !== k.fingerprint || old.environment !== k.environment))
          throw new Error('KEY_MISMATCH');
        if (!old)
          db.prepare('INSERT INTO keys VALUES(?,?,?,?,?,?)').run(
            k.kid,
            k.environment,
            k.public_key,
            k.fingerprint,
            k.secret,
            k.enabled,
          );
        else if (!k.enabled) db.prepare('UPDATE keys SET enabled=0 WHERE kid=?').run(k.kid);
      }
      for (const i of restored.instances) {
        const old = db.prepare('SELECT * FROM instances WHERE id=?').get(i.id) as
          | InstanceRow
          | undefined;
        if (old && (old.customer_id !== i.customer_id || old.device_hash !== i.device_hash))
          throw new Error('INSTANCE_MISMATCH');
        db.prepare(
          'INSERT INTO instances VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET floor=max(floor,excluded.floor)',
        ).run(i.id, i.customer_id, i.device_hash, i.floor);
      }
      for (const r of restored.requests) {
        const old = db.prepare('SELECT raw FROM requests WHERE id=?').get(r.id);
        if (old && old.raw !== r.raw) throw new Error('REQUEST_CONFLICT');
        db.prepare('INSERT OR IGNORE INTO requests VALUES(?,?,?)').run(r.id, r.instance_id, r.raw);
      }
      for (const p of restored.packages)
        db.prepare('INSERT OR IGNORE INTO packages VALUES(?,?,?,?)').run(
          p.id,
          p.environment,
          p.version,
          p.raw,
        );
      for (const l of restored.licenses) {
        const old = db
          .prepare(
            'SELECT * FROM licenses WHERE id=? OR operation_id=? OR (instance_id=? AND sequence=?)',
          )
          .all(l.id, l.operation_id, l.instance_id, l.sequence) as LicenseRow[];
        if (
          old.length &&
          (old.length !== 1 ||
            old[0]!.id !== l.id ||
            old[0]!.operation_id !== l.operation_id ||
            old[0]!.digest !== l.digest)
        )
          throw new Error('SEQUENCE_CONFLICT');
        if (!old.length)
          db.prepare('INSERT INTO licenses VALUES(?,?,?,?,?,?,?,?)').run(
            l.id,
            l.operation_id,
            l.instance_id,
            l.kid,
            l.sequence,
            l.raw,
            l.digest,
            l.created_at,
          );
      }
      for (const e of restored.events) {
        if (
          !db
            .prepare('SELECT id FROM events WHERE at=? AND kind=? AND object_id=? AND note=?')
            .get(e.at, e.kind, e.object_id, e.note)
        )
          db.prepare('INSERT INTO events(at,kind,object_id,note) VALUES(?,?,?,?)').run(
            e.at,
            e.kind,
            e.object_id,
            e.note,
          );
      }
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('BACKUP_INVALID');
      db.prepare('UPDATE instances SET reconciled=0').run();
      this.store.set('reviewRequired', 'true');
      this.store.event('restore.completed', 'ledger');
    });
    this.previewState = undefined;
  }
  snapshot(): IssuerSnapshot {
    this.secret();
    const db = this.store.db;
    return {
      ledgerId: this.store.get('ledgerId')!,
      reviewRequired: this.store.get('reviewRequired') === 'true',
      customers: db
        .prepare('SELECT * FROM customers ORDER BY id')
        .all() as unknown as IssuerSnapshot['customers'],
      instances: (db.prepare('SELECT * FROM instances').all() as InstanceRow[]).map((i) => ({
        id: i.id,
        customerId: i.customer_id,
        deviceHash: i.device_hash,
        floor: i.floor,
        reconciled: !!i.reconciled,
      })),
      requests: db
        .prepare('SELECT raw FROM requests')
        .all()
        .map((r) => licenseRequestSchema.parse(JSON.parse(r.raw as string))),
      keys: (db.prepare('SELECT * FROM keys').all() as KeyRow[]).map((k) => ({
        kid: k.kid,
        environment: k.environment,
        fingerprint: k.fingerprint,
        enabled: !!k.enabled,
      })),
      packages: db
        .prepare('SELECT * FROM packages')
        .all()
        .map((p) => {
          const t = issuerTrustSchema.parse(JSON.parse(p.raw as string));
          return {
            id: p.id as string,
            environment: t.environment,
            version: t.version,
            kids: t.keys.map((k) => k.kid),
          };
        }),
      licenses: (
        db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all() as LicenseRow[]
      ).map((l) => ({
        id: l.id,
        instanceId: l.instance_id,
        kid: l.kid,
        sequence: l.sequence,
        createdAt: l.created_at,
        digest: l.digest,
        payload: payloadOf(l.raw),
      })),
    };
  }
}
