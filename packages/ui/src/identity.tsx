import { useState, useEffect, type PropsWithChildren } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import type { AdministratorInput, LoginInput, ChangePasswordInput } from '@metaexam/contracts';
export { Alert, Button, Descriptions, Typography } from 'antd';
export function IdentityPanel({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <section className="identity-panel">
      <Card>
        <Typography.Title level={1}>{title}</Typography.Title>
        {children}
      </Card>
    </section>
  );
}
export function PasswordField({
  name = 'password',
  label = '密码',
  confirmation = false,
}: {
  name?: string;
  label?: string;
  confirmation?: boolean;
}) {
  return (
    <Form.Item
      name={name}
      label={label}
      dependencies={confirmation ? ['password', 'newPassword'] : undefined}
      rules={[
        { required: true, message: '请输入' + label },
        { min: 12, max: 128, message: '密码长度为 12～128 个字符' },
        ...(confirmation
          ? [
              ({ getFieldValue }: { getFieldValue: (name: string) => string }) => ({
                validator: (_: unknown, value: string) =>
                  value === (getFieldValue('newPassword') ?? getFieldValue('password'))
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次密码不一致')),
              }),
            ]
          : []),
      ]}
    >
      <Input.Password autoComplete="new-password" maxLength={128} />
    </Form.Item>
  );
}
export function IdentityForm({
  mode,
  onSubmit,
}: {
  mode: 'setup' | 'login' | 'password';
  onSubmit: (input: AdministratorInput | LoginInput | ChangePasswordInput) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => () => form.resetFields(), [form]);
  const submit = async (values: Record<string, string>) => {
    setBusy(true);
    setError('');
    const input =
      mode === 'password'
        ? { oldPassword: values.oldPassword!, newPassword: values.newPassword! }
        : mode === 'setup'
          ? {
              username: values.username!,
              displayName: values.displayName!,
              password: values.password!,
            }
          : { username: values.username!, password: values.password! };
    try {
      await onSubmit(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
      form.setFieldsValue({
        password: undefined,
        oldPassword: undefined,
        newPassword: undefined,
        confirm: undefined,
      });
    }
  };
  return (
    <Form
      form={form}
      layout="vertical"
      size="large"
      onFinish={submit}
      disabled={busy}
      clearOnDestroy
    >
      {error && <Alert type="error" title={error} showIcon className="identity-alert" />}
      {mode !== 'password' && (
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            {
              pattern: /^\s*[a-zA-Z0-9._-]{3,64}\s*$/,
              message: '使用 3～64 位字母、数字、点、下划线或连字符',
            },
          ]}
        >
          <Input autoComplete="username" maxLength={70} />
        </Form.Item>
      )}
      {mode === 'setup' && (
        <Form.Item
          name="displayName"
          label="姓名"
          rules={[{ required: true, whitespace: true, message: '请输入姓名' }, { max: 100 }]}
        >
          <Input maxLength={100} autoComplete="name" />
        </Form.Item>
      )}
      {mode === 'login' ? (
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password autoComplete="current-password" maxLength={128} />
        </Form.Item>
      ) : (
        <>
          {mode === 'password' && (
            <Form.Item
              name="oldPassword"
              label="原密码"
              rules={[{ required: true, message: '请输入原密码' }]}
            >
              <Input.Password autoComplete="current-password" maxLength={128} />
            </Form.Item>
          )}
          <PasswordField
            name={mode === 'password' ? 'newPassword' : 'password'}
            label={mode === 'password' ? '新密码' : '密码'}
          />
          <PasswordField name="confirm" label="确认密码" confirmation />
          <Typography.Paragraph type="secondary">
            密码支持短语，长度为 12～128 个字符。
          </Typography.Paragraph>
        </>
      )}
      <Button type="primary" htmlType="submit" loading={busy} block>
        {mode === 'setup' ? '创建管理员' : mode === 'password' ? '保存新密码' : '登录'}
      </Button>
    </Form>
  );
}
