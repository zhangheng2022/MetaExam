import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
  Pagination,
} from '@metaexam/ui';
import {
  examInputSchema,
  type ExamSummary,
  type ExamDetail,
  type ExamPerson,
  type StudentExam,
  type PageResult,
} from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, Editor, RemotePicker, dateText, usePaged } from '../management/common';
const phaseNames = {
  draft: '草稿',
  scheduled: '待开考',
  in_progress: '考试时间内',
  ended: '已结束',
  cancelled: '已取消',
};
const phaseTag = (phase: StudentExam['phase']) => (
  <Tag
    color={phase === 'cancelled' ? 'default' : phase === 'in_progress' ? 'success' : 'processing'}
  >
    {phaseNames[phase]}
  </Tag>
);
const timeColumns = [
  { title: '开始时间（北京）', dataIndex: 'startsAt', render: dateText },
  { title: '结束时间（北京）', dataIndex: 'endsAt', render: dateText },
  { title: '答题时长', render: (_: unknown, r: StudentExam) => `${r.durationMinutes} 分钟` },
  { title: '状态', render: (_: unknown, r: StudentExam) => phaseTag(r.phase) },
];
export function MyExamsPage() {
  const list = usePaged<StudentExam>('/my-exams');
  const navigate = useNavigate(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState<string>(),
    [modal, holder] = Modal.useModal();
  async function enter(exam: StudentExam) {
    if (exam.attemptId) {
      navigate('/attempts/' + exam.attemptId);
      return;
    }
    if (
      !(await modal.confirm({
        title: '确认进入考试？',
        content: '入场后开始计时，关闭页面仍计时。请确认网络稳定，交卷后不能重新作答。',
        okText: '进入考试',
        cancelText: '稍后进入',
      }))
    )
      return;
    setBusy(exam.id);
    setError('');
    try {
      const result = await api<{ id: string }>('/my-exams/' + exam.id + '/start', 'POST');
      navigate('/attempts/' + result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <Card title="我的考试安排" extra={<Button onClick={list.reload}>刷新</Button>}>
      {holder}
      {error && <Alert type="error" title={error} className="identity-alert" />}
      <Alert
        type="info"
        showIcon
        title="请确认考试时间"
        description="开考后可入场，关闭页面仍继续计时，到期自动提交已保存答案。"
        className="identity-alert"
      />
      <DataTable
        list={list}
        columns={[
          { title: '考试', dataIndex: 'name' },
          {
            title: '操作',
            render: (_, r) =>
              r.attemptId || r.phase === 'in_progress' ? (
                <Button
                  type="primary"
                  loading={busy === r.id}
                  disabled={!!busy}
                  onClick={() => void enter(r)}
                >
                  {r.attemptStatus === 'submitted'
                    ? '交卷回执'
                    : r.attemptId
                      ? '继续作答'
                      : '进入考试'}
                </Button>
              ) : (
                <Typography.Text type="secondary">
                  {r.phase === 'scheduled'
                    ? '等待开考'
                    : r.phase === 'cancelled'
                      ? '已取消'
                      : '未参加'}
                </Typography.Text>
              ),
          },
          { title: '课程', dataIndex: 'courseName' },
          {
            title: '成绩',
            render: (_, r) =>
              r.phase !== 'cancelled' ? <Link to={`/my-exams/${r.id}/result`}>查看成绩</Link> : '—',
          },
          ...timeColumns,
          { title: '题数 / 总分', render: (_, r) => `${r.itemCount} 题 / ${r.totalScore} 分` },
          { title: '取消原因', render: (_, r) => r.cancellationReason || '—' },
        ]}
      />
    </Card>
  );
}
export function ExamsPage() {
  const { examId } = useParams();
  return examId ? <Detail key={examId} id={examId} /> : <List />;
}
function List() {
  const list = usePaged<ExamSummary>('/exams'),
    [create, setCreate] = useState(false),
    navigate = useNavigate();
  return (
    <Card
      title="考试安排"
      extra={
        <Button type="primary" onClick={() => setCreate(true)}>
          创建考试
        </Button>
      }
    >
      <Form
        layout="inline"
        className="management-filters"
        initialValues={Object.fromEntries(list.params)}
        key={list.params.toString()}
        onFinish={list.filter}
      >
        <Form.Item name="q" label="搜索">
          <Input maxLength={100} placeholder="考试名称" />
        </Form.Item>
        <Form.Item name="status" label="状态">
          <Select
            className="filter-select"
            allowClear
            placeholder="全部"
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'published', label: '已发布' },
              { value: 'cancelled', label: '已取消' },
            ]}
          />
        </Form.Item>
        <Button htmlType="submit">查询</Button>
        <Button onClick={() => list.filter({})}>重置</Button>
        <Button onClick={list.reload}>刷新</Button>
      </Form>
      <DataTable
        list={list}
        columns={[
          { title: '考试名称', render: (_, r) => <Link to={'/exams/' + r.id}>{r.name}</Link> },
          { title: '课程', dataIndex: 'courseName' },
          ...timeColumns,
          { title: '考生', dataIndex: 'rosterCount' },
          { title: '创建人', dataIndex: 'ownerName' },
        ]}
      />
      {create && (
        <ExamEditor close={() => setCreate(false)} done={(id) => navigate('/exams/' + id)} />
      )}
    </Card>
  );
}
type Choice = { id: string; name: string; code?: string };
function ClassPicker({
  courseId,
  value,
  onChange,
  id,
}: {
  courseId: string;
  value: Choice[];
  onChange: (v: Choice[]) => void;
  id?: string;
}) {
  const [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [data, setData] = useState<PageResult<Choice>>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const r = await api<PageResult<Choice>>(
          '/exams/choices/classes?' +
            new URLSearchParams({ courseId, q, page: String(page), pageSize: '20' }),
        );
        if (active) setData(r);
      } catch (e) {
        if (active) {
          setData(undefined);
          setError((e as Error).message);
        }
      } finally {
        if (active) setBusy(false);
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [courseId, q, page, retry]);
  const choices = [...new Map([...value, ...(data?.items ?? [])].map((v) => [v.id, v])).values()];
  return (
    <>
      <Select
        id={id}
        mode="multiple"
        value={value.map((v) => v.id)}
        loading={busy}
        showSearch={{
          filterOption: false,
          onSearch: (text) => {
            setQ(text);
            setPage(1);
          },
        }}
        options={choices.map((v) => ({
          value: v.id,
          label: v.name + (v.code ? `（${v.code}）` : ''),
        }))}
        onChange={(ids) => onChange(choices.filter((v) => ids.includes(v.id)))}
        placeholder="选择参加考试的班级"
      />
      <Pagination
        size="small"
        current={page}
        pageSize={20}
        total={data?.total ?? 0}
        showSizeChanger={false}
        onChange={setPage}
      />
      {error && (
        <Alert
          type="error"
          title={error}
          action={<Button onClick={() => setRetry((v) => v + 1)}>重试</Button>}
        />
      )}
    </>
  );
}
const dateInput = (v?: string) =>
  v ? new Date(Date.parse(v) + 8 * 3600000).toISOString().slice(0, 16) : '';
