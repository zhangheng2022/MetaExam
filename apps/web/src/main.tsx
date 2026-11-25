import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState } from 'react';
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
  BusinessShell,
  LoginSurface,
  Card,
  Skeleton,
  Statistic,
  Tag,
  Space,
} from '@metaexam/ui';
import type { SystemStatus, CurrentUser, SetupStatus } from '@metaexam/contracts';
import '@metaexam/ui/styles.css';
import { api } from './api';
import { AuthProvider, useAuth } from './auth';
import { UsersPage } from './management/users';
import { OrganizationsPage } from './management/organizations';
import { AssignmentsPage, AuditPage, WorkspacePage } from './management/teaching';
const BanksPage = lazy(() => import('./questions/pages').then((m) => ({ default: m.BanksPage })));
const pages = {
  'question-banks': ['题库管理', '维护课程题目，保留每次修订的版本。'],
  profile: ['个人信息', '查看账号资料与角色，管理你的登录安全。'],
  security: ['修改密码', '更新登录密码，保护你的账号安全。'],
  workspace: ['工作台', '查看与你相关的教学安排和系统信息。'],
  users: ['账号管理', '维护教师、学生和管理员账号。'],
  classes: ['班级管理', '维护班级资料与学生归属。'],
  courses: ['课程管理', '维护课程资料及授课关联。'],
  assignments: ['授课安排', '将教师、课程与班级关联起来。'],
  audit: ['操作日志', '查询操作结果与变更记录，时间以北京时间显示。'],
} as const;
type Page = keyof typeof pages;
const pagePath = (key: string) =>
  key === 'profile' ? '/' : key === 'security' ? '/change-password' : '/' + key;
