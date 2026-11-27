import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import { ProductBrand } from './brand';
import type {
  IssuerBridge,
  IssuerDraft,
  IssuerEnvironment,
  IssuerPreview,
  IssuerResult,
  IssuerSnapshot,
} from '@metaexam/contracts';

const errors: Record<string, string> = {
  UNLOCK_FAILED: '口令错误或密钥库损坏',
  LOCKED: '已锁定，请重新解锁',
  FILE_EXISTS: '文件已存在，请另选文件名',
  SEQUENCE_UNKNOWN: '请先核对安装实例的历史序号',
  SEQUENCE_INVALID: '序号不能降低；首次签发需明确确认',
  TRUST_MISMATCH: '客户包版本或可信公钥与本次签发不匹配',
  KEY_MISMATCH: '私钥与公钥不匹配',
  INSTANCE_MISMATCH: '安装实例的客户或设备信息不一致',
  PREVIEW_EXPIRED: '预览已失效，请重新核对',
  PREVIEW_CHANGED: '授权状态已变化，请重新预览',
  REVIEW_REQUIRED: '恢复后需先核对所有实例，再完成恢复核对',
  DATES_INVALID: '请检查生效时间和到期时间',
  INVALID_OPERATION: '资料格式不正确或记录存在冲突',
  KEY_EXISTS: '密钥标识已存在',
  KEY_DISABLED: '所选密钥不可用于本次签发',
  OPERATION_FAILED: '操作失败，请检查文件和目录权限',
  OUTPUT_DIRECTORY_DENIED: '请选择程序和台账目录之外的位置',
};
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '永久';
const required = [{ required: true, message: '请填写此项' }];
type Fields = Record<string, string | number | boolean | undefined>;
function PasswordAction({
  label,
  run,
}: {
  label: string;
  run: (password: string) => Promise<void>;
}) {
  const [form] = Form.useForm();
  return (
    <Form
      name={`issuer-${label}`}
      form={form}
      layout="vertical"
      onFinish={async (values) => {
        const password = values.password as string;
        form.resetFields();
        await run(password);
      }}
    >
      <Form.Item
        name="password"
        label={`${label}口令`}
        rules={[...required, { min: 12, max: 128, message: '请输入 12～128 个字符' }]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Button htmlType="submit">{label}</Button>
    </Form>
  );
}
export function IssuerApp({ bridge }: { bridge: IssuerBridge }) {
  const { token } = theme.useToken();
  const [status, setStatus] = useState<{ initialized: boolean; unlocked: boolean }>();
  const [data, setData] = useState<IssuerSnapshot>();
  const [environment, setEnvironment] = useState<IssuerEnvironment>('test');
  const [tab, setTab] = useState('customers');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string }>();
  const [preview, setPreview] = useState<IssuerPreview>();
  const [issued, setIssued] = useState<string>();
  const [requestId, setRequestId] = useState<string>();
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<IssuerSnapshot['licenses'][number]>();
  const [draftForm] = Form.useForm();
  const [unlockForm] = Form.useForm();
  const [modal, modalContext] = Modal.useModal();
  const check = useCallback(async () => {
    const result = await bridge.status();
    if (result.ok) {
      setStatus(result.value);
      if (!result.value.unlocked) {
        setData(undefined);
        setPreview(undefined);
      }
    } else setFeedback({ type: 'error', text: '签发服务暂不可用，请重试' });
  }, [bridge]);
  useEffect(() => {
    void bridge.status().then((result) => {
      if (result.ok) setStatus(result.value);
    });
    const timer = setInterval(() => void check(), 3000);
    return () => clearInterval(timer);
  }, [bridge, check]);
  const refresh = async () => {
    const result = await bridge.snapshot();
    if (result.ok) setData(result.value);
    else throw new Error(result.code);
  };
  async function run<T>(
    operation: () => Promise<IssuerResult<T>>,
    next?: (value: T) => void,
    refreshData = true,
  ) {
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await operation();
      if (!result.ok) {
        if (result.code !== 'CANCELLED') throw new Error(result.code);
        return;
      }
      next?.(result.value);
      if (refreshData) await refresh();
      setFeedback({ type: 'success', text: '操作完成' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'OPERATION_FAILED';
      setFeedback({ type: 'error', text: errors[code] ?? `操作未完成（${code}）` });
    } finally {
      setBusy(false);
      await check();
    }
  }
  const section = { marginBottom: token.marginLG };
  const request = data?.requests.find((r) => r.requestId === requestId);
  const keyOptions =
    data?.keys
      .filter((k) => k.environment === environment && k.enabled)
      .map((k) => ({ label: k.kid, value: k.kid })) ?? [];
  const customerOptions =
    data?.customers.map((c) => ({ label: `${c.name}（${c.id}）`, value: c.id })) ?? [];
  const instanceOptions =
    data?.instances.map((i) => ({ label: `${i.customerId} · ${i.id}`, value: i.id })) ?? [];
  const actions = (
    <Space wrap>
      <Tag color={environment === 'test' ? 'orange' : 'blue'}>
        {environment === 'test' ? '测试签发' : '正式签发'}
      </Tag>
      <Select
        aria-label="签发环境"
        value={environment}
        options={[
          { value: 'test', label: '测试环境' },
          { value: 'production', label: '正式环境' },
        ]}
        disabled={busy}
        onChange={(env) => {
          setEnvironment(env);
          setPreview(undefined);
          setIssued(undefined);
          draftForm.resetFields();
          setRequestId(undefined);
          void bridge.cancelPreview();
        }}
      />
      <Button
        disabled={busy}
        onClick={() =>
          void run(
            () => bridge.lock(),
            () => setData(undefined),
            false,
          )
        }
      >
        锁定
      </Button>
    </Space>
  );
  const customerPanel = (
    <>
      <Card title="客户" style={section}>
        <Form
          name="issuer-customer"
          layout="vertical"
          onFinish={(v) =>
            void run(() => bridge.saveCustomer({ id: v.id, name: v.name, note: v.note ?? '' }))
          }
        >
          <Form.Item name="id" label="客户编号" rules={required}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="name" label="客户名称" rules={required}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea maxLength={1000} />
          </Form.Item>
          <Button htmlType="submit">保存客户</Button>
        </Form>
        <Table
          size="small"
          rowKey="id"
          dataSource={data?.customers}
          columns={[
            { title: '编号', dataIndex: 'id' },
            { title: '名称', dataIndex: 'name' },
            { title: '备注', dataIndex: 'note' },
          ]}
          scroll={{ x: 440 }}
        />
      </Card>
      <Card title="导入客户申请" style={section}>
        <Form
          name="issuer-request"
          layout="vertical"
          onFinish={(v) => void run(() => bridge.importRequest(v.customerId))}
        >
          <Form.Item name="customerId" label="关联客户" rules={required}>
            <Select options={customerOptions} />
          </Form.Item>
          <Button htmlType="submit">选择 .mreq 文件</Button>
        </Form>
        <Typography.Paragraph type="secondary">
          申请文件用于核对设备信息，不代表客户身份或付款确认。
        </Typography.Paragraph>
      </Card>
      <Card title="安装实例与历史序号">
        <Table
          rowKey="id"
          size="small"
          dataSource={data?.instances}
          scroll={{ x: 600 }}
          columns={[
            { title: '安装实例', dataIndex: 'id' },
            { title: '客户', dataIndex: 'customerId' },
            { title: '序号下限', dataIndex: 'floor' },
            { title: '核对状态', render: (_, r) => (r.reconciled ? '已核对' : '待核对') },
          ]}
        />
        <Form
          layout="vertical"
          onFinish={(v: Fields) =>
            void run(() =>
              bridge.setFloor(
                v.instanceId as string,
                v.floor as number,
                v.reason as string,
                v.never === true,
              ),
            )
          }
        >
          <Form.Item name="instanceId" label="安装实例" rules={required}>
            <Select options={instanceOptions} />
          </Form.Item>
          <Form.Item name="floor" label="已知历史最高序号" rules={required}>
            <InputNumber min={0} max={Number.MAX_SAFE_INTEGER - 1} precision={0} />
          </Form.Item>
          <Form.Item name="reason" label="核对依据" rules={required}>
            <Input.TextArea maxLength={1000} />
          </Form.Item>
          <Form.Item name="never" valuePropName="checked">
            <Checkbox>确认此实例此前从未签发（序号为 0 时必选）</Checkbox>
          </Form.Item>
          <Space wrap>
            <Button htmlType="submit">保存序号核对</Button>
            <Button onClick={() => void run(() => bridge.importHistory())}>导入历史授权</Button>
          </Space>
        </Form>
      </Card>
    </>
  );
  const draftPanel = (
    <Card title="新建授权">
      <Steps
        current={preview ? 2 : request ? 1 : 0}
        items={[{ title: '选择申请' }, { title: '配置权益' }, { title: '核对签发' }]}
        style={section}
      />
      <Form
        name="issuer-draft"
        form={draftForm}
        layout="vertical"
        onFinish={(values) => {
          const v = values as Fields;
          const draft: IssuerDraft = {
            requestId: v.requestId as string,
            kid: v.kid as string,
            packageId: v.packageId as string,
            environment,
            notBefore: v.start ? new Date(`${v.start}+08:00`).toISOString() : null,
            expiresAt: v.permanent ? null : new Date(`${v.end}+08:00`).toISOString(),
            permanentConfirmed: v.permanent === true,
            maxConcurrentAttempts: v.capacity as number,
            minAppVersion: v.minVersion as string,
            maxAppMajor: v.maxMajor as number,
          };
          void run(() => bridge.preview(draft), setPreview);
        }}
      >
        <Form.Item name="requestId" label="客户申请" rules={required}>
          <Select
            options={data?.requests.map((r) => ({
              label: `${data.instances.find((i) => i.id === r.installationId)?.customerId} · ${r.installationId} · ${r.appVersion}`,
              value: r.requestId,
            }))}
            onChange={(id) => {
              setRequestId(id);
              const r = data?.requests.find((r) => r.requestId === id);
              if (r)
                draftForm.setFieldsValue({
                  minVersion: r.appVersion,
                  maxMajor: Number(r.appVersion.split('.')[0]),
                });
            }}
          />
        </Form.Item>
        <Form.Item name="kid" label="签名密钥" rules={required}>
          <Select options={keyOptions} />
        </Form.Item>
        <Form.Item name="packageId" label="目标客户包信任清单" rules={required}>
          <Select
            options={data?.packages
              .filter((p) => p.environment === environment)
              .map((p) => ({ label: `${p.version} · ${p.kids.join(', ')}`, value: p.id }))}
          />
        </Form.Item>
        <Form.Item name="capacity" label="同时作答人数" rules={required}>
          <InputNumber min={1} max={100000} precision={0} />
        </Form.Item>
        <Form.Item name="start" label="生效时间（北京时间，留空为立即生效）">
          <Input type="datetime-local" />
        </Form.Item>
        <Form.Item name="permanent" valuePropName="checked">
          <Checkbox>签发永久授权，并确认无到期时间</Checkbox>
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.permanent !== b.permanent}>
          {({ getFieldValue }) =>
            !getFieldValue('permanent') && (
              <Form.Item name="end" label="到期时间（北京时间，不含此时刻）" rules={required}>
                <Input type="datetime-local" />
              </Form.Item>
            )
          }
        </Form.Item>
        <Form.Item
          name="minVersion"
          label="最低应用版本"
          rules={[...required, { pattern: /^\d+\.\d+\.\d+$/, message: '例如 0.1.3' }]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="maxMajor" label="最高应用主版本" rules={required}>
          <InputNumber min={0} precision={0} />
        </Form.Item>
        <Typography.Paragraph type="secondary">
          功能：考试。未来生效的授权须到生效后才能在客户电脑导入。
        </Typography.Paragraph>
        <Button type="primary" htmlType="submit">
          预览授权
        </Button>
      </Form>
      {issued && (
        <Alert
          type="success"
          title="授权已签发"
          description={
            <Button onClick={() => void run(() => bridge.exportLicense(issued))}>
              导出授权文件
            </Button>
          }
          style={{ marginTop: token.margin }}
        />
      )}
    </Card>
  );
  const historyPanel = (
    <Card title="签发记录">
      <Input.Search
        aria-label="搜索签发记录"
        placeholder="搜索客户编号或授权编号"
        allowClear
        onSearch={(q) => setSearch(q)}
        style={section}
      />
      <Table
        rowKey="id"
        dataSource={data?.licenses
          .filter((l) => data.keys.find((k) => k.kid === l.kid)?.environment === environment)
          .filter((l) =>
            `${l.id} ${l.payload.customerId}`.toLowerCase().includes(search.toLowerCase()),
          )}
        scroll={{ x: 780 }}
        columns={[
          { title: '授权编号', dataIndex: 'id' },
          { title: '客户', render: (_, r) => r.payload.customerId },
          { title: '序号', dataIndex: 'sequence' },
          { title: '人数', render: (_, r) => r.payload.maxConcurrentAttempts },
          { title: '到期时间', render: (_, r) => time(r.payload.expiresAt) },
          {
            title: '操作',
            render: (_, r) => (
              <Space wrap>
                <Button onClick={() => setDetail(r)}>查看</Button>
                <Button onClick={() => void run(() => bridge.exportLicense(r.id))}>重新导出</Button>
                <Button
                  onClick={() => {
                    const req = data?.requests.find((q) => q.installationId === r.instanceId);
                    if (!req) return;
                    setRequestId(req.requestId);
                    setTab('draft');
                    setIssued(undefined);
                    setPreview(undefined);
                    draftForm.setFieldsValue({
                      requestId: req.requestId,
                      kid: r.kid,
                      capacity: r.payload.maxConcurrentAttempts,
                      minVersion: r.payload.minAppVersion,
                      maxMajor: r.payload.maxAppMajor,
                      permanent: r.payload.expiresAt === null,
                      start: '',
                      end: '',
                      packageId: undefined,
                    });
                  }}
                >
                  续期／扩容
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
  const keysPanel = (
    <>
      <Card title="签名密钥" style={section}>
        <Space wrap style={section}>
          <Button
            onClick={() =>
              modal.confirm({
                title: `创建${environment === 'test' ? '测试' : '正式'}签名密钥？`,
                content: '密钥将以加密形式保存在本机，创建后请及时备份。',
                onOk: () => run(() => bridge.createKey(environment)),
              })
            }
          >
            创建密钥
          </Button>
          {environment === 'test' && (
            <Button onClick={() => void run(() => bridge.importTestKey())}>导入原测试密钥</Button>
          )}
        </Space>
        <Table
          rowKey="kid"
          dataSource={data?.keys.filter((k) => k.environment === environment)}
          scroll={{ x: 550 }}
          columns={[
            { title: '标识', dataIndex: 'kid' },
            { title: '公钥指纹', dataIndex: 'fingerprint' },
            { title: '状态', render: (_, r) => (r.enabled ? '可签发' : '已停用') },
            {
              title: '操作',
              render: (_, r) =>
                r.enabled && (
                  <Button
                    onClick={() =>
                      modal.confirm({
                        title: '停用此密钥？',
                        content: '停止后续签发，客户已有授权仍然有效。',
                        onOk: () => run(() => bridge.disableKey(r.kid)),
                      })
                    }
                  >
                    停用
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      <Card title="客户包信任配置" style={section}>
        <Form
          name="issuer-trust"
          layout="vertical"
          onFinish={(v) => void run(() => bridge.exportTrust(v.kid, v.version))}
        >
          <Form.Item name="kid" label="导出公钥" rules={required}>
            <Select options={keyOptions} />
          </Form.Item>
          <Form.Item name="version" label="客户包版本" rules={required}>
            <Input placeholder="例如 0.1.3" />
          </Form.Item>
          <Button htmlType="submit">导出公钥及信任清单</Button>
        </Form>
        <Space wrap style={{ marginTop: token.margin }}>
          <Button onClick={() => void run(() => bridge.importTrust())}>导入客户包信任清单</Button>
          <Button onClick={() => void run(() => bridge.importLegacyTrust('0.1.2'))}>
            接入原 0.1.2 测试包公钥
          </Button>
        </Space>
      </Card>
      <Card title="修改密钥库口令">
        <PasswordAction
          label="修改口令"
          run={(password) => run(() => bridge.changePassword(password))}
        />
      </Card>
    </>
  );
  const backupPanel = (
    <>
      <Card title="加密备份" style={section}>
        <PasswordAction label="导出备份" run={(password) => run(() => bridge.backup(password))} />
      </Card>
      <Card title="恢复备份" style={section}>
        <Typography.Paragraph>
          恢复后需核对历史序号。旧备份无法证明之后没有签发过授权，请保留并补录最新授权文件。
        </Typography.Paragraph>
        <PasswordAction
          label="选择并恢复"
          run={(password) =>
            new Promise<void>((resolve) => {
              modal.confirm({
                title: '恢复所选备份？',
                content: '会保留恢复前台账及本机已知较高序号；恢复后暂停签发，直至完成核对。',
                onOk: async () => {
                  await run(() => bridge.restore(password));
                  resolve();
                },
                onCancel: () => resolve(),
              });
            })
          }
        />
      </Card>
      {data?.reviewRequired && (
        <Card title="完成恢复核对">
          <Form
            name="issuer-review"
            layout="vertical"
            onFinish={(v) => void run(() => bridge.completeReview(v.note))}
          >
            <Form.Item name="note" label="核对说明" rules={required}>
              <Input.TextArea />
            </Form.Item>
            <Button htmlType="submit">确认已核对所有实例</Button>
          </Form>
        </Card>
      )}
    </>
  );
  return (
    <main
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: token.paddingLG,
        minHeight: '100vh',
        background: token.colorBgLayout,
      }}
    >
      {modalContext}
      <Flex wrap justify="space-between" align="center" gap={token.margin}>
        <Flex align="center" gap={token.margin} wrap>
          <ProductBrand />
          <Typography.Title level={2} style={{ margin: 0 }}>
            授权签发器
          </Typography.Title>
        </Flex>
        {status?.unlocked && actions}
      </Flex>
      {feedback && <Alert type={feedback.type} title={feedback.text} showIcon style={section} />}
      {!status ? (
        <Spin />
      ) : !status.unlocked ? (
        <Card
          title={status.initialized ? '解锁密钥库' : '设置密钥库口令'}
          style={{ maxWidth: 480, margin: '32px auto' }}
        >
          <Form
            name="issuer-unlock"
            form={unlockForm}
            layout="vertical"
            onFinish={(v) => {
              const password = v.password as string;
              unlockForm.resetFields();
              void run(() => bridge.unlock(password));
            }}
          >
            <Form.Item
              name="password"
              label="口令"
              rules={[...required, { min: 12, max: 128, message: '请输入 12～128 个字符' }]}
            >
              <Input.Password autoComplete="off" />
            </Form.Item>
            {!status.initialized && (
              <Form.Item
                name="confirm"
                label="确认口令"
                dependencies={['password']}
                rules={[
                  ...required,
                  ({ getFieldValue }) => ({
                    validator: (_, value) =>
                      value === getFieldValue('password')
                        ? Promise.resolve()
                        : Promise.reject(new Error('两次口令不一致')),
                  }),
                ]}
              >
                <Input.Password autoComplete="off" />
              </Form.Item>
            )}
            <Typography.Paragraph type="secondary">
              口令无法找回，请妥善保管并创建加密备份。
            </Typography.Paragraph>
            <Button type="primary" htmlType="submit" loading={busy}>
              {status.initialized ? '解锁' : '创建密钥库'}
            </Button>
          </Form>
        </Card>
      ) : !data ? (
        <Empty description="尚未读取台账">
          <Button onClick={() => void run(() => bridge.snapshot(), setData, false)}>
            读取台账
          </Button>
        </Empty>
      ) : (
        <Spin spinning={busy}>
          {data.reviewRequired && (
            <Alert type="warning" title="恢复后待核对，暂不能签发" style={section} />
          )}
          <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: 'customers', label: '客户与实例', children: customerPanel },
                { key: 'draft', label: '新建授权', children: draftPanel },
                { key: 'history', label: '签发记录', children: historyPanel },
                { key: 'keys', label: '密钥与客户包', children: keysPanel },
                { key: 'backup', label: '备份与恢复', children: backupPanel },
              ]}
            />
          </fieldset>
        </Spin>
      )}
      <Modal
        title="核对授权并签发"
        open={!!preview && !!status?.unlocked}
        confirmLoading={busy}
        onCancel={() => {
          setPreview(undefined);
          void bridge.cancelPreview();
        }}
        onOk={() => {
          if (preview)
            void run(
              () => bridge.confirm(preview.id, preview.operationId),
              (result) => {
                setIssued(result.id);
                setPreview(undefined);
              },
            );
        }}
        okText="确认签发"
        cancelText="取消"
      >
        {preview && (
          <>
            <Descriptions
              column={1}
              items={[
                { key: 'customer', label: '客户', children: preview.payload.customerId },
                { key: 'sequence', label: '序号', children: preview.payload.sequence },
                { key: 'instance', label: '安装实例', children: preview.payload.installationId },
                {
                  key: 'capacity',
                  label: '人数',
                  children: `${preview.previous?.maxConcurrentAttempts ?? '—'} → ${preview.payload.maxConcurrentAttempts}`,
                },
                {
                  key: 'start',
                  label: '生效时间（北京时间）',
                  children: time(preview.payload.notBefore),
                },
                {
                  key: 'end',
                  label: '到期时间（北京时间）',
                  children: `${preview.previous ? time(preview.previous.expiresAt) : '—'} → ${time(preview.payload.expiresAt)}`,
                },
              ]}
            />
            {!preview.payload.expiresAt && <Alert type="warning" title="本次签发为永久授权" />}
          </>
        )}
      </Modal>
      <Modal title="授权详情" open={!!detail} footer={null} onCancel={() => setDetail(undefined)}>
        {detail && (
          <Descriptions
            column={1}
            items={[
              { key: 'id', label: '授权编号', children: detail.id },
              { key: 'kid', label: '密钥', children: detail.kid },
              { key: 'digest', label: 'SHA-256', children: detail.digest },
              { key: 'customer', label: '客户编号', children: detail.payload.customerId },
              { key: 'instance', label: '安装实例', children: detail.instanceId },
              { key: 'sequence', label: '序号', children: detail.sequence },
              {
                key: 'capacity',
                label: '同时作答人数',
                children: detail.payload.maxConcurrentAttempts,
              },
              { key: 'issued', label: '签发时间（北京时间）', children: time(detail.createdAt) },
              {
                key: 'start',
                label: '生效时间（北京时间）',
                children: time(detail.payload.notBefore),
              },
              {
                key: 'end',
                label: '到期时间（北京时间）',
                children: time(detail.payload.expiresAt),
              },
              {
                key: 'version',
                label: '应用版本',
                children: `最低 ${detail.payload.minAppVersion}，最高主版本 ${detail.payload.maxAppMajor}`,
              },
            ]}
          />
        )}
      </Modal>
    </main>
  );
}
