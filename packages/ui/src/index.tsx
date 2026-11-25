import {
  useCallback,
  useEffect,
  useState,
  type PropsWithChildren,
  type CSSProperties,
} from 'react';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Menu,
  Tag,
  Typography,
  theme as antdTheme,
  type ThemeConfig,
} from 'antd';
import { DashboardOutlined, ReloadOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import type { SystemStatus } from '@metaexam/contracts';

const theme: ThemeConfig = {
  token: {
    // Use Ant Design's default blue primary color and generated interaction colors.
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    motion: false,
  },
  components: {
    Typography: { titleMarginTop: 0, titleMarginBottom: 8 },
    Card: { headerFontSize: 18 },
    Descriptions: { labelColor: 'rgba(0, 0, 0, 0.65)' },
  },
};
export function MetaExamProvider({ children }: PropsWithChildren) {
  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <ThemeSurface>{children}</ThemeSurface>
    </ConfigProvider>
  );
}
function ThemeSurface({ children }: PropsWithChildren) {
  const { token } = antdTheme.useToken();
  const style = {
    '--mx-layout': token.colorBgLayout,
    '--mx-surface': token.colorBgContainer,
    '--mx-text': token.colorText,
    '--mx-secondary': token.colorTextSecondary,
    '--mx-border': token.colorBorderSecondary,
    '--mx-primary': token.colorPrimary,
    '--mx-primary-bg': token.colorPrimaryBg,
    '--mx-radius': `${token.borderRadiusLG}px`,
    color: token.colorText,
    background: token.colorBgLayout,
  } as CSSProperties;
  return (
    <div className="theme-surface" style={style}>
      {children}
    </div>
  );
}
export interface DashboardProps {
  loadStatus: () => Promise<SystemStatus>;
  desktop?: boolean;
}
const labels = {
  unactivated: '未激活',
  valid: '授权有效',
  expired: '授权已到期',
  not_yet_valid: '尚未生效',
  invalid: '校验未通过',
  clock_anomaly: '系统时间异常',
};
const { Title, Paragraph, Text } = Typography;
export function Dashboard(props: DashboardProps) {
  return (
    <MetaExamProvider>
      <StatusOverview {...props} />
    </MetaExamProvider>
  );
}
function StatusOverview({ loadStatus, desktop = false }: DashboardProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const refresh = useCallback(
    () =>
      Promise.resolve()
        .then(loadStatus)
        .then(
          (nextStatus) => {
            setStatus(nextStatus);
            setError('');
          },
          () => setError('暂时无法连接考试服务。请检查服务是否启动，然后重试。'),
        )
        .finally(() => setBusy(false)),
    [loadStatus],
  );
  const requestRefresh = useCallback(() => {
    setBusy(true);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    // Initial loading is already represented by busy's initial state. Start the
    // request here; manual and timer events set busy before subsequent requests.
    void refresh();
    const id = setInterval(requestRefresh, 15000);
    return () => clearInterval(id);
  }, [refresh, requestRefresh]);
  const ready = !!status && status.database === 'ready' && status.worker === 'online';
  const unavailable = !!error && !status && !busy;
  const serviceRows = [
    {
      name: '考试服务',
      description: '为局域网浏览器提供访问',
      value: error ? '连接失败' : status ? '已连接' : '检查中',
      ok: !!status && !error,
    },
    {
      name: '本地数据库',
      description: '保存系统配置和业务数据',
      value:
        status?.database === 'ready'
          ? '已连接'
          : status
            ? '连接失败'
            : unavailable
              ? '无法获取'
              : '检查中',
      ok: status?.database === 'ready',
    },
    {
      name: '后台任务',
      description: '独立处理任务，不依赖管理窗口',
      value:
        status?.worker === 'online'
          ? '运行中'
          : status
            ? '未运行'
            : unavailable
              ? '无法获取'
              : '检查中',
      ok: status?.worker === 'online',
    },
  ];
  const licenseText = status ? labels[status.license.state] : unavailable ? '无法获取' : '正在读取';
  return (
    <div className="metaexam-shell">
      <aside className="metaexam-sidebar">
        <a className="metaexam-brand" href="./" aria-label="MetaExam 运行概览">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M5 25V7l11 10L27 7v18M11 25V18l5 5 5-5v7" />
          </svg>
          <span>
            MetaExam<small>本地考试管理</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={['overview']}
            items={[
              {
                key: 'overview',
                icon: <DashboardOutlined />,
                label: (
                  <a href="#service-heading" aria-current="page">
                    运行概览
                  </a>
                ),
              },
            ]}
          />
        </nav>
        <p className="metaexam-sidebar-note">
          数据留在本地
          <br />
          授权离线验证
        </p>
      </aside>
      <main className="metaexam-content">
        <header className="metaexam-header">
          <div>
            <Title level={1}>运行概览</Title>
            <Paragraph type="secondary">检查服务状态，做好考试前的准备。</Paragraph>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={busy}
            disabled={busy}
            onClick={requestRefresh}
          >
            {busy ? '检查中…' : '重新检查'}
          </Button>
        </header>
        {error && (
          <Alert
            className="metaexam-error"
            type="error"
            showIcon
            role="alert"
            title={error}
            description={status ? '以下为上次检查结果，可能已过时。' : undefined}
          />
        )}
        <section aria-labelledby="service-heading">
          <Card
            className="metaexam-services"
            title={
              <Title level={2} id="service-heading">
                系统服务
              </Title>
            }
            extra={
              <Tag color={error ? 'error' : ready ? 'success' : 'warning'}>
                {error ? '连接中断' : !status ? '等待检查' : ready ? '运行正常' : '需要检查'}
              </Tag>
            }
          >
            {serviceRows.map((row) => (
              <div className="metaexam-service-row" key={row.name}>
                <div>
                  <Title level={3}>{row.name}</Title>
                  <Text type="secondary">{row.description}</Text>
                </div>
                <Tag color={status && !error ? (row.ok ? 'success' : 'warning') : 'default'}>
                  {row.value}
                </Tag>
              </div>
            ))}
          </Card>
        </section>
        <section className="metaexam-license" aria-labelledby="license-heading">
          <div>
            <Title level={2} id="license-heading">
              软件授权
            </Title>
            <Paragraph type="secondary">在部署电脑上验证授权文件，无需连接互联网。</Paragraph>
          </div>
          <div>
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: 'state',
                  label: '授权状态',
                  children: (
                    <Tag
                      color={status?.license.state === 'valid' && !error ? 'success' : 'default'}
                    >
                      {licenseText}
                    </Tag>
                  ),
                },
                ...(status?.license.state === 'valid'
                  ? [
                      {
                        key: 'expiry',
                        label: '有效期限',
                        children: status.license.expiresAt
                          ? new Date(status.license.expiresAt).toLocaleDateString('zh-CN')
                          : '永久授权',
                      },
                      {
                        key: 'capacity',
                        label: '同时作答人数',
                        children: status.license.maxConcurrentAttempts,
                      },
                    ]
                  : []),
              ]}
            />
            {status?.license.state !== 'valid' && (
              <Paragraph type="secondary" className="metaexam-license-help">
                {unavailable
                  ? '恢复服务连接后重新检查授权状态。'
                  : '请由本机维护人员导入有效授权文件。'}
              </Paragraph>
            )}
          </div>
        </section>
        <section className="metaexam-stage" aria-labelledby="stage-heading">
          <Alert
            type="info"
            showIcon
            role="note"
            title={
              <Title level={2} id="stage-heading">
                技术验证阶段
              </Title>
            }
            description={
              <>
                <div>当前版本用于验证服务运行、数据库连接和本地授权，尚未开放正式考试。</div>
                {desktop && <div>关闭此窗口不会停止后台考试服务。</div>}
              </>
            }
          />
        </section>
        <footer className="metaexam-footer">
          <Text type="secondary">
            {desktop ? '桌面管理程序' : '本机运行状态'} ·{' '}
            {status ? 'v' + status.version : 'MetaExam'}
          </Text>
          <Text type="secondary" aria-live="polite">
            {status
              ? '最近检查 ' + new Date(status.checkedAt).toLocaleTimeString('zh-CN')
              : unavailable
                ? '尚未获取检查结果'
                : '等待服务响应'}
          </Text>
        </footer>
      </main>
    </div>
  );
}
export * from './identity';
export * from './business';
