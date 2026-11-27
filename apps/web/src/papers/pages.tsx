import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from '@metaexam/ui';
import {
  paperSaveSchema,
  type PaperSummary,
  type PaperDetail,
  type PaperItem,
} from '@metaexam/contracts';
import { api } from '../api';
import { UnsavedChangesGuard } from '../unsaved-changes';
import { DataTable, Editor, RemotePicker, dateText, usePaged } from '../management/common';
import { QuestionPreview, typeOptions } from '../questions/editor';
import { DrawEditor, ManualPicker } from './picker';
export function PapersPage() {
  const { paperId } = useParams();
  return paperId ? <Detail key={paperId} id={paperId} /> : <List />;
}
function List() {
  const list = usePaged<PaperSummary>('/papers'),
    navigate = useNavigate(),
    [create, setCreate] = useState(false);
  return (
    <Card
      title="课程试卷"
      extra={
        <Button type="primary" onClick={() => setCreate(true)}>
          创建试卷
        </Button>
      }
    >
      <Form
        layout="inline"
        name="paper-filters"
        className="management-filters"
        initialValues={Object.fromEntries(list.params)}
        key={list.params.toString()}
        onFinish={list.filter}
      >
        <Form.Item name="q" label="搜索">
          <Input placeholder="试卷名称" maxLength={100} />
        </Form.Item>
        <Form.Item name="status" label="状态">
          <Select
            className="filter-select"
            allowClear
            placeholder="全部"
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'frozen', label: '已冻结' },
            ]}
          />
        </Form.Item>
        <Button htmlType="submit">查询</Button>
        <Button onClick={() => list.filter({})}>重置</Button>
      </Form>
      <DataTable
        list={list}
        columns={[
          { title: '试卷名称', render: (_, r) => <Link to={'/papers/' + r.id}>{r.name}</Link> },
          { title: '课程', dataIndex: 'courseName' },
          { title: '创建人', dataIndex: 'ownerName' },
          {
            title: '状态',
            render: (_, r) => (
              <Tag color={r.status === 'frozen' ? 'success' : 'processing'}>
                {r.status === 'frozen' ? '已冻结' : '草稿'}
              </Tag>
            ),
          },
          { title: '题数', dataIndex: 'itemCount' },
          { title: '总分', dataIndex: 'totalScore' },
          { title: '更新时间（北京）', dataIndex: 'updatedAt', render: dateText },
        ]}
      />
      {create && (
        <Editor
          title="创建试卷"
          initialValues={{ instructions: '' }}
          close={() => setCreate(false)}
          done={() => {
            setCreate(false);
            list.reload();
          }}
          save={async (values) => {
            const r = await api<{ id: string }>('/papers', 'POST', values);
            navigate('/papers/' + r.id);
          }}
        >
          <Alert type="info" title="创建后不能更换课程" className="identity-alert" />
          <Form.Item
            name="name"
            label="试卷名称"
            rules={[{ required: true, whitespace: true, max: 100 }]}
          >
            <Input maxLength={100} placeholder="请输入试卷名称" />
          </Form.Item>
          <Form.Item name="courseId" label="所属课程" rules={[{ required: true }]}>
            <RemotePicker
              placeholder="搜索并选择课程"
              endpoint="/question-banks/courses"
              enabledOnly={false}
            />
          </Form.Item>
          <Form.Item name="instructions" label="作答说明">
            <Input.TextArea
              maxLength={2000}
              rows={4}
              placeholder="选填，输入考生作答时需遵守的说明"
            />
          </Form.Item>
        </Editor>
      )}
    </Card>
  );
}
function Detail({ id }: { id: string }) {
  const [paper, setPaper] = useState<PaperDetail>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError('');
      try {
        const p = await api<PaperDetail>('/papers/' + id);
        if (active) setPaper(p);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [id, version]);
  const reload = () => setVersion((v) => v + 1);
  return (
    <>
      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={reload}>重试</Button>}
        />
      ) : loading ? (
        <Skeleton paragraph={{ rows: 6 }} />
      ) : (
        paper && <Workspace key={paper.id + ':' + paper.revision} paper={paper} reload={reload} />
      )}
    </>
  );
}
function Preview({ paper, close }: { paper: PaperDetail; close: () => void }) {
  const [page, setPage] = useState(1);
  return (
    <Drawer open title="教师预览（含答案）" size={880} onClose={close}>
      <Typography.Title level={3}>{paper.name}</Typography.Title>
      <Typography.Paragraph className="question-text">
        {paper.instructions || '暂无作答说明'}
      </Typography.Paragraph>
      <Typography.Paragraph>
        共 {paper.items.length} 题 · 总分 {paper.totalScore} 分
      </Typography.Paragraph>
      <Space orientation="vertical" size="large" className="paper-preview">
        {paper.items.slice((page - 1) * 5, page * 5).map((item, i) => (
          <Card
            key={item.versionId}
            title={`第 ${(page - 1) * 5 + i + 1} 题 · ${item.score} 分 · V${item.version}`}
          >
            <QuestionPreview question={item.question} bankId={item.bankId} />
          </Card>
        ))}
      </Space>
      <Pagination
        current={page}
        pageSize={5}
        total={paper.items.length}
        onChange={setPage}
        showSizeChanger={false}
        className="question-history"
      />
    </Drawer>
  );
}
function Workspace({ paper, reload }: { paper: PaperDetail; reload: () => void }) {
  const navigate = useNavigate(),
    [modal, holder] = Modal.useModal();
  const [name, setName] = useState(paper.name),
    [instructions, setInstructions] = useState(paper.instructions),
    [items, setItems] = useState(paper.items),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [panel, setPanel] = useState<'manual' | 'draw' | 'preview' | 'copy'>();
  const selection = (values: PaperItem[]) =>
    values.map((i) => ({ versionId: i.versionId, score: i.score }));
  const dirty =
    name !== paper.name ||
    instructions !== paper.instructions ||
    JSON.stringify(selection(items)) !== JSON.stringify(selection(paper.items));
  const writable = paper.status === 'draft' && paper.courseEnabled;
  const total = items.reduce((n, i) => n + i.score * 2, 0) / 2;
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const move = (at: number, to: number) => {
    const next = [...items];
    const item = next.splice(at, 1)[0]!;
    next.splice(to, 0, item);
    setItems(next);
  };
  const done = () => {
    setPanel(undefined);
    reload();
  };
  return (
    <>
      {holder}
      <UnsavedChangesGuard dirty={dirty} busy={busy} />
      <Space wrap className="management-toolbar">
        <Button disabled={busy} onClick={() => navigate('/papers')}>
          返回试卷列表
        </Button>
        <Button disabled={dirty || busy} onClick={() => setPanel('preview')}>
          预览试卷
        </Button>
      </Space>
      {error && (
        <Alert
          className="identity-alert"
          type="error"
          showIcon
          title={error}
          action={
            <Button disabled={busy} onClick={reload}>
              重新加载
            </Button>
          }
        />
      )}
      {dirty && (
        <Alert
          className="identity-alert"
          type="warning"
          showIcon
          title="有未保存的修改"
          description="请先保存，再选题、抽题、预览或冻结。离开当前页面会丢失这些修改。"
        />
      )}
      {paper.status === 'frozen' ? (
        <Alert
          className="identity-alert"
          type="success"
          showIcon
          title="试卷已冻结"
          description={`题目版本、顺序和分值已固定。冻结时间：${dateText(paper.frozenAt!)}；需要修改时请复制为新草稿。`}
          action={
            <Button disabled={!paper.courseEnabled || busy} onClick={() => setPanel('copy')}>
              复制为新草稿
            </Button>
          }
        />
      ) : (
        !paper.courseEnabled && (
          <Alert type="warning" title="课程已停用，试卷只读" className="identity-alert" />
        )
      )}
      <Card
        title={
          <Space wrap>
            <span>{paper.name}</span>
            <Tag>{paper.courseName}</Tag>
            <Tag>
              {items.length} 题 · {total} 分
            </Tag>
          </Space>
        }
      >
        {writable ? (
          <Form layout="vertical" disabled={busy}>
            <Form.Item label="试卷名称" htmlFor="paper-name" required>
              <Input
                id="paper-name"
                placeholder="请输入试卷名称"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </Form.Item>
            <Form.Item label="作答说明" htmlFor="paper-instructions">
              <Input.TextArea
                id="paper-instructions"
                placeholder="选填，输入考生作答时需遵守的说明"
                value={instructions}
                maxLength={2000}
                rows={3}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Form.Item>
          </Form>
        ) : (
          <Typography.Paragraph className="question-text">
            {paper.instructions || '暂无作答说明'}
          </Typography.Paragraph>
        )}
        {writable && (
          <Space wrap className="paper-actions">
            <Button
              type={!dirty && !items.length ? 'primary' : 'default'}
              disabled={dirty || busy || items.length >= 200}
              onClick={() => setPanel('manual')}
            >
              手动选题
            </Button>
            <Button
              disabled={dirty || busy || items.length >= 200}
              onClick={() => setPanel('draw')}
            >
              按条件抽题
            </Button>
            <Button
              type={dirty ? 'primary' : 'default'}
              loading={busy}
              disabled={!dirty}
              onClick={() =>
                void act(async () => {
                  const input = paperSaveSchema.safeParse({
                    name,
                    instructions,
                    revision: paper.revision,
                    items: selection(items),
                  });
                  if (!input.success)
                    throw new Error('请检查试卷名称和分值；每题为 0.5～1000 分，须为 0.5 的倍数。');
                  await api('/papers/' + paper.id, 'PATCH', input.data);
                })
              }
            >
              保存草稿
            </Button>
            <Button
              disabled={dirty || busy || !items.length}
              type={!dirty && items.length ? 'primary' : 'default'}
              onClick={() =>
                modal.confirm({
                  title: '冻结这份试卷？',
                  content: `共 ${items.length} 题，总分 ${total} 分。将固定当前选入的题目版本（包括旧版）、顺序和分值；冻结后只能复制为新草稿修改。`,
                  okText: '确认冻结',
                  cancelText: '继续检查',
                  onOk: () =>
                    act(() =>
                      api('/papers/' + paper.id + '/freeze', 'POST', { revision: paper.revision }),
                    ),
                })
              }
            >
              冻结试卷
            </Button>
          </Space>
        )}
        <Table<PaperItem>
          rowKey="versionId"
          dataSource={items}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 850 }}
          locale={{ emptyText: '尚未选题，请手动选择或按条件抽题' }}
          columns={[
            { title: '序号', width: 65, render: (_, r) => items.indexOf(r) + 1 },
            {
              title: '题干',
              render: (_, r) => (
                <div>
                  <Typography.Text>{r.question.stem}</Typography.Text>
                  {!r.available && paper.status === 'draft' && (
                    <div>
                      <Tag color="warning">来源已归档或停用，冻结前须移除</Tag>
                    </div>
                  )}
                </div>
              ),
              ellipsis: true,
            },
            {
              title: '题型',
              width: 90,
              render: (_, r) => typeOptions.find((t) => t.value === r.question.content.type)?.label,
            },
            {
              title: '采用版本',
              width: 110,
              render: (_, r) => (
                <span>
                  V{r.version}
                  {r.currentVersion > r.version && (
                    <div>
                      <Typography.Text type="secondary">题库现 V{r.currentVersion}</Typography.Text>
                    </div>
                  )}
                </span>
              ),
            },
            {
              title: '分值',
              width: 110,
              render: (_, r) =>
                writable ? (
                  <InputNumber
                    aria-label={`第 ${items.indexOf(r) + 1} 题分值`}
                    placeholder="分值"
                    min={0.5}
                    max={1000}
                    step={0.5}
                    value={r.score}
                    disabled={busy}
                    onChange={(v) =>
                      setItems(
                        items.map((i) =>
                          i.versionId === r.versionId ? { ...i, score: v ?? 0 } : i,
                        ),
                      )
                    }
                  />
                ) : (
                  r.score
                ),
            },
            ...(writable
              ? [
                  {
                    title: '操作',
                    width: 180,
                    render: (_: unknown, r: PaperItem) => {
                      const i = items.indexOf(r);
                      return (
                        <Space>
                          <Button
                            size="small"
                            aria-label={`上移第 ${i + 1} 题`}
                            disabled={busy || i === 0}
                            onClick={() => move(i, i - 1)}
                          >
                            上移
                          </Button>
                          <Button
                            size="small"
                            aria-label={`下移第 ${i + 1} 题`}
                            disabled={busy || i === items.length - 1}
                            onClick={() => move(i, i + 1)}
                          >
                            下移
                          </Button>
                          <Button
                            size="small"
                            danger
                            disabled={busy}
                            onClick={() =>
                              setItems(items.filter((v) => v.versionId !== r.versionId))
                            }
                          >
                            移除
                          </Button>
                        </Space>
                      );
                    },
                  },
                ]
              : []),
          ]}
        />
      </Card>
      {panel === 'manual' && (
        <ManualPicker paper={paper} done={done} close={() => setPanel(undefined)} />
      )}
      {panel === 'draw' && (
        <DrawEditor paper={paper} done={done} close={() => setPanel(undefined)} />
      )}
      {panel === 'preview' && <Preview paper={paper} close={() => setPanel(undefined)} />}
      {panel === 'copy' && (
        <Editor
          title="复制为新草稿"
          initialValues={{ name: paper.name.slice(0, 90) + '（副本）' }}
          close={() => setPanel(undefined)}
          done={() => setPanel(undefined)}
          save={async (values) => {
            const r = await api<{ id: string }>('/papers/' + paper.id + '/copy', 'POST', values);
            navigate('/papers/' + r.id);
          }}
        >
          <Form.Item
            label="新试卷名称"
            name="name"
            rules={[{ required: true, whitespace: true, max: 100 }]}
          >
            <Input maxLength={100} placeholder="请输入试卷名称" />
          </Form.Item>
          <Alert
            type="info"
            title="保留冻结版本中的题目、顺序和分值"
            description="沿用原题目版本；已归档题目须移除或替换后才能冻结。"
          />
        </Editor>
      )}
    </>
  );
}
