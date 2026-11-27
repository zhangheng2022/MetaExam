import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from '@metaexam/ui';
import type { ExamReport, ResultRecord } from '@metaexam/contracts';
import { api, apiResponse } from '../api';
import { DataTable, usePaged, dateText } from '../management/common';
const names = { passed: '合格', failed: '不合格', absent: '缺考' };
const types = { single: '单选', multiple: '多选', boolean: '判断', blank: '填空', essay: '简答' };
const number = (v: number | null) => (v === null ? '—' : v);
export function ReportPage() {
  const { examId: id } = useParams(),
    base = '/reports/exams/' + id;
  const list = usePaged<ResultRecord>(base + '/records');
  const passPercent = list.params.get('passPercent') ?? '60';
  const [report, setReport] = useState<ExamReport>(),
    [error, setError] = useState(''),
    [downloadError, setDownloadError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    [downloading, setDownloading] = useState(false),
    [filtersDirty, setFiltersDirty] = useState(false),
    [modal, holder] = Modal.useModal();
  const exportLock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setReport(undefined);
      setError('');
      try {
        const value = await api<ExamReport>(
          base + '?passPercent=' + encodeURIComponent(passPercent),
        );
        if (active) setReport(value);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    });
    return () => {
      active = false;
    };
  }, [base, passPercent, version]);
  const refresh = () => {
    setVersion((v) => v + 1);
    list.reload();
  };
  async function download() {
    if (exportLock.current || !report) return;
    const filters = {
      passPercent: Number(passPercent),
      q: list.params.get('q') ?? '',
      status: list.params.get('status') ?? 'all',
      sort: list.params.get('sort') ?? 'username',
    };
    exportLock.current = true;
    setDownloading(true);
    setDownloadError('');
    setNotice('');
    try {
      if (
        !(await modal.confirm({
          title: '导出成绩 Excel？',
          content: `导出当前筛选匹配的全部 ${list.result?.total ?? 0} 条成绩，不限当前页。统计概览和逐题统计仍按全场计算，合格比例 ${filters.passPercent}%。文件包含考生姓名和得分，请妥善保管。`,
          okText: '确认导出',
          cancelText: '取消',
        }))
      )
        return;
      const response = await apiResponse(base + '/export', 'POST', filters),
        blob = await response.blob();
      if (!alive.current) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `MetaExam-results-${id}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('成绩文件已生成，请在浏览器下载中查看。');
    } catch (e) {
      if (alive.current) setDownloadError((e as Error).message);
    } finally {
      exportLock.current = false;
      if (alive.current) setDownloading(false);
    }
  }
  return (
    <>
      {holder}
      <div className="management-toolbar">
        <Link to={`/exams/${id}/grading`}>返回阅卷与成绩</Link>
        <Space wrap>
          <Button onClick={refresh} disabled={downloading}>
            刷新统计
          </Button>
          <Button
            type="primary"
            loading={downloading}
            disabled={!report || list.busy || !!list.error || filtersDirty}
            onClick={() => void download()}
          >
            导出 Excel
          </Button>
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          className="identity-alert"
          action={<Button onClick={refresh}>重试</Button>}
        />
      )}
      {downloadError && (
        <Alert
          type="error"
          showIcon
          title={downloadError}
          className="identity-alert"
          description="未生成可下载文件，可检查连接后重新导出。"
        />
      )}
      {notice && <Alert type="success" showIcon title={notice} className="identity-alert" />}
      <Card title="统计与名单筛选">
        {filtersDirty && (
          <Alert
            className="identity-alert"
            type="warning"
            showIcon
            title="筛选条件尚未应用，请先应用筛选再导出"
          />
        )}
        <Form
          key={list.params.toString()}
          layout="vertical"
          initialValues={{
            passPercent: Number(passPercent),
            q: list.params.get('q') ?? '',
            status: list.params.get('status') ?? 'all',
            sort: list.params.get('sort') ?? 'username',
          }}
          disabled={downloading}
          onValuesChange={() => setFiltersDirty(true)}
          onFinish={(values) => {
            setNotice('');
            setFiltersDirty(false);
            list.filter(values);
          }}
        >
          <Space wrap align="start">
            <Form.Item
              name="passPercent"
              label="合格比例（满分百分比）"
              rules={[{ required: true, message: '请输入 0～100 的整数' }]}
            >
              <InputNumber
                min={0}
                max={100}
                step={1}
                precision={0}
                suffix="%"
                placeholder="0～100"
              />
            </Form.Item>
            <Form.Item name="q" label="用户名或姓名">
              <Input maxLength={100} allowClear placeholder="请输入用户名或姓名" />
            </Form.Item>
            <Form.Item name="status" label="成绩状态">
              <Select
                placeholder="请选择成绩状态"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'passed', label: '合格' },
                  { value: 'failed', label: '不合格' },
                  { value: 'absent', label: '缺考' },
                ]}
              />
            </Form.Item>
            <Form.Item name="sort" label="名单排序">
              <Select
                placeholder="请选择排序方式"
                options={[
                  { value: 'username', label: '用户名' },
                  { value: 'score_desc', label: '分数从高到低' },
                  { value: 'score_asc', label: '分数从低到高' },
                ]}
              />
            </Form.Item>
          </Space>
          <Button htmlType="submit" disabled={downloading}>
            应用筛选
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" className="question-history">
          合格比例仅用于本次统计，不修改成绩。名单筛选适用于导出，不影响全场统计。
        </Typography.Paragraph>
      </Card>
      {!report ? (
        !error && <Skeleton />
      ) : (
        <>
          <Card
            title={report.name}
            className="question-history"
            extra={<Tag color="success">已发布成绩</Tag>}
          >
            <Typography.Paragraph>
              {report.courseName} · 满分 {report.maxScore} 分 · 合格线 {report.statistics.passScore}{' '}
              分（{report.statistics.passPercent}%）
            </Typography.Paragraph>
            <Typography.Paragraph>
              发布时间（北京）：{dateText(report.publishedAt)} · 名单{' '}
              {report.statistics.rosterCount} 人 · 实考 {report.statistics.presentCount} 人 · 缺考{' '}
              {report.statistics.absentCount} 人
            </Typography.Paragraph>
            <Alert
              className="identity-alert"
              type="info"
              showIcon
              title="缺考不参与分数统计"
              description="实考零分参与统计；无人实考时显示 —。"
            />
            <div className="overview-statistics report-statistics">
              <Statistic title="平均分" value={number(report.statistics.average)} />
              <Statistic title="中位数" value={number(report.statistics.median)} />
              <Statistic title="最高分" value={number(report.statistics.highest)} />
              <Statistic title="最低分" value={number(report.statistics.lowest)} />
              <Statistic title="合格人数" value={report.statistics.passedCount} />
              <Statistic
                title="合格率"
                value={number(report.statistics.passRate)}
                suffix={report.statistics.passRate === null ? '' : '%'}
              />
            </div>
          </Card>
          <Card title="全场得分分布" className="question-history">
            <Table
              rowKey="label"
              pagination={false}
              dataSource={report.statistics.distribution}
              columns={[
                { title: '得分率区间', dataIndex: 'label' },
                { title: '人数', dataIndex: 'count' },
                {
                  title: '占实考人数比例',
                  render: (_, r) => (
                    <Progress
                      percent={
                        report.statistics.presentCount
                          ? Math.round((r.count * 10000) / report.statistics.presentCount) / 100
                          : 0
                      }
                      status="normal"
                    />
                  ),
                },
              ]}
              scroll={{ x: 560 }}
            />
          </Card>
          <Card title="成绩名单" className="question-history">
            <DataTable
              list={{ ...list, result: list.error ? null : list.result }}
              columns={[
                { title: '用户名', dataIndex: 'username' },
                { title: '姓名', dataIndex: 'displayName' },
                { title: '状态', render: (_, r) => <Tag>{names[r.status]}</Tag> },
                { title: '总分', render: (_, r) => number(r.score) },
                {
                  title: '交卷时间（北京）',
                  render: (_, r) => (r.submittedAt ? dateText(r.submittedAt) : '—'),
                },
              ]}
            />
          </Card>
          <Card title="全场逐题统计" className="question-history">
            <Table
              rowKey="position"
              dataSource={report.questions}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              columns={[
                { title: '题号', dataIndex: 'position' },
                { title: '题型', render: (_, r) => types[r.type] },
                { title: '满分', dataIndex: 'maxScore' },
                { title: '评分人数', dataIndex: 'gradedCount' },
                { title: '均分', render: (_, r) => number(r.average) },
                {
                  title: '得分率',
                  render: (_, r) => (r.scoreRate === null ? '—' : r.scoreRate + '%'),
                },
                { title: '满分人数', dataIndex: 'fullCount' },
                { title: '零分人数', dataIndex: 'zeroCount' },
              ]}
              scroll={{ x: 800 }}
            />
          </Card>
        </>
      )}
    </>
  );
}
