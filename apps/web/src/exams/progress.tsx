import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Typography } from '@metaexam/ui';
import type { ExamProgress } from '@metaexam/contracts';
import { api } from '../api';
import { dateText } from '../management/common';

const names = { waiting: '未入场', active: '作答中', submitted: '已交卷' };
export function ExamProgressPanel({ id }: { id: string }) {
  const [data, setData] = useState<ExamProgress>(),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all');
  useEffect(() => {
    let active = true;
    void api<ExamProgress>('/exams/' + id + '/progress')
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
          setData(undefined);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, version]);
  const rows =
    data?.rows.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        (r.username + ' ' + r.displayName).toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  return (
    <Card
      title="考中状态"
      className="question-history"
      extra={
        <Button
          loading={loading}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setVersion((v) => v + 1);
          }}
        >
          刷新状态
        </Button>
      }
    >
      {error && (
        <Alert role="alert" type="error" showIcon title={error} className="identity-alert" />
      )}
      {data && (
        <Typography.Paragraph>
          未入场 {data.counts.waiting} 人 · 未交卷 {data.counts.active} 人 · 已交卷{' '}
          {data.counts.submitted} 人。最近成功读取：{dateText(data.checkedAt)}。筛选不改变全场人数。
        </Typography.Paragraph>
      )}
      <Space wrap className="identity-alert">
        <Input
          aria-label="搜索考生"
          placeholder="搜索姓名或用户名"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Select
          aria-label="作答状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            ...Object.entries(names).map(([value, label]) => ({
              value,
              label: value === 'active' ? '未交卷' : label,
            })),
          ]}
        />
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1050 }}
        columns={[
          { title: '姓名', dataIndex: 'displayName' },
          { title: '用户名', dataIndex: 'username' },
          {
            title: '状态',
            render: (_, r) =>
              r.status === 'active' && r.deadlineAt && data && r.deadlineAt <= data.checkedAt
                ? '到期待收卷'
                : names[r.status],
          },
          { title: '入场时间', render: (_, r) => (r.startedAt ? dateText(r.startedAt) : '—') },
          { title: '最近成功保存', render: (_, r) => (r.savedAt ? dateText(r.savedAt) : '—') },
          { title: '交卷时间', render: (_, r) => (r.submittedAt ? dateText(r.submittedAt) : '—') },
          {
            title: '交卷方式',
            render: (_, r) =>
              r.submitReason === 'manual'
                ? '主动交卷'
                : r.submitReason === 'timeout'
                  ? '到期收卷'
                  : '—',
          },
        ]}
      />
      <Typography.Text type="secondary">
        最近成功保存不代表在线状态。到期未完成后台收卷时显示“到期待收卷”。
      </Typography.Text>
    </Card>
  );
}
