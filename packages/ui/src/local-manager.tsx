import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  ConfigProvider,
  Descriptions,
  Result,
  Skeleton,
  Typography,
  theme,
} from 'antd';
import { CopyOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import type {
  AdministratorInput,
  SetupStatus,
  SystemStatus,
  LicenseManagerBridge,
  BackupBridge,
  DiagnosticBridge,
} from '@metaexam/contracts';
import { ProductBrand } from './brand';
import { IdentityForm } from './identity';
import { LicenseActions } from './license-actions';
import { BackupActions } from './backup-actions';
import { DiagnosticActions } from './diagnostic-actions';

export interface LocalManagerBridge extends LicenseManagerBridge, BackupBridge, DiagnosticBridge {
  hideToTray: () => Promise<boolean>;
  onVisibilityChanged: (listener: (visible: boolean) => void) => () => void;
  status: () => Promise<SystemStatus>;
  setupStatus: () => Promise<SetupStatus>;
  createAdministrator: (input: AdministratorInput) => Promise<{ ok: boolean; code?: string }>;
  openBusiness: () => Promise<void>;
  copyBusinessAddress: () => Promise<void>;
}

const setupMessages: Record<string, string> = {
  ADMINISTRATOR_REQUIRED: '请从系统托盘退出管理器，再右键选择“以管理员身份运行”后重试。',
  SETUP_TOKEN_INVALID: '初始化已过期，请从系统托盘退出管理器后重新打开。',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，请检查服务后重试。',
  RATE_LIMITED: '系统繁忙，请稍后重试。',
};
const licenseLabels = {
  unactivated: '未激活',
  valid: '授权有效',
  expired: '授权已到期',
  not_yet_valid: '尚未生效',
  invalid: '校验未通过',
  clock_anomaly: '系统时间异常',
};
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function LocalManager({ bridge }: { bridge: LocalManagerBridge }) {
  const { token } = theme.useToken();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [checked, setChecked] = useState(false);
  const [serviceError, setServiceError] = useState(false);
  const [setupError, setSetupError] = useState(false);
  const [created, setCreated] = useState(false);
  const [actionError, setActionError] = useState('');
  const [opening, setOpening] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done'>('idle');
  const pending = useRef(false);
  const pendingCompletion = useRef<Promise<void>>(Promise.resolve());
  const submitting = useRef(false);
  const generation = useRef(0);
  const [saving, setSaving] = useState(false);
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current || submitting.current) return;
    pending.current = true;
    let complete!: () => void;
    pendingCompletion.current = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const request = ++generation.current;
    setBusy(true);
    try {
      const [system, initialization] = await Promise.allSettled([
        bridge.status(),
        bridge.setupStatus(),
      ]);
      if (request !== generation.current) return;
      setServiceError(system.status === 'rejected');
      setSetupError(initialization.status === 'rejected');
      if (system.status === 'fulfilled') setStatus(system.value);
      if (initialization.status === 'fulfilled') {
        // A consumed bootstrap must never reopen because of an older response.
        setSetup((previous) => ({
          ...initialization.value,
          adminInitialized: !!previous?.adminInitialized || initialization.value.adminInitialized,
        }));
      }
      setChecked(true);
    } finally {
      pending.current = false;
      complete();
      if (request === generation.current) setBusy(false);
    }
  }, [bridge]);

  useEffect(() => {
    let visible = true;
    let disposed = false;
    const refreshVisible = () => {
      if (visible && !disposed) void refresh();
    };
    const unsubscribe = bridge.onVisibilityChanged((value) => {
      visible = value;
      // Finish an older check before refreshing a restored window.
      if (value) void pendingCompletion.current.then(refreshVisible);
    });
    const interval = setInterval(refreshVisible, 15000);
    return () => {
      disposed = true;
      clearInterval(interval);
      unsubscribe();
      invalidateRequests();
    };
  }, [bridge, refresh, invalidateRequests]);

  const initialized = !!setup?.adminInitialized || !!status?.adminInitialized;
  const databaseUnavailable = !serviceError && status?.database === 'unavailable';
  const needsSetup =
    checked &&
    !initialized &&
    !setupError &&
    !serviceError &&
    setup?.database === 'ready' &&
    status?.database === 'ready';
  const unavailable =
    serviceError || setupError || databaseUnavailable || setup?.database === 'unavailable';
  const serviceReady = !!status && !unavailable && status.worker === 'online';
  const headline = !checked
    ? '正在检查服务'
    : unavailable
      ? '服务需要检查'
      : !initialized
        ? '等待首次设置'
        : status?.worker !== 'online'
          ? '后台任务未运行'
          : '服务正常';
  const errorText = serviceError
    ? '无法连接考试服务，请检查后台服务后重试。'
    : databaseUnavailable || setup?.database === 'unavailable'
      ? '数据库暂时不可用，请检查服务后重试。'
      : setupError
        ? '无法读取初始化状态，请重新检查。'
        : '';
  const openBusiness = async () => {
    setOpening(true);
    setActionError('');
    try {
      await bridge.openBusiness();
    } catch {
      setActionError('无法打开浏览器，请复制登录地址后手动访问。');
    } finally {
      setOpening(false);
    }
  };
  const copyAddress = async () => {
    setCopyState('busy');
    try {
      await bridge.copyBusinessAddress();
      setCopyState('done');
      setActionError((previous) => (previous === '复制失败，请重试。' ? '' : previous));
    } catch {
      setCopyState('idle');
      setActionError('复制失败，请重试。');
    }
  };
  const openButton = (
    <Button
      type="primary"
      aria-label="打开考试系统"
      icon={<ExportOutlined />}
      loading={opening}
      onClick={() => void openBusiness()}
    >
      打开考试系统
    </Button>
  );
  const copyButton = (
    <Button
      icon={<CopyOutlined />}
      aria-label={copyState === 'done' ? '已复制登录地址' : '复制登录地址'}
      loading={copyState === 'busy'}
      onClick={() => void copyAddress()}
    >
      {copyState === 'done' ? '已复制登录地址' : '复制登录地址'}
    </Button>
  );
  const rows = [
    {
      name: '考试服务',
      ok: !!status && !serviceError,
      value: serviceError ? '连接失败' : status ? '已连接' : '无法获取',
    },
    {
      name: '数据库',
      ok: status?.database === 'ready',
      value: status ? (status.database === 'ready' ? '已连接' : '不可用') : '无法获取',
    },
    {
      name: '后台任务',
      ok: status?.worker === 'online',
      value: status ? (status.worker === 'online' ? '运行中' : '未运行') : '无法获取',
    },
  ];
  const style = {
    '--manager-padding': `${token.paddingSM}px`,
    '--manager-gap': `${token.marginXS}px`,
    '--manager-small-gap': `${token.marginXS}px`,
    '--manager-card-heading': `${token.fontSizeLG}px`,
  } as CSSProperties;

  return (
    <ConfigProvider
      theme={{
        components: { Collapse: { headerPadding: `${token.paddingXS}px ${token.paddingSM}px` } },
      }}
    >
      <div className="local-manager" style={style}>
        <header className="local-manager-header">
          <div className="local-manager-brand">
            <ProductBrand />
          </div>
          <div className="local-manager-header-actions">
            <Button
              icon={<ReloadOutlined />}
              aria-label="检查状态"
              loading={busy}
              disabled={busy || saving}
              onClick={() => void refresh()}
            >
              检查状态
            </Button>
            <Button
              onClick={() => {
                void bridge
                  .hideToTray()
                  .catch(() => setActionError('无法切换到后台，请稍后重试。'));
              }}
            >
              后台运行
            </Button>
          </div>
        </header>
        <main className="local-manager-main">
          <div className="local-manager-summary">
            <div aria-live="polite">
              <Badge
                status={
                  !checked
                    ? 'processing'
                    : unavailable
                      ? 'error'
                      : serviceReady && initialized
                        ? 'success'
                        : 'warning'
                }
                text={<Typography.Text strong>{headline}</Typography.Text>}
              />
            </div>
            {initialized && !created && openButton}
          </div>
          {errorText && (
            <Alert
              type="error"
              showIcon
              role="alert"
              title={errorText}
              description={serviceError && status ? '以下为上次检查结果，可能已过时。' : undefined}
            />
          )}
          {actionError && (
            <Alert type="error" showIcon role="alert" title={actionError} action={copyButton} />
          )}
          {!checked ? (
            <Card>
              <Skeleton active paragraph={{ rows: 4 }} />
            </Card>
          ) : created ? (
            <Card className="local-manager-setup">
              <Result
                status="success"
                title="管理员已创建"
                extra={
                  <div className="local-manager-actions">
                    {openButton}
                    <Button onClick={() => setCreated(false)}>返回概览</Button>
                  </div>
                }
              />
            </Card>
          ) : needsSetup ? (
            <Card
              className="local-manager-setup"
              title={<Typography.Title level={2}>初始化管理员</Typography.Title>}
            >
              <Typography.Paragraph type="secondary">
                首次设置请以管理员身份运行；完成后可正常启动。
              </Typography.Paragraph>
              <IdentityForm
                mode="setup"
                onSubmit={async (input) => {
                  submitting.current = true;
                  invalidateRequests();
                  setSaving(true);
                  setBusy(false);
                  try {
                    const result = await bridge.createAdministrator(input as AdministratorInput);
                    if (!result.ok) {
                      if (result.code === 'ALREADY_INITIALIZED') {
                        setSetup({ database: 'ready', adminInitialized: true });
                        return;
                      }
                      throw new Error(
                        setupMessages[result.code ?? ''] ??
                          '初始化失败，请检查管理员权限和服务状态后重试。',
                      );
                    }
                    setSetup({ database: 'ready', adminInitialized: true });
                    setCreated(true);
                  } finally {
                    submitting.current = false;
                    setSaving(false);
                  }
                }}
              />
            </Card>
          ) : (
            <div className="local-manager-grid">
              <Card size="small" aria-label="系统服务">
                {rows.map((row) => (
                  <div className="local-manager-service" key={row.name}>
                    <Typography.Text>{row.name}</Typography.Text>
                    <Badge
                      status={!status || serviceError ? 'default' : row.ok ? 'success' : 'error'}
                      text={row.value}
                    />
                  </div>
                ))}
              </Card>
              <Card size="small" aria-label="软件授权">
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    {
                      key: 'state',
                      label: '授权状态',
                      children: (
                        <Badge
                          status={
                            !status || serviceError
                              ? 'default'
                              : status.license.state === 'valid'
                                ? 'success'
                                : 'warning'
                          }
                          text={status ? licenseLabels[status.license.state] : '无法获取'}
                        />
                      ),
                    },
                    ...(status?.license.state === 'valid'
                      ? [
                          {
                            key: 'expiry',
                            label: '有效期',
                            children: status.license.expiresAt
                              ? time(status.license.expiresAt)
                              : '永久授权',
                          },
                          {
                            key: 'capacity',
                            label: '同时作答',
                            children: `${status.license.maxConcurrentAttempts} 人`,
                          },
                        ]
                      : []),
                  ]}
                />
                {status && !serviceError && status.license.state !== 'valid' && (
                  <Typography.Paragraph type="secondary" className="local-manager-license-help">
                    请导入有效授权文件。
                  </Typography.Paragraph>
                )}
              </Card>
            </div>
          )}
          {checked && !needsSetup && !created && (
            <Collapse
              items={[
                {
                  key: 'license',
                  label: '授权维护',
                  children: (
                    <LicenseActions
                      bridge={bridge}
                      onImported={async () => {
                        // Do not let a poll started before import overwrite the new license.
                        await pendingCompletion.current;
                        await refresh();
                      }}
                    />
                  ),
                },
                { key: 'backup', label: '备份与恢复', children: <BackupActions bridge={bridge} /> },
                {
                  key: 'diagnostics',
                  label: '故障诊断',
                  children: (
                    <DiagnosticActions
                      bridge={bridge}
                      onChecked={async () => {
                        await pendingCompletion.current;
                        await refresh();
                      }}
                    />
                  ),
                },
                {
                  key: 'details',
                  label: '运行详情',
                  children: (
                    <>
                      <Descriptions
                        column={1}
                        size="small"
                        items={[
                          {
                            key: 'version',
                            label: '程序版本',
                            children: status ? `v${status.version}` : '无法获取',
                          },
                          {
                            key: 'checked',
                            label: '最近检查',
                            children: status ? time(status.checkedAt) : '尚未获取检查结果',
                          },
                          {
                            key: 'setup',
                            label: '管理员设置',
                            children: initialized ? '已完成' : unavailable ? '无法确认' : '未完成',
                          },
                        ]}
                      />
                      {!actionError && <div className="local-manager-actions">{copyButton}</div>}
                    </>
                  ),
                },
              ]}
            />
          )}
        </main>
        <footer className="local-manager-footer">
          <Typography.Text type="secondary">
            {status
              ? `v${status.version} · 最近检查 ${time(status.checkedAt)}`
              : '尚未获取检查结果'}
          </Typography.Text>
          <Typography.Text type="secondary">关闭到系统托盘 · 服务持续运行</Typography.Text>
        </footer>
      </div>
    </ConfigProvider>
  );
}