function ExamEditor({
  exam,
  close,
  done,
}: {
  exam?: ExamDetail;
  close: () => void;
  done: (id: string) => void;
}) {
  const [course, setCourse] = useState(exam?.courseId ?? ''),
    [classes, setClasses] = useState<Choice[]>(exam?.classes ?? []),
    [paper, setPaper] = useState(exam?.paperVersionId);
  const savedId = useRef(exam?.id);
  const parseTime = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
      throw new Error('请填写有效的北京时间（精确到分钟）');
    const time = new Date(value + ':00+08:00');
    if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的北京时间');
    return time.toISOString();
  };
  return (
    <Editor
      title={exam ? '编辑考试与刷新名单' : '创建考试'}
      size={680}
      externalDirty={
        course !== (exam?.courseId ?? '') ||
        paper !== exam?.paperVersionId ||
        JSON.stringify(classes.map((v) => v.id).sort()) !==
          JSON.stringify((exam?.classes ?? []).map((v) => v.id).sort())
      }
      close={close}
      done={() => (savedId.current ? done(savedId.current) : close())}
      initialValues={{
        name: exam?.name ?? '',
        startsAt: dateInput(exam?.startsAt),
        endsAt: dateInput(exam?.endsAt),
        durationMinutes: exam?.durationMinutes ?? 60,
      }}
      save={async (values) => {
        const input = examInputSchema.safeParse({
          ...values,
          paperVersionId: paper,
          classIds: classes.map((v) => v.id),
          startsAt: parseTime(values.startsAt),
          endsAt: parseTime(values.endsAt),
        });
        if (!input.success)
          throw new Error('请检查名称、冻结试卷、北京时间、时长和所选班级（最多 50 个）。');
        const result = await api<{ id: string }>(
          exam ? '/exams/' + exam.id : '/exams',
          exam ? 'PATCH' : 'POST',
          exam ? { ...input.data, revision: exam.revision } : input.data,
        );
        savedId.current = result.id;
      }}
    >
      <Alert
        type="info"
        showIcon
        title="保存时重新生成考生名单"
        description="纳入所选班级当前启用的学生，跨班自动去重。发布前请查看名单；发布后试卷、时间和名单不能修改。"
        className="identity-alert"
      />
      <Form.Item
        name="name"
        label="考试名称"
        rules={[{ required: true, whitespace: true, max: 100 }]}
      >
        <Input maxLength={100} placeholder="请输入考试名称" />
      </Form.Item>
      <Form.Item label="所属课程" htmlFor="exam-course" required>
        {exam ? (
          <Input id="exam-course" readOnly value={exam.courseName} />
        ) : (
          <RemotePicker
            id="exam-course"
            placeholder="搜索并选择课程"
            endpoint="/question-banks/courses"
            enabledOnly={false}
            value={course || undefined}
            onChange={(v) => {
              setCourse(v);
              setClasses([]);
              setPaper(undefined);
            }}
          />
        )}
      </Form.Item>
      {course && (
        <>
          <Form.Item label="冻结试卷" htmlFor="exam-paper" required>
            <RemotePicker
              key={course}
              id="exam-paper"
              placeholder="搜索并选择冻结试卷"
              endpoint={'/exams/choices/papers?courseId=' + course}
              enabledOnly={false}
              value={paper}
              initialOption={
                exam ? { value: exam.paperVersionId, label: exam.paperName } : undefined
              }
              onChange={setPaper}
            />
          </Form.Item>
          <Form.Item label="参加班级" htmlFor="exam-classes" required>
            <ClassPicker
              key={course}
              id="exam-classes"
              courseId={course}
              value={classes}
              onChange={setClasses}
            />
          </Form.Item>
        </>
      )}
      <Form.Item name="startsAt" label="开始时间（北京）" rules={[{ required: true }]}>
        <Input type="datetime-local" step={60} />
      </Form.Item>
      <Form.Item name="endsAt" label="结束时间（北京）" rules={[{ required: true }]}>
        <Input type="datetime-local" step={60} />
      </Form.Item>
      <Form.Item name="durationMinutes" label="答题时长（分钟）" rules={[{ required: true }]}>
        <InputNumber min={1} max={480} precision={0} placeholder="1～480 分钟" />
      </Form.Item>
      <Typography.Paragraph type="secondary">
        考试窗口须覆盖答题时长，最长 7
        天。时间按北京时间填写；到结束时间统一截止，晚入场可能不足完整时长。
      </Typography.Paragraph>
    </Editor>
  );
}
function Detail({ id }: { id: string }) {
  const [exam, setExam] = useState<ExamDetail>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0),
    [panel, setPanel] = useState<'edit' | 'cancel'>(),
    [busy, setBusy] = useState(false),
    [modal, holder] = Modal.useModal();
  const roster = usePaged<ExamPerson>('/exams/' + id + '/roster');
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError('');
      try {
        const r = await api<ExamDetail>('/exams/' + id);
        if (active) setExam(r);
      } catch (e) {
        if (active) {
          setExam(undefined);
          setError((e as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [id, version]);
  const reload = () => {
    setVersion((v) => v + 1);
    roster.reload();
  };
  async function publish() {
    if (!exam) return;
    const confirmed = await modal.confirm({
      title: '确认发布考试？',
      content: `将固定“${exam.paperName}”及 ${exam.rosterCount} 名考生。发布后不能修改；仅开考前可取消。发布将本地校验授权，实际入场仍需再次校验。`,
      okText: '确认发布',
      cancelText: '返回检查',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await api('/exams/' + id + '/publish', 'POST', { revision: exam.revision });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {holder}
      <div className="management-toolbar">
        <Link to="/exams">返回考试列表</Link>
        <Button disabled={busy} onClick={reload}>
          刷新
        </Button>
      </div>
      {error && (
        <Alert
          className="identity-alert"
          type="error"
          showIcon
          title={error}
          action={<Button onClick={reload}>重试</Button>}
        />
      )}
      {loading ? (
        <Skeleton paragraph={{ rows: 6 }} />
      ) : (
        exam && (
          <>
            <Card
              title={
                <Space wrap>
                  {exam.name}
                  {phaseTag(exam.phase)}
                </Space>
              }
            >
              <Typography.Paragraph>
                课程：{exam.courseName} · 试卷：{exam.paperName} · {exam.itemCount} 题 /{' '}
                {exam.totalScore} 分
              </Typography.Paragraph>
              {exam.status === 'published' && (
                <Typography.Paragraph>
                  <Link to={`/exams/${exam.id}/grading`}>阅卷与成绩</Link>
                </Typography.Paragraph>
              )}
              <Typography.Paragraph>
                北京时间：{dateText(exam.startsAt)} 至 {dateText(exam.endsAt)} · 答题时长{' '}
                {exam.durationMinutes} 分钟
              </Typography.Paragraph>
              <Typography.Paragraph>
                参加班级：{exam.classes.map((c) => c.name).join('、')} · 名单 {exam.rosterCount} 人
              </Typography.Paragraph>
              {exam.status === 'draft' ? (
                <>
                  <Alert
                    className="identity-alert"
                    type="info"
                    title="发布前请核对试卷、时间和名单"
                    description="发布需要有效考试授权；名单人数可以超过同时作答人数上限。"
                  />
                  <Space wrap>
                    <Button onClick={() => setPanel('edit')} disabled={busy}>
                      编辑与刷新名单
                    </Button>
                    <Button
                      type="primary"
                      loading={busy}
                      disabled={!exam.rosterCount}
                      onClick={() => void publish()}
                    >
                      发布考试
                    </Button>
                  </Space>
                </>
              ) : (
                <Alert
                  type={exam.status === 'cancelled' ? 'warning' : 'success'}
                  showIcon
                  title={
                    exam.status === 'cancelled' ? '考试已取消' : '考试已发布，配置与名单已固定'
                  }
                  description={
                    exam.status === 'cancelled'
                      ? exam.cancellationReason
                      : `发布时授权同时答题上限 ${exam.publicationCapacity} 人；${exam.licenseExpiresAt ? '授权到期：' + dateText(exam.licenseExpiresAt) : '授权无固定到期时间'}。入场时以当前授权为准。`
                  }
                  action={
                    exam.phase === 'scheduled' ? (
                      <Button danger onClick={() => setPanel('cancel')}>
                        取消考试
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </Card>
            <Card title="考生名单" className="question-history">
              <Form
                key={roster.params.toString()}
                initialValues={Object.fromEntries(roster.params)}
                layout="inline"
                className="management-filters"
                onFinish={roster.filter}
              >
                <Form.Item name="q" label="考生搜索">
                  <Input maxLength={100} placeholder="用户名或姓名" />
                </Form.Item>
                <Button htmlType="submit">查询</Button>
                <Button onClick={() => roster.filter({})}>重置</Button>
              </Form>
              <DataTable
                list={roster}
                columns={[
                  { title: '用户名', dataIndex: 'username' },
                  { title: '姓名（名单快照）', dataIndex: 'displayName' },
                ]}
              />
            </Card>
            {panel === 'edit' && (
              <ExamEditor
                exam={exam}
                close={() => setPanel(undefined)}
                done={() => {
                  setPanel(undefined);
                  reload();
                }}
              />
            )}
            {panel === 'cancel' && (
              <Editor
                title="取消考试"
                submitText="确认取消"
                close={() => setPanel(undefined)}
                done={() => {
                  setPanel(undefined);
                  reload();
                }}
                save={async (values) => {
                  await api('/exams/' + id + '/cancel', 'POST', {
                    ...values,
                    revision: exam.revision,
                  });
                }}
              >
                <Alert
                  className="identity-alert"
                  type="warning"
                  title="取消后不能恢复"
                  description="仅限未开考的考试。取消原因将告知考生。"
                />
                <Form.Item
                  name="reason"
                  label="取消原因"
                  rules={[{ required: true, whitespace: true, max: 500 }]}
                >
                  <Input.TextArea rows={3} maxLength={500} placeholder="请输入取消原因，考生可见" />
                </Form.Item>
              </Editor>
            )}
          </>
        )
      )}
    </>
  );
}
