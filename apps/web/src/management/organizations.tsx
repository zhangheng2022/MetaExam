import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
} from '@metaexam/ui';
import type { ManagedUser, Organization } from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, Editor, Filters, RemotePicker, usePaged } from './common';
export function OrganizationsPage({ kind }: { kind: 'classes' | 'courses' }) {
  const { id } = useParams();
  return id ? <MembersPage id={id} /> : <OrganizationList key={kind} kind={kind} />;
}
function OrganizationList({ kind }: { kind: 'classes' | 'courses' }) {
  const list = usePaged<Organization>('/admin/organizations/' + kind),
    location = useLocation();
  const [editing, setEditing] = useState<Organization | 'new' | null>(null),
    [notice, setNotice] = useState('');
  const noun = kind === 'classes' ? '班级' : '课程';
  return (
    <Card>
      <div className="management-toolbar">
        <span>{noun}停用后仍保留历史关联</span>
        <Button type="primary" onClick={() => setEditing('new')}>
          创建{noun}
        </Button>
      </div>
      {notice && (
        <Alert type="success" title={notice} showIcon closable className="identity-alert" />
      )}
      <Filters list={list} />
      <DataTable
        list={list}
        columns={[
          { title: `${noun}编码`, dataIndex: 'code', width: 160 },
          { title: `${noun}名称`, dataIndex: 'name' },
          ...(kind === 'classes'
            ? [{ title: '学生人数', dataIndex: 'memberCount', width: 100 }]
            : []),
          {
            title: '状态',
            width: 100,
            render: (_, row) => (
              <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag>
            ),
          },
          {
            title: '操作',
            width: 240,
            render: (_, row) => (
              <Space>
                <Button type="link" onClick={() => setEditing(row)}>
                  编辑
                </Button>
                {kind === 'classes' && (
                  <Link to={'/classes/' + row.id} state={{ listSearch: location.search }}>
                    学生名单
                  </Link>
                )}
                <Link
                  to={
                    '/assignments?' + (kind === 'classes' ? 'classId' : 'courseId') + '=' + row.id
                  }
                >
                  授课安排
                </Link>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <Editor
          title={(editing === 'new' ? '创建' : '编辑') + noun}
          initialValues={editing === 'new' ? { enabled: true } : editing}
          close={() => setEditing(null)}
          done={() => {
            setEditing(null);
            list.reload();
          }}
          save={async (v) => {
            await api(
              '/admin/organizations/' + kind + (editing === 'new' ? '' : '/' + editing.id),
              editing === 'new' ? 'POST' : 'PATCH',
              {
                code: v.code,
                name: v.name,
                ...(editing === 'new' ? {} : { enabled: v.enabled, revision: editing.revision }),
              },
            );
            setNotice(`${noun}已保存。`);
          }}
        >
          <Form.Item
            name="code"
            label={`${noun}编码`}
            rules={[
              { required: true },
              {
                pattern: /^[a-zA-Z0-9._-]{1,64}$/,
                message: '使用 1～64 位字母、数字、点、下划线或连字符',
              },
            ]}
          >
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item
            name="name"
            label={`${noun}名称`}
            rules={[{ required: true, whitespace: true }, { max: 100 }]}
          >
            <Input maxLength={100} />
          </Form.Item>
          {editing !== 'new' && (
            <Form.Item name="enabled" label={`启用${noun}`} valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Editor>
      )}
    </Card>
  );
}
function MembersPage({ id }: { id: string }) {
  const list = usePaged<ManagedUser>('/admin/classes/' + id + '/members'),
    location = useLocation();
  const [group, setGroup] = useState<Organization | null>(null),
    [error, setError] = useState(''),
    [adding, setAdding] = useState(false),
    [modal, holder] = Modal.useModal();
  useEffect(() => {
    let active = true;
    void api<Organization>('/admin/organizations/classes/' + id)
      .then((r) => {
        if (active) setGroup(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const backSearch = (location.state as { listSearch?: string } | null)?.listSearch ?? '';
  return (
    <Card
      title={group ? `${group.name} · 学生名单` : '学生名单'}
      extra={<Link to={'/classes' + backSearch}>返回班级列表</Link>}
    >
      {holder}
      {error && <Alert type="error" showIcon title={error} className="identity-alert" />}
      <div className="management-toolbar">
        <Typography.Text type="secondary">
          学生可加入多个班级；移出班级不会删除账号。
        </Typography.Text>
        <Button type="primary" disabled={!group?.enabled} onClick={() => setAdding(true)}>
          添加学生
        </Button>
      </div>
      {group && !group.enabled && (
        <Alert
          type="info"
          title="班级已停用，不能新增学生。已有关系仍可解除。"
          className="identity-alert"
        />
      )}
      <Filters list={list} />
      <DataTable
        list={list}
        columns={[
          { title: '姓名', dataIndex: 'displayName' },
          { title: '用户名', dataIndex: 'username' },
          { title: '状态', render: (_, r) => (r.enabled ? '启用' : '停用') },
          {
            title: '操作',
            render: (_, row) => (
              <Button
                danger
                type="link"
                onClick={() =>
                  modal.confirm({
                    title: `将 ${row.displayName} 移出班级？`,
                    content: '只解除该班级关系，保留学生账号。',
                    okText: '移出班级',
                    cancelText: '取消',
                    onOk: async () => {
                      try {
                        await api('/admin/classes/' + id + '/members/' + row.id, 'DELETE');
                        list.reload();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    },
                  })
                }
              >
                移出班级
              </Button>
            ),
          },
        ]}
      />
      {adding && (
        <Editor
          title="添加学生"
          close={() => setAdding(false)}
          done={() => {
            setAdding(false);
            list.reload();
          }}
          save={(v) => api('/admin/classes/' + id + '/members', 'POST', { studentId: v.studentId })}
        >
          <Form.Item
            name="studentId"
            label="学生"
            rules={[{ required: true, message: '请选择学生' }]}
          >
            <RemotePicker endpoint="/admin/users?role=student" />
          </Form.Item>
        </Editor>
      )}
    </Card>
  );
}
