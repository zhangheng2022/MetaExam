import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Select, Space, Switch, Tag } from '@metaexam/ui';
import type { CurrentUser, ManagedUser } from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, Editor, Filters, roleName, roleOptions, usePaged } from './common';
export function UsersPage({
  user,
  refreshUser,
}: {
  user: CurrentUser;
  refreshUser: () => Promise<void>;
}) {
  const list = usePaged<ManagedUser>('/admin/users');
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null),
    [reset, setReset] = useState<ManagedUser | null>(null),
    [notice, setNotice] = useState('');
  return (
    <Card>
      <div className="management-toolbar">
        <span>维护账号资料、角色与启停状态</span>
        <Button type="primary" onClick={() => setEditing('new')}>
          创建账号
        </Button>
      </div>
      {notice && (
        <Alert type="success" title={notice} showIcon closable className="identity-alert" />
      )}
      <Filters list={list} users />
      <DataTable
        list={list}
        columns={[
          { title: '姓名', dataIndex: 'displayName', width: 160 },
          { title: '用户名', dataIndex: 'username', width: 160 },
          {
            title: '角色',
            render: (_, row) =>
              row.roles.map((r) => (
                <Tag key={r} color="blue">
                  {roleName(r)}
                </Tag>
              )),
          },
          {
            title: '状态',
            render: (_, row) => (
              <Space wrap>
                <Tag color={row.enabled ? 'success' : 'default'}>
                  {row.enabled ? '启用' : '停用'}
                </Tag>
                {row.mustChangePassword && <Tag>待修改密码</Tag>}
              </Space>
            ),
          },
          {
            title: '操作',
            width: 192,
            render: (_, row) => (
              <Space>
                <Button type="link" onClick={() => setEditing(row)}>
                  编辑
                </Button>
                <Button type="link" disabled={row.id === user.id} onClick={() => setReset(row)}>
                  重置密码
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <Editor
          title={editing === 'new' ? '创建账号' : '编辑账号'}
          initialValues={editing === 'new' ? { roles: ['student'], enabled: true } : editing}
          close={() => setEditing(null)}
          done={() => {
            const self = editing !== 'new' && editing.id === user.id;
            setEditing(null);
            list.reload();
            if (self) void refreshUser();
          }}
          save={async (v) => {
            if (editing === 'new')
              await api('/admin/users', 'POST', {
                username: v.username,
                displayName: v.displayName,
                password: v.password,
                roles: v.roles,
              });
            else
              await api('/admin/users/' + editing.id, 'PATCH', {
                displayName: v.displayName,
                roles: v.roles,
                enabled: v.enabled,
                revision: editing.revision,
              });
            setNotice(
              editing === 'new' ? '账号已创建，首次登录需要修改密码。' : '账号资料已保存。',
            );
          }}
        >
          {editing === 'new' ? (
            <Form.Item
              name="username"
              label="用户名"
              rules={[
                { required: true },
                {
                  pattern: /^[a-zA-Z0-9._-]{3,64}$/,
                  message: '使用 3～64 位字母、数字、点、下划线或连字符',
                },
              ]}
            >
              <Input
                maxLength={64}
                autoComplete="off"
                placeholder="3～64 位字母、数字、点、下划线或连字符"
              />
            </Form.Item>
          ) : (
            <Alert
              type="info"
              title={`用户名：${editing.username}（创建后不可修改）`}
              className="identity-alert"
            />
          )}
          <Form.Item
            name="displayName"
            label="姓名"
            rules={[{ required: true, whitespace: true }, { max: 100 }]}
          >
            <Input maxLength={100} placeholder="请输入姓名" />
          </Form.Item>
          <Form.Item
            name="roles"
            label="角色"
            rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个角色' }]}
          >
            <Select mode="multiple" options={roleOptions} placeholder="请选择角色，可多选" />
          </Form.Item>
          {editing === 'new' ? (
            <>
              <PasswordInput />
              <Alert
                type="info"
                title="请通过可信方式将临时密码告知用户。首次登录后必须修改密码。"
              />
            </>
          ) : (
            <Form.Item name="enabled" label="启用账号" valuePropName="checked">
              <Switch disabled={editing.id === user.id} />
            </Form.Item>
          )}
        </Editor>
      )}
      {reset && (
        <Editor
          title={`重置密码：${reset.displayName}`}
          close={() => setReset(null)}
          done={() => {
            setReset(null);
            list.reload();
          }}
          save={async (v) => {
            await api('/admin/users/' + reset.id + '/reset-password', 'POST', {
              password: v.password,
              revision: reset.revision,
            });
            setNotice('密码已重置，原登录会话已撤销，下次登录必须修改密码。');
          }}
        >
          <Alert
            type="warning"
            showIcon
            title="将撤销该账号在所有设备上的登录会话。"
            className="identity-alert"
          />
          <PasswordInput />
        </Editor>
      )}
    </Card>
  );
}
function PasswordInput() {
  return (
    <Form.Item
      name="password"
      label="临时密码"
      rules={[
        { required: true, message: '请设置临时密码' },
        { min: 6, max: 128, message: '密码长度为 6～128 个字符' },
      ]}
    >
      <Input.Password
        maxLength={128}
        autoComplete="new-password"
        placeholder="请输入 6～128 个字符的临时密码"
      />
    </Form.Item>
  );
}
