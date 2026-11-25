import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  Radio,
  Skeleton,
  Space,
  Tag,
  Typography,
} from '@metaexam/ui';
import type { AttemptSummary, CandidateQuestion, CandidateAnswer } from '@metaexam/contracts';
import { api, RequestError } from '../api';
import { dateText } from '../management/common';
type EditorHandle = { flush: () => Promise<boolean> };
export function AttemptPage() {
  const { attemptId: id } = useParams();
  const [meta, setMeta] = useState<AttemptSummary>(),
    [error, setError] = useState(''),
    [position, setPosition] = useState(1),
    [busy, setBusy] = useState(false),
    [remaining, setRemaining] = useState(0),
    [modal, holder] = Modal.useModal();
  const editor = useRef<EditorHandle>(null),
    clock = useRef({ at: 0, left: 0 }),
    mounted = useRef(true);
  const reload = useCallback(async () => {
    try {
      const next = await api<AttemptSummary>('/attempts/' + id);
      if (mounted.current) {
        setMeta(next);
        setError('');
        clock.current = {
          at: performance.now(),
          left: Date.parse(next.deadlineAt) - Date.parse(next.serverTime),
        };
        setRemaining(Math.max(0, Math.ceil(clock.current.left / 1000)));
      }
      return next;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return null;
    }
  }, [id]);
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(reload);
    const poll = setInterval(() => void reload(), 10000),
      tick = setInterval(
        () =>
          setRemaining(
            Math.max(
              0,
              Math.ceil((clock.current.left - (performance.now() - clock.current.at)) / 1000),
            ),
          ),
        1000,
      );
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [reload]);
  async function move(next: number) {
    setBusy(true);
    try {
      if (await editor.current?.flush()) setPosition(next);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    try {
      if (!(await editor.current?.flush())) return;
      const latest = await reload();
      if (!latest || latest.status !== 'active') return;
      const confirmed = await modal.confirm({
        title: '确认交卷？',
        content: `已填写 ${latest.answeredCount} / ${latest.items.length} 题。交卷后不能修改或重新作答。`,
        okText: '确认交卷',
        cancelText: '继续检查',
      });
      if (!confirmed) return;
      await api('/attempts/' + id + '/submit', 'POST', { revision: latest.revision });
      await reload();
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
        <Link to="/my-exams">返回我的考试</Link>
        <Button onClick={() => void reload()} disabled={busy}>
          刷新状态
        </Button>
      </div>
      {error && (
        <Alert
          className="identity-alert"
          type="error"
          showIcon
          title={error}
          description="连接异常时，当前状态可能已过时。未保存的输入仅保留在此页面，请勿关闭或刷新浏览器。"
          action={<Button onClick={() => void reload()}>重试</Button>}
        />
      )}
      {!meta ? (
        <Skeleton paragraph={{ rows: 5 }} />
      ) : meta.status === 'submitted' ? (
        <Card title="交卷回执">
          <Alert
            type="success"
            showIcon
            title={meta.submitReason === 'timeout' ? '已到截止时间，系统已收卷' : '交卷成功'}
            description="已保存答案已封存，不能再次作答。成绩尚未发布。"
          />
          <Typography.Paragraph className="question-history">
            {meta.name} · 已填写 {meta.answeredCount} / {meta.items.length} 题
          </Typography.Paragraph>
          <Typography.Paragraph>
            交卷时间（北京）：{dateText(meta.submittedAt!)}
          </Typography.Paragraph>
        </Card>
      ) : (
        <>
          <Card
            title={meta.name}
            extra={
              <Tag color={remaining < 300 ? 'warning' : 'processing'}>
                剩余 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒
              </Tag>
            }
          >
            <Typography.Paragraph>
              截止时间（北京）：{dateText(meta.deadlineAt)} · 已保存填写 {meta.answeredCount} /{' '}
              {meta.items.length} 题
            </Typography.Paragraph>
            <Alert
              className="identity-alert"
              type="info"
              title="输入后自动保存，也可点击保存答案"
              description="仅显示“已保存”才表示已写入服务器。断线时请保持页面打开并重试；关闭页面仍继续计时，截止后按服务器已保存答案收卷。"
            />
            <Space wrap className="attempt-navigation">
              {meta.items.map((i) => (
                <Button
                  key={i.position}
                  type={position === i.position ? 'primary' : 'default'}
                  aria-label={`第 ${i.position} 题${i.answered ? '，已填写' : ''}`}
                  disabled={busy}
                  onClick={() => void move(i.position)}
                >
                  {i.position}
                  {i.answered ? ' ✓' : ''}
                </Button>
              ))}
            </Space>
          </Card>
          <QuestionEditor
            key={id + ':' + position}
            ref={editor}
            id={id!}
            position={position}
            locked={busy}
            onSaved={() => void reload()}
            onClosed={() => void reload()}
          />
          <Space wrap className="question-history">
            <Button disabled={busy || position === 1} onClick={() => void move(position - 1)}>
              上一题
            </Button>
            <Button
              disabled={busy || position === meta.items.length}
              onClick={() => void move(position + 1)}
            >
              下一题
            </Button>
            <Button type="primary" loading={busy} onClick={() => void submit()}>
              交卷
            </Button>
          </Space>
        </>
      )}
    </>
  );
}
function QuestionEditor({
  id,
  position,
  locked,
  onSaved,
  onClosed,
  ref,
}: {
  id: string;
  position: number;
  locked: boolean;
  onSaved: () => void;
  onClosed: () => void;
  ref: Ref<EditorHandle>;
}) {
  const [q, setQ] = useState<CandidateQuestion>(),
    [answer, setAnswer] = useState<CandidateAnswer>(null),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false),
    [conflict, setConflict] = useState(false),
    [retry, setRetry] = useState(0),
    [savedAt, setSavedAt] = useState<string | null>(null),
    [modal, holder] = Modal.useModal();
  const current = useRef<CandidateAnswer>(null),
    saved = useRef('null'),
    revision = useRef(0),
    inflight = useRef<Promise<boolean> | null>(null),
    pending = useRef<{ answer: CandidateAnswer; revision: number; mutationId: string } | null>(
      null,
    ),
    alive = useRef(true),
    callbacks = useRef({ onSaved, onClosed });
  useEffect(() => {
    callbacks.current = { onSaved, onClosed };
  }, [onSaved, onClosed]);
  useEffect(() => {
    let active = true;
    alive.current = true;
    void api<CandidateQuestion>(`/attempts/${id}/questions/${position}`)
      .then((next) => {
        if (!active) return;
        current.current = next.answer;
        saved.current = JSON.stringify(next.answer);
        revision.current = next.revision;
        pending.current = null;
        setAnswer(next.answer);
        setQ(next);
        setSavedAt(next.savedAt);
        setDirty(false);
        setConflict(false);
        setError('');
      })
      .catch((e) => {
        if (active) {
          setError((e as Error).message);
          if (e instanceof RequestError && e.code === 'ATTEMPT_CLOSED')
            callbacks.current.onClosed();
        }
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [id, position, retry]);
  const flush = useCallback(() => {
    if (inflight.current) return inflight.current;
    if (!q || conflict) return Promise.resolve(false);
    const work = (async () => {
      setSaving(true);
      try {
        while (pending.current || JSON.stringify(current.current) !== saved.current) {
          const body = pending.current ?? {
            answer: current.current,
            revision: revision.current,
            mutationId: crypto.randomUUID(),
          };
          pending.current = body;
          const result = await api<{ revision: number; savedAt: string }>(
            `/attempts/${id}/questions/${position}`,
            'PUT',
            body,
          );
          revision.current = result.revision;
          saved.current = JSON.stringify(body.answer);
          pending.current = null;
          if (alive.current) {
            setSavedAt(result.savedAt);
            setDirty(JSON.stringify(current.current) !== saved.current);
            setError('');
          }
        }
        if (alive.current) callbacks.current.onSaved();
        return true;
      } catch (e) {
        if (alive.current) {
          setError((e as Error).message);
          if (e instanceof RequestError) {
            if (e.code === 'ANSWER_CONFLICT' || e.code === 'ANSWER_MUTATION_REUSED')
              setConflict(true);
            if (e.code === 'ATTEMPT_CLOSED') callbacks.current.onClosed();
          }
        }
        return false;
      } finally {
        if (alive.current) setSaving(false);
      }
    })();
    inflight.current = work;
    void work.finally(() => {
      inflight.current = null;
    });
    return work;
  }, [id, position, q, conflict]);
  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = setTimeout(() => void flush(), 800);
    return () => clearTimeout(timer);
  }, [answer, dirty, conflict, flush]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    addEventListener('beforeunload', handler);
    return () => removeEventListener('beforeunload', handler);
  }, [dirty]);
  function change(next: CandidateAnswer) {
    current.current = next;
    setAnswer(next);
    setDirty(JSON.stringify(next) !== saved.current);
  }
  async function reRead() {
    if (
      dirty &&
      !(await modal.confirm({
        title: '重新读取服务器答案？',
        content: '此页面尚未保存的输入会被丢弃。',
        okText: '重新读取',
        cancelText: '保留输入',
      }))
    )
      return;
    setQ(undefined);
    setRetry((v) => v + 1);
  }
  return (
    <Card
      className="question-history"
      title={`第 ${position} 题${q ? ' · ' + q.score + ' 分' : ''}`}
    >
      {holder}
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          className="identity-alert"
          action={
            conflict || !q ? (
              <Button onClick={() => void reRead()}>重新读取</Button>
            ) : (
              <Button onClick={() => void flush()}>重试保存</Button>
            )
          }
        />
      )}
      {!q ? (
        <Skeleton paragraph={{ rows: 3 }} />
      ) : (
        <>
          <Typography.Paragraph className="question-text">
            {q.stem.replaceAll('[[blank]]', '（填空）')}
          </Typography.Paragraph>
          {q.images.map((i) => (
            <ExamImage key={i.id} id={id} image={i} />
          ))}
          <fieldset className="attempt-answer" disabled={locked || conflict}>
            <legend>你的答案</legend>
            {(q.content.type === 'single' || q.content.type === 'multiple') &&
              (q.content.type === 'single' ? (
                <Radio.Group
                  orientation="vertical"
                  value={answer?.type === 'single' ? answer.optionId : null}
                  onChange={(e) => change({ type: 'single', optionId: e.target.value })}
                  options={q.content.options.map((o) => ({ value: o.id, label: o.text }))}
                />
              ) : (
                <Space orientation="vertical">
                  {q.content.options.map((o) => (
                    <Checkbox
                      key={o.id}
                      checked={answer?.type === 'multiple' && answer.optionIds.includes(o.id)}
                      onChange={(e) => {
                        const ids = answer?.type === 'multiple' ? answer.optionIds : [];
                        change({
                          type: 'multiple',
                          optionIds: e.target.checked
                            ? [...ids, o.id]
                            : ids.filter((v) => v !== o.id),
                        });
                      }}
                    >
                      {o.text}
                    </Checkbox>
                  ))}
                </Space>
              ))}
            {q.content.type === 'boolean' && (
              <Radio.Group
                value={answer?.type === 'boolean' ? answer.value : null}
                options={[
                  { value: true, label: '正确' },
                  { value: false, label: '错误' },
                ]}
                onChange={(e) => change({ type: 'boolean', value: e.target.value })}
              />
            )}
            {q.content.type === 'blank' &&
              q.content.blanks.map((b, i) => (
                <div key={b.id} className="attempt-blank">
                  <label htmlFor={'blank-' + b.id}>第 {i + 1} 空</label>
                  <Input
                    id={'blank-' + b.id}
                    maxLength={200}
                    value={
                      answer?.type === 'blank'
                        ? (answer.values.find((v) => v.id === b.id)?.value ?? '')
                        : ''
                    }
                    onChange={(e) => {
                      const values = answer?.type === 'blank' ? answer.values : [];
                      change({
                        type: 'blank',
                        values: [
                          ...values.filter((v) => v.id !== b.id),
                          { id: b.id, value: e.target.value },
                        ],
                      });
                    }}
                  />
                </div>
              ))}
            {q.content.type === 'essay' && (
              <Input.TextArea
                aria-label="简答题答案"
                rows={8}
                maxLength={8000}
                showCount
                value={answer?.type === 'essay' ? answer.text : ''}
                onChange={(e) => change({ type: 'essay', text: e.target.value })}
              />
            )}
          </fieldset>
          <Space wrap className="question-history">
            <Button
              type="primary"
              loading={saving}
              disabled={locked || conflict || (!dirty && !error)}
              onClick={() => void flush()}
            >
              保存答案
            </Button>
            <Button disabled={locked || conflict || saving} onClick={() => change(null)}>
              清空本题
            </Button>
            <Typography.Text
              aria-live="polite"
              type={error ? 'danger' : dirty ? 'warning' : 'secondary'}
            >
              {saving
                ? '正在保存…'
                : error
                  ? '保存未确认，请重试'
                  : dirty
                    ? '尚未保存'
                    : savedAt
                      ? '已保存 · ' + dateText(savedAt)
                      : '尚未作答'}
            </Typography.Text>
          </Space>
        </>
      )}
    </Card>
  );
}
function ExamImage({ id, image }: { id: string; image: { id: string; alt: string } }) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  return failed ? (
    <Alert
      type="error"
      title={'图片暂时不可用：' + image.alt}
      action={
        <Button
          onClick={() => {
            setFailed(false);
            setRetry((v) => v + 1);
          }}
        >
          重试图片
        </Button>
      }
    />
  ) : (
    <img
      className="question-image"
      src={`/api/v1/attempts/${id}/images/${image.id}?retry=${retry}`}
      alt={image.alt}
      onError={() => setFailed(true)}
    />
  );
}
