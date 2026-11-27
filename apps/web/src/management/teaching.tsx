import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Typography,
} from '@metaexam/ui';
import type { Assignment, AuditEvent, CurrentUser, MyTeaching } from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, dateText, Editor, Filters, RemotePicker, usePaged } from './common';
const teachingColumns = [
  { title: '课程', dataIndex: 'courseName' },
  { title: '班级', dataIndex: 'className' },
  { title: '教师', dataIndex: 'teacherName' },
  {
    title: '状态',
    render: (_: unknown, r: Assignment) =>
      r.teacherEnabled && r.courseEnabled && r.classEnabled ? '有效' : '关联对象已停用',
  },
];
const dateInput = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16)
    : '';
export function AssignmentsPage() {
  const list = usePaged<Assignment>('/admin/assignments');
  const [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [modal, holder] = Modal.useModal();
  return (
    <Card>
      {holder}
      <div className="management-toolbar">
        <span>维护教师、课程与班级之间的授课关系</span>
        <Button type="primary" onClick={() => setAdding(true)}>
          添加授课安排
        </Button>
      </div>
      {(list.params.get('classId') || list.params.get('courseId')) && (
        <Alert
          type="info"
          title="当前按所选班级或课程查看；点击重置可查看全部安排。"
          className="identity-alert"
        />
      )}
      {error && <Alert type="error" showIcon title={error} className="identity-alert" />}
      <Filters list={list} status={false} />
      <DataTable
        list={list}
        rowKey={(r) => `${r.teacherId}/${r.courseId}/${r.classId}`}
        columns={[
          ...teachingColumns,
          {
            title: '操作',
            render: (_, r) => (
              <Button
                danger
                type="link"
                onClick={() =>
                  modal.confirm({
                    title: '解除授课关系？',
                    content: `${r.teacherName} / ${r.courseName} / ${r.className}`,
                    okText: '解除关系',
                    cancelText: '取消',
                    onOk: async () => {
                      try {
                        await api('/admin/assignments', 'DELETE', {
                          teacherId: r.teacherId,
                          courseId: r.courseId,
                          classId: r.classId,
                        });
                        list.reload();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    },
                  })
                }
              >
                解除关系
              </Button>
            ),
          },
        ]}
      />
      {adding && (
        <Editor
          title="添加授课安排"
          close={() => setAdding(false)}
          done={() => {
            setAdding(false);
            list.reload();
          }}
          save={(v) => api('/admin/assignments', 'POST', v)}
        >
          <Form.Item name="courseId" label="课程" rules={[{ required: true }]}>
            <RemotePicker placeholder="搜索并选择课程" endpoint="/admin/organizations/courses" />
          </Form.Item>
          <Form.Item name="classId" label="班级" rules={[{ required: true }]}>
            <RemotePicker placeholder="搜索并选择班级" endpoint="/admin/organizations/classes" />
          </Form.Item>
          <Form.Item name="teacherId" label="教师" rules={[{ required: true }]}>
            <RemotePicker placeholder="搜索并选择教师" endpoint="/admin/users?role=teacher" />
          </Form.Item>
        </Editor>
      )}
    </Card>
  );
}
export function AuditPage() {
  const list = usePaged<AuditEvent>('/admin/audit-events');
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  return (
    <Card>
      <Filters list={list} status={false}>
        {(['from', 'to'] as const).map((name) => (
          <Form.Item
            key={name}
            name={name}
            label={name === 'from' ? '开始时间（北京）' : '结束时间（北京）'}
            getValueProps={(value?: string) => ({
              value: dateInput(value),
            })}
            getValueFromEvent={(event: React.ChangeEvent<HTMLInputElement>) =>
              event.target.value ? new Date(event.target.value + '+08:00').toISOString() : undefined
            }
          >
            <Input type="datetime-local" />
          </Form.Item>
        ))}
        <Form.Item name="outcome" label="结果">
          <Select
            placeholder="全部结果"
            allowClear
            className="filter-select"
            options={[
              { value: 'success', label: '成功' },
              { value: 'failure', label: '失败' },
              { value: 'issued', label: '已签发' },
            ]}
          />
        </Form.Item>
      </Filters>
      <DataTable
        list={list}
        columns={[
          { title: '时间（北京时间）', dataIndex: 'createdAt', width: 192, render: dateText },
          {
            title: '操作人',
            dataIndex: 'actorName',
            render: (v: string | null) => v ?? '系统/未登录',
          },
          { title: '事件', dataIndex: 'event' },
          {
            title: '结果',
            dataIndex: 'outcome',
            render: (v: string) => ({ success: '成功', failure: '失败', issued: '已签发' })[v] ?? v,
          },
          { title: '目标类型', dataIndex: 'targetType' },
          {
            title: '操作',
            render: (_, r) => (
              <Button type="link" onClick={() => setDetail(r)}>
                详情
              </Button>
            ),
          },
        ]}
      />
      <Modal
        title="操作详情"
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detail && (
          <>
            <Typography.Paragraph>请求编号：{detail.requestId}</Typography.Paragraph>
            <Typography.Paragraph>目标：{detail.targetId ?? '未记录'}</Typography.Paragraph>
            <Input.TextArea
              readOnly
              rows={10}
              aria-label="脱敏变更详情"
              value={JSON.stringify(detail.details, null, 2)}
            />
          </>
        )}
      </Modal>
    </Card>
  );
}
export function WorkspacePage({ user }: { user: CurrentUser }) {
  const [data, setData] = useState<MyTeaching | null>(null),
    [counts, setCounts] = useState<{ users: number; classes: number; courses: number } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0);
  const admin = user.roles.includes('admin');
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<MyTeaching>('/teaching/me'),
      admin
        ? api<{ users: number; classes: number; courses: number }>('/admin/overview')
        : Promise.resolve(null),
    ])
      .then(([mine, stats]) => {
        if (active) {
          setData(mine);
          setCounts(stats);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [admin, version]);
  return (
    <>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          description="未能读取最新信息，请重试。"
          action={<Button onClick={() => setVersion((v) => v + 1)}>重试</Button>}
          className="identity-alert"
        />
      )}
      {admin && (
        <Card title="系统概览" loading={!counts && !error} className="identity-alert">
          {counts && (
            <div className="overview-statistics">
              <Statistic title="账号数" value={counts.users} />
              <Statistic title="班级数" value={counts.classes} />
              <Statistic title="课程数" value={counts.courses} />
            </div>
          )}
          <div className="identity-actions">
            <Space wrap>
              <Link to="/users">管理账号</Link>
              <Link to="/classes">管理班级</Link>
              <Link to="/courses">管理课程</Link>
              <Link to="/assignments">授课安排</Link>
            </Space>
          </div>
        </Card>
      )}
      {user.roles.includes('student') && (
        <Card title="我的班级" loading={!data && !error} className="identity-alert">
          <Table
            rowKey="id"
            dataSource={data?.classes ?? []}
            pagination={false}
            columns={[
              { title: '班级编码', dataIndex: 'code' },
              { title: '班级名称', dataIndex: 'name' },
              { title: '状态', render: (_, r) => (r.enabled ? '启用' : '停用') },
            ]}
            locale={{ emptyText: <Empty description="尚未加入班级，请联系管理员安排。" /> }}
          />
        </Card>
      )}
      {(user.roles.includes('teacher') || user.roles.includes('student')) && (
        <Card
          title={user.roles.includes('teacher') ? '我的授课与课程' : '我的课程'}
          loading={!data && !error}
        >
          <Table
            rowKey={(r) => `${r.teacherId}/${r.courseId}/${r.classId}`}
            dataSource={data?.assignments ?? []}
            columns={teachingColumns}
            scroll={{ x: 600 }}
            pagination={{ pageSize: 20 }}
            locale={{ emptyText: <Empty description="暂无课程安排，请联系管理员。" /> }}
          />
        </Card>
      )}
    </>
  );
}