const loadStatus = (): Promise<SystemStatus> => api('/system/status');
function Login() {
  const auth = useAuth();
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
  if (auth.loading)
    return (
      <LoginSurface>
        <IdentityPanel title="正在检查登录状态">
          <Skeleton paragraph={{ rows: 3 }} />
        </IdentityPanel>
      </LoginSurface>
    );
  if (auth.user)
    return (
      <Navigate
        to={
          auth.user.mustChangePassword
            ? '/change-password'
            : auth.user.roles.includes('admin')
              ? '/'
              : '/workspace'
        }
        replace
      />
    );
  return (
    <LoginSurface>
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
    </LoginSurface>
  );
}
function Protected({ page = 'profile' }: { page?: Page }) {
  const password = page === 'security';
  const auth = useAuth(),
    navigate = useNavigate(),
    [error, setError] = useState('');
  const [overviewBusy, setOverviewBusy] = useState(false),
    [overviewError, setOverviewError] = useState(''),
    [loggingOut, setLoggingOut] = useState(false);
  const [overview, setOverview] = useState<{
    users: number;
    classes: number;
    courses: number;
  } | null>(null);
  const loadOverview = () => {
    setOverviewBusy(true);
    setOverviewError('');
    return api<{ users: number; classes: number; courses: number }>('/admin/overview')
      .then((v) => {
        setOverview(v);
      })
      .catch((e) => setOverviewError(e.message))
      .finally(() => setOverviewBusy(false));
  };
  if (auth.loading)
    return (
      <LoginSurface>
        <IdentityPanel title="正在读取账号">
          <Skeleton paragraph={{ rows: 3 }} />
        </IdentityPanel>
      </LoginSurface>
    );
  if (auth.error)
    return (
      <LoginSurface>
        <IdentityPanel title="服务暂时不可用">
          <Alert type="error" title={auth.error} />
          <Button onClick={() => void auth.refresh()}>重试</Button>
        </IdentityPanel>
      </LoginSurface>
    );
  if (!auth.user) return <Navigate to="/login" replace />;
  const user = auth.user;
  if (user.mustChangePassword && !password) return <Navigate to="/change-password" replace />;
  const required = (
    {
      users: 'users.manage',
      classes: 'organizations.manage',
      courses: 'organizations.manage',
      assignments: 'organizations.manage',
      audit: 'audit.read',
      workspace: 'teaching.self',
      'question-banks': 'questions.use',
    } as Partial<Record<Page, string>>
  )[page];
  const allowed =
    !required ||
    (user.permissions.includes(required) &&
      (page === 'workspace' ||
        (page === 'question-banks' && user.roles.includes('teacher')) ||
        user.roles.includes('admin')));
  return (
    <BusinessShell
      title={pages[page][0]}
      description={pages[page][1]}
      displayName={user.displayName}
      selected={page}
      permissions={
        user.roles.includes('admin')
          ? user.permissions
          : user.permissions.filter((p) => p === 'questions.use' && user.roles.includes('teacher'))
      }
      mustChangePassword={user.mustChangePassword}
      onNavigate={(key) => navigate(pagePath(key))}
      loggingOut={loggingOut}
      onLogout={() => {
        setLoggingOut(true);
        void api('/auth/logout', 'POST')
          .then(() => {
            auth.setUser(null);
            navigate('/login', { replace: true });
          })
          .catch((e) => setError(e.message))
          .finally(() => setLoggingOut(false));
      }}
      actions={
        page === 'profile' && <Button onClick={() => void auth.refresh()}>刷新个人信息</Button>
      }
    >
      {error && (
        <Alert showIcon role="alert" type="error" title={error} className="identity-alert" />
      )}
      {!allowed ? (
        <Alert type="warning" title="没有访问权限" description="请从导航进入有权访问的页面。" />
      ) : page === 'question-banks' ? (
        <Suspense fallback={<Skeleton paragraph={{ rows: 5 }} />}>
          <BanksPage user={user} />
        </Suspense>
      ) : page === 'users' ? (
        <UsersPage user={user} refreshUser={auth.refresh} />
      ) : page === 'classes' || page === 'courses' ? (
        <OrganizationsPage key={page} kind={page} />
      ) : page === 'assignments' ? (
        <AssignmentsPage />
      ) : page === 'audit' ? (
        <AuditPage />
      ) : page === 'workspace' ? (
        <WorkspacePage user={user} />
      ) : password ? (
        <Card className="password-card" title="设置新密码">
          <Alert
            type="info"
            showIcon
            title={
              user.mustChangePassword
                ? '首次登录或密码被重置，请先修改密码'
                : '修改成功后需要重新登录'
            }
            description="当前账号在所有设备上的登录会话都将失效。"
            className="identity-alert"
          />
          <IdentityForm
            mode="password"
            onSubmit={async (input) => {
              await api('/auth/change-password', 'POST', input);
              auth.setNotice('密码已修改，请重新登录。');
              auth.setUser(null);
              navigate('/login', { replace: true });
            }}
          />
          {!user.mustChangePassword && (
            <div className="identity-actions">
              <Link to="/">返回个人信息</Link>
            </div>
          )}
        </Card>
      ) : (
        <>
          <div className="profile-grid">
            <Card title="基本资料" className="profile-card">
              <Descriptions
                column={1}
                size="middle"
                items={[
                  { key: 'name', label: '姓名', children: user.displayName },
                  { key: 'username', label: '用户名', children: user.username },
                  {
                    key: 'roles',
                    label: '角色',
                    children: (
                      <Space size={[0, 8]} wrap>
                        {user.roles.map((role) => (
                          <Tag color="blue" key={role}>
                            {{ admin: '管理员', teacher: '教师', student: '学生' }[role] ?? role}
                          </Tag>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>
            <Card title="账号安全" className="security-card">
              <Typography.Title level={3}>登录密码</Typography.Title>
              <Typography.Paragraph type="secondary">
                使用仅用于此账号的密码。如果密码已泄露，请及时修改。
              </Typography.Paragraph>
              <Link to="/change-password">修改密码</Link>
            </Card>
          </div>
          {user.roles.includes('admin') && (
            <Card
              className="overview-card"
              title="管理概览"
              extra={
                <Button type="primary" loading={overviewBusy} onClick={() => void loadOverview()}>
                  {overview ? '刷新管理概览' : '查看管理概览'}
                </Button>
              }
            >
              {overviewError && (
                <Alert
                  type="error"
                  showIcon
                  role="alert"
                  title={overviewError}
                  description={
                    overview
                      ? '以下为上次读取的统计，请重试获取最新数据。'
                      : '未能获取统计，请重新查看管理概览。'
                  }
                  className="identity-alert"
                />
              )}
              {overviewBusy && !overview ? (
                <Skeleton paragraph={{ rows: 2 }} />
              ) : overview ? (
                <div className="overview-statistics" aria-live="polite">
                  <Statistic title="账号数" value={overview.users} />
                  <Statistic title="班级数" value={overview.classes} />
                  <Statistic title="课程数" value={overview.courses} />
                </div>
              ) : (
                <Typography.Paragraph type="secondary" className="overview-description">
                  查看当前系统中的账号、班级与课程数量。统计由本地数据库提供。
                </Typography.Paragraph>
              )}
            </Card>
          )}
        </>
      )}
    </BusinessShell>
  );
}
function Business() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Protected />} />
        <Route path="/change-password" element={<Protected page="security" />} />
        {(
          [
            'workspace',
            'users',
            'classes',
            'courses',
            'assignments',
            'audit',
            'question-banks',
          ] as const
        ).map((page) => (
          <Route key={page} path={'/' + page} element={<Protected page={page} />} />
        ))}
        <Route path="/classes/:id" element={<Protected page="classes" />} />
        <Route path="/question-banks/:bankId" element={<Protected page="question-banks" />} />
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
