import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router';
import {
  Dashboard,
  MetaExamProvider,
  IdentityPanel,
  IdentityForm,
  Alert,
  Button,
  Descriptions,
  Typography,
} from '@metaexam/ui';
import type { SystemStatus, CurrentUser, SetupStatus } from '@metaexam/contracts';
import '@metaexam/ui/styles.css';
import { api } from './api';
import { AuthProvider, useAuth } from './auth';
const loadStatus = (): Promise<SystemStatus> => api('/system/status');
function Login() {
  const auth = useAuth(),
    navigate = useNavigate();
  const [setup, setSetup] = useState<SetupStatus | null>(null),
    [error, setError] = useState('');
  const check = () =>
    api<SetupStatus>('/setup/status')
      .then((s) => {
        setSetup(s);
        setError('');
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void check();
  }, []);
  if (auth.loading) return <IdentityPanel title="正在检查登录状态" />;
  if (auth.user) return <Navigate to="/" replace />;
  return (
    <IdentityPanel title="登录 MetaExam">
      <Typography.Paragraph>使用管理员为你创建的账号登录。</Typography.Paragraph>
      {!!auth.notice && <Alert type="success" title={auth.notice} className="identity-alert" />}
      {auth.expired && !auth.notice && (
        <Alert type="info" title="登录已过期，请重新登录。" className="identity-alert" />
      )}
      {error ? (
        <>
          <Alert type="error" title={error} />
          <Button onClick={() => void check()}>重新检查</Button>
        </>
      ) : setup?.adminInitialized ? (
        <IdentityForm
          mode="login"
          onSubmit={async (input) => {
            const user = await api<CurrentUser>('/auth/login', 'POST', input);
            auth.setNotice('');
            auth.setUser(user);
            navigate('/', { replace: true });
          }}
        />
      ) : setup ? (
        <Alert
          type="info"
          title="系统尚未初始化"
          description="请在服务器上以管理员身份运行 MetaExam 客户端，完成首次管理员设置。"
        />
      ) : (
        <Typography.Paragraph>正在检查系统…</Typography.Paragraph>
      )}
    </IdentityPanel>
  );
}
function Protected({ password = false }: { password?: boolean }) {
  const auth = useAuth(),
    navigate = useNavigate(),
    [error, setError] = useState('');
  const [overview, setOverview] = useState<{
    users: number;
    classes: number;
    courses: number;
  } | null>(null);
  const loadOverview = () =>
    api<{ users: number; classes: number; courses: number }>('/admin/overview')
      .then((v) => {
        setOverview(v);
        setError('');
      })
      .catch((e) => setError(e.message));
  if (auth.loading)
    return (
      <IdentityPanel title="正在读取账号">
        <Typography.Paragraph>请稍候…</Typography.Paragraph>
      </IdentityPanel>
    );
  if (auth.error)
    return (
      <IdentityPanel title="服务暂时不可用">
        <Alert type="error" title={auth.error} />
        <Button onClick={() => void auth.refresh()}>重试</Button>
      </IdentityPanel>
    );
  if (!auth.user) return <Navigate to="/login" replace />;
  const user = auth.user;
  return (
    <IdentityPanel title={password ? '修改密码' : '个人信息'}>
      {error && <Alert type="error" title={error} className="identity-alert" />}
      {password ? (
        <IdentityForm
          mode="password"
          onSubmit={async (input) => {
            await api('/auth/change-password', 'POST', input);
            auth.setNotice('密码已修改，请重新登录。');
            auth.setUser(null);
            navigate('/login', { replace: true });
          }}
        />
      ) : (
        <>
          <Descriptions
            column={1}
            items={[
              { key: 'name', label: '姓名', children: user.displayName },
              { key: 'username', label: '用户名', children: user.username },
              {
                key: 'roles',
                label: '角色',
                children: user.roles
                  .map(
                    (role) => ({ admin: '管理员', teacher: '教师', student: '学生' })[role] ?? role,
                  )
                  .join('、'),
              },
            ]}
          />
          {user.roles.includes('admin') && (
            <>
              <Button onClick={() => void loadOverview()}>查看管理概览</Button>
              {overview && (
                <Descriptions
                  column={1}
                  items={[
                    { key: 'users', label: '账号数', children: overview.users },
                    { key: 'classes', label: '班级数', children: overview.classes },
                    { key: 'courses', label: '课程数', children: overview.courses },
                  ]}
                />
              )}
            </>
          )}
          <div className="identity-actions">
            <Button onClick={() => void auth.refresh()}>刷新个人信息</Button>
            <Link to="/change-password">修改密码</Link>
          </div>
        </>
      )}
      <div className="identity-actions">
        {password && <Link to="/">返回个人信息</Link>}
        <Button
          onClick={() =>
            void api('/auth/logout', 'POST')
              .then(() => {
                auth.setUser(null);
                navigate('/login', { replace: true });
              })
              .catch((e) => setError(e.message))
          }
        >
          退出登录
        </Button>
      </div>
    </IdentityPanel>
  );
}
function Business() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected />} />
        <Route path="/change-password" element={<Protected password />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <MetaExamProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/status" element={<Dashboard loadStatus={loadStatus} />} />
        <Route path="*" element={<Business />} />
      </Routes>
    </BrowserRouter>
  </MetaExamProvider>,
);
