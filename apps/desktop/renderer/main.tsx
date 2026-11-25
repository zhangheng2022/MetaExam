import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  Dashboard,
  MetaExamProvider,
  IdentityPanel,
  IdentityForm,
  Alert,
  Button,
  Typography,
} from '@metaexam/ui';
import '@metaexam/ui/styles.css';
import type { SystemStatus, SetupStatus, AdministratorInput } from '@metaexam/contracts';
declare global {
  interface Window {
    metaexam: {
      status: () => Promise<SystemStatus>;
      setupStatus: () => Promise<SetupStatus>;
      createAdministrator: (input: AdministratorInput) => Promise<{ ok: boolean; code?: string }>;
      openBusiness: () => Promise<void>;
    };
  }
}
const loadStatus = () => window.metaexam.status();
const messages: Record<string, string> = {
  ADMINISTRATOR_REQUIRED: '请关闭客户端，右键选择“以管理员身份运行”后重试。',
  ALREADY_INITIALIZED: '管理员已由另一个窗口创建，请重新检查。',
  SETUP_TOKEN_INVALID: '初始化令牌已失效，请重新打开客户端后重试。',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，请检查服务后重试。',
  RATE_LIMITED: '系统繁忙，请稍后重试。',
};
function Manager() {
  const [status, setStatus] = useState<SetupStatus | null>(null),
    [error, setError] = useState('');
  const refresh = () =>
    window.metaexam
      .setupStatus()
      .then((value) => {
        setStatus(value);
        setError('');
      })
      .catch(() => setError('无法连接数据库，请检查后台服务后重新检查。'));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <MetaExamProvider>
        <IdentityPanel title={status?.adminInitialized ? '管理员已创建' : '初始化管理员'}>
          {error && <Alert type="error" title={error} showIcon />}
          {status && !status.adminInitialized && !error && (
            <>
              <Typography.Paragraph>
                首次设置需要以 Windows 管理员身份运行客户端。创建后可使用普通权限运行。
              </Typography.Paragraph>
              <IdentityForm
                mode="setup"
                onSubmit={async (input) => {
                  const result = await window.metaexam.createAdministrator(
                    input as AdministratorInput,
                  );
                  if (!result.ok)
                    throw new Error(
                      messages[result.code ?? ''] ??
                        '初始化失败，请确认管理员权限、后台服务及令牌文件权限后重试。',
                    );
                  setStatus({ database: 'ready', adminInitialized: true });
                }}
              />
            </>
          )}
          {status?.adminInitialized && (
            <>
              <Typography.Paragraph>
                账号已就绪，请在浏览器中登录。关闭此窗口不会停止后台服务。
              </Typography.Paragraph>
              <Button
                type="primary"
                onClick={() =>
                  void window.metaexam
                    .openBusiness()
                    .catch(() => setError('无法打开浏览器，请手动访问本机登录地址。'))
                }
              >
                打开浏览器登录
              </Button>
            </>
          )}
          <div className="identity-actions">
            <Button onClick={() => void refresh()}>重新检查初始化状态</Button>
          </div>
        </IdentityPanel>
      </MetaExamProvider>
      <Dashboard loadStatus={loadStatus} desktop />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Manager />);
