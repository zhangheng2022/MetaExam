import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Skeleton,
  Space,
  Tag,
  Typography,
} from '@metaexam/ui';
import type {
  GradingOverview,
  GradingCandidate,
  MarkingDetail,
  MarkingQuestion,
  StudentResult,
} from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, usePaged, dateText } from '../management/common';
import { QuestionPreview } from '../questions/editor';
function useRead<T>(endpoint: string) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setValue(undefined);
      setError('');
      try {
        const next = await api<T>(endpoint);
        if (active) setValue(next);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    });
    return () => {
      active = false;
    };
  }, [endpoint, version]);
  return { value, error, reload };
}
export function GradingPage() {
  const { examId: id } = useParams(),
    base = '/grading/exams/' + id;
  const info = useRead<GradingOverview>(base),
    list = usePaged<GradingCandidate>(base + '/candidates');
  const [selected, setSelected] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [modal, holder] = Modal.useModal();
  const refresh = () => {
    info.reload();
    list.reload();
  };
  async function publish() {
    if (!info.value) return;
    const revision = info.value.revision;
    if (
      !(await modal.confirm({
        title: '确认发布成绩？',
        content: '发布后学生可查看本人得分和评语，所有评分锁定，不能撤回或修改。未入场者标记缺考。',
        okText: '确认发布',
        cancelText: '继续核对',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api(base + '/publish', 'POST', { revision });
      refresh();
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
        <Link to={'/exams/' + id}>返回考试详情</Link>
        {info.value?.publishedAt && <Link to={`/exams/${id}/report`}>成绩统计与导出</Link>}
        <Button onClick={refresh} disabled={busy}>
          刷新阅卷状态
        </Button>
      </div>
      {(info.error || error) && (
        <Alert
          className="identity-alert"
          type="error"
          showIcon
          title={info.error || error}
          action={
            <Button
              onClick={() => {
                setError('');
                refresh();
              }}
            >
              重试
            </Button>
          }
        />
      )}
      {!info.value ? (
        !info.error && <Skeleton />
      ) : (
        <Card
          title={info.value.name}
          extra={
            <Tag color={info.value.publishedAt ? 'success' : 'processing'}>
              {info.value.publishedAt ? '成绩已发布' : '成绩未发布'}
            </Tag>
          }
        >
          <Typography.Paragraph>
            满分 {info.value.totalScore} 分 · 考试结束（北京）：{dateText(info.value.endsAt)}
          </Typography.Paragraph>
          <Typography.Paragraph>
            名单 {info.value.rosterCount} 人 · 已交卷 {info.value.submittedCount} 人 · 作答中{' '}
            {info.value.activeCount} 人 · 待评分 {info.value.pendingCount} 人 · 已评完{' '}
            {info.value.readyCount} 人 · 未入场 {info.value.absentCount} 人
          </Typography.Paragraph>
          <Alert
            className="identity-alert"
            showIcon
            type="info"
            title="客观题全对得分，简答题人工评分"
            description="多选、填空不设部分分；简答按 0.5 分计分。考试结束且全部交卷评完后可发布。"
          />
          {info.value.publishedAt ? (
            <Typography.Paragraph>
              发布时间（北京）：{dateText(info.value.publishedAt)} · 评分已锁定
            </Typography.Paragraph>
          ) : (
            <Button
              type="primary"
              disabled={!info.value.canPublish}
              loading={busy}
              onClick={() => void publish()}
            >
              发布成绩
            </Button>
          )}
        </Card>
      )}
      <Card title="考生与评分" className="question-history">
        <Form layout="inline" onFinish={list.filter} className="management-filters">
          <Form.Item name="q" label="考生">
            <Input placeholder="用户名或姓名" maxLength={100} />
          </Form.Item>
          <Button htmlType="submit">搜索</Button>
        </Form>
        <DataTable
          list={list}
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '姓名', dataIndex: 'displayName' },
            {
              title: '状态',
              render: (_, r) => (
                <Tag>
                  {
                    { absent: '未入场', active: '作答中', pending: '待评分', ready: '已评完' }[
                      r.state
                    ]
                  }
                </Tag>
              ),
            },
            { title: '总分', render: (_, r) => r.score ?? '—' },
            {
              title: '操作',
              render: (_, r) =>
                r.attemptId && r.state !== 'active' ? (
                  <Button onClick={() => setSelected(r.attemptId!)}>查看答卷</Button>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Card>
      {selected && (
        <Marking
          key={selected}
          base={base}
          attempt={selected}
          close={() => setSelected(undefined)}
          changed={refresh}
        />
      )}
    </>
  );
}
function answerText(item: MarkingQuestion) {
  const a = item.answer,
    c = item.question.content;
  if (!a) return '未作答';
  if (a.type === 'boolean') return a.value === null ? '未作答' : a.value ? '正确' : '错误';
  if (a.type === 'essay') return a.text || '未作答';
  if (a.type === 'blank' && c.type === 'blank')
    return c.blanks
      .map((b, i) => `第 ${i + 1} 空：${a.values.find((v) => v.id === b.id)?.value || '未填写'}`)
      .join('\n');
  if (
    (a.type === 'single' || a.type === 'multiple') &&
    (c.type === 'single' || c.type === 'multiple')
  ) {
    const ids = a.type === 'single' ? [a.optionId] : a.optionIds;
    return (
      c.options
        .flatMap((o, i) =>
          ids.includes(o.id) ? [`${String.fromCharCode(65 + i)}. ${o.text}`] : [],
        )
        .join('\n') || '未作答'
    );
  }
  return '未作答';
}
function Marking({
  base,
  attempt,
  close,
  changed,
}: {
  base: string;
  attempt: string;
  close: () => void;
  changed: () => void;
}) {
  const [position, setPosition] = useState(1),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [modal, holder] = Modal.useModal();
  const url = `${base}/attempts/${attempt}/questions/${position}`,
    data = useRead<MarkingDetail>(url);
  const item = data.value?.items[0];
  async function discard(action: () => void) {
    if (busy) return;
    if (
      dirty &&
      !(await modal.confirm({
        title: '放弃尚未保存的评分？',
        okText: '放弃修改',
        cancelText: '继续编辑',
      }))
    )
      return;
    setDirty(false);
    setError('');
    action();
  }
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    addEventListener('beforeunload', handler);
    return () => removeEventListener('beforeunload', handler);
  }, [dirty]);
  return (
    <Drawer
      open
      size={880}
      title={
        data.value
          ? `${data.value.displayName}（${data.value.username}）· 第 ${position} 题`
          : '读取答卷'
      }
      onClose={() => void discard(close)}
      closable={busy ? false : { 'aria-label': '关闭阅卷' }}
      maskClosable={!busy}
      destroyOnHidden
    >
      {holder}
      {(data.error || error) && (
        <Alert
          type="error"
          showIcon
          title={data.error || error}
          className="identity-alert"
          action={<Button onClick={() => void discard(data.reload)}>重新读取</Button>}
        />
      )}
      {!item ? (
        !data.error && <Skeleton />
      ) : (
        <>
          <Space wrap className="paper-actions">
            <Button
              disabled={busy || position === 1}
              onClick={() => void discard(() => setPosition((v) => v - 1))}
            >
              上一题
            </Button>
            <Typography.Text>
              {position} / {data.value!.itemCount}
            </Typography.Text>
            <Button
              disabled={busy || position === data.value!.itemCount}
              onClick={() => void discard(() => setPosition((v) => v + 1))}
            >
              下一题
            </Button>
            <Button disabled={busy} onClick={() => void discard(data.reload)}>
              刷新本题
            </Button>
          </Space>
          <QuestionPreview question={item.question} />
          {item.question.images?.map((i) => (
            <MarkImage
              key={i.id}
              src={`/api/v1${base}/attempts/${attempt}/images/${i.id}`}
              alt={i.alt}
            />
          ))}
          <Card title="考生答案" size="small" className="question-history">
            <Typography.Paragraph className="question-text">
              {answerText(item)}
            </Typography.Paragraph>
          </Card>
          <Typography.Paragraph className="question-history">
            满分 {item.maxScore} 分 · {item.mode === 'auto' ? '自动判分' : '人工评分'} · 当前得分{' '}
            {item.score ?? '待评'}
          </Typography.Paragraph>
          {item.mode === 'manual' && !data.value!.publishedAt ? (
            <Form
              key={`${position}:${item.revision}`}
              layout="vertical"
              initialValues={{ score: item.score, comment: item.comment }}
              onValuesChange={() => setDirty(true)}
              disabled={busy}
              onFinish={async (values) => {
                setBusy(true);
                setError('');
                try {
                  await api(url, 'PUT', { ...values, revision: item.revision });
                  setDirty(false);
                  data.reload();
                  changed();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item
                name="score"
                label="本题得分"
                rules={[{ required: true, message: '请填写得分' }]}
              >
                <InputNumber
                  min={0}
                  max={item.maxScore}
                  step={0.5}
                  placeholder={`0～${item.maxScore} 分`}
                />
              </Form.Item>
              <Form.Item name="comment" label="评语（发布后学生可见）">
                <Input.TextArea
                  maxLength={2000}
                  rows={3}
                  showCount
                  placeholder="选填，输入给考生的评语"
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>
                保存评分
              </Button>
            </Form>
          ) : (
            <Typography.Paragraph>评语：{item.comment || '无'}</Typography.Paragraph>
          )}
          {dirty && <Alert className="identity-alert" type="warning" title="评分尚未保存" />}
        </>
      )}
    </Drawer>
  );
}
function MarkImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  return failed ? (
    <Alert
      type="warning"
      title="题图读取失败"
      action={
        <Button
          onClick={() => {
            setFailed(false);
            setRevision((v) => v + 1);
          }}
        >
          重试图片
        </Button>
      }
    />
  ) : (
    <img
      className="question-image"
      src={src + '?retry=' + revision}
      alt={alt}
      onError={() => setFailed(true)}
    />
  );
}
export function ResultPage() {
  const { examId } = useParams(),
    data = useRead<StudentResult>(`/my-exams/${examId}/result`);
  return (
    <>
      <div className="management-toolbar">
        <Link to="/my-exams">返回我的考试</Link>
        <Button onClick={data.reload}>刷新成绩</Button>
      </div>
      {data.error && (
        <Alert
          type="error"
          showIcon
          title={data.error}
          action={<Button onClick={data.reload}>重试</Button>}
        />
      )}
      {!data.value ? (
        !data.error && <Skeleton />
      ) : (
        <Card title={data.value.name}>
          {data.value.state === 'unpublished' ? (
            <Alert
              type="info"
              showIcon
              title="成绩尚未发布"
              description="请等待教师完成阅卷并发布。"
            />
          ) : data.value.state === 'absent' ? (
            <Alert
              type="warning"
              showIcon
              title="缺考"
              description="本场考试未入场，不计为零分。"
            />
          ) : (
            <>
              <Typography.Title level={3}>
                总分 {data.value.totalScore} / {data.value.maxScore}
              </Typography.Title>
              <Typography.Paragraph>
                发布时间（北京）：{dateText(data.value.publishedAt!)}
              </Typography.Paragraph>
              {data.value.items.map((i) => (
                <Card
                  key={i.position}
                  size="small"
                  className="question-history"
                  title={`第 ${i.position} 题 · ${i.score} / ${i.maxScore} 分`}
                >
                  <Typography.Paragraph className="question-text">
                    {i.comment || '无评语'}
                  </Typography.Paragraph>
                </Card>
              ))}
            </>
          )}
        </Card>
      )}
    </>
  );
}
