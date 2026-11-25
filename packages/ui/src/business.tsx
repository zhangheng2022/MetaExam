import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Avatar, Breadcrumb, Button, Drawer, Layout, Menu, Typography } from 'antd';
import {
  BookOutlined,
  LogoutOutlined,
  MenuOutlined,
  SafetyOutlined,
  UserOutlined,
} from '@ant-design/icons';

export { Card, Skeleton, Statistic, Tag, Space } from 'antd';

export function ProductBrand() {
  return (
    <div className="product-brand">
      <BookOutlined aria-hidden />
      <span>MetaExam</span>
    </div>
  );
}

export function LoginSurface({ children }: PropsWithChildren) {
  return (
    <div className="login-surface">
      <header className="login-brand">
        <ProductBrand />
        <Typography.Text type="secondary">本地考试管理系统</Typography.Text>
      </header>
      <main className="login-main">{children}</main>
      <footer className="login-footer">MetaExam · 局域网访问，数据本地保存</footer>
    </div>
  );
}

interface BusinessShellProps extends PropsWithChildren {
  title: string;
  description: string;
  displayName: string;
  selected: 'profile' | 'security';
  onNavigate: (key: string) => void;
  onLogout: () => void;
  loggingOut: boolean;
  actions?: ReactNode;
}

export function BusinessShell({
  title,
  description,
  displayName,
  selected,
  onNavigate,
  onLogout,
  loggingOut,
  actions,
  children,
}: BusinessShellProps) {
  const [open, setOpen] = useState(false);
  const navigation = (
    <nav aria-label="账号导航">
      <Menu
        mode="inline"
        selectedKeys={[selected]}
        onClick={({ key }) => {
          setOpen(false);
          onNavigate(key);
        }}
        items={[
          { key: 'profile', icon: <UserOutlined />, label: '个人信息' },
          { key: 'security', icon: <SafetyOutlined />, label: '账号安全' },
        ]}
      />
    </nav>
  );
  return (
    <Layout className="business-shell">
      <a className="skip-link" href="#business-main">
        跳转到主要内容
      </a>
      <Layout.Sider width={224} theme="light" className="business-sidebar">
        <div className="business-brand">
          <ProductBrand />
        </div>
        {navigation}
        <div className="business-sidebar-footer">本地考试管理系统</div>
      </Layout.Sider>
      <Layout className="business-body">
        <Layout.Header className="business-header">
          <div className="business-header-start">
            <Button
              className="mobile-navigation"
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开导航"
              onClick={() => setOpen(true)}
            />
            <Breadcrumb items={[{ title: '账号中心' }, { title }]} />
          </div>
          <div className="business-user">
            <Avatar size="small" icon={<UserOutlined />} />
            <span className="business-user-name" title={displayName}>
              {displayName}
            </span>
            <Button
              aria-label="退出登录"
              type="text"
              icon={<LogoutOutlined aria-hidden />}
              loading={loggingOut}
              onClick={onLogout}
            >
              退出登录
            </Button>
          </div>
        </Layout.Header>
        <Layout.Content>
          <main id="business-main" className="business-main" tabIndex={-1}>
            <header className="business-page-heading">
              <div>
                <Typography.Title level={1}>{title}</Typography.Title>
                <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
              </div>
              {actions}
            </header>
            {children}
          </main>
        </Layout.Content>
        <Layout.Footer className="business-footer">MetaExam · 账号中心</Layout.Footer>
      </Layout>
      <Drawer
        title="MetaExam 导航"
        placement="left"
        size={280}
        open={open}
        onClose={() => setOpen(false)}
      >
        {navigation}
      </Drawer>
    </Layout>
  );
}
