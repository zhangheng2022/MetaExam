import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
} from '@metaexam/ui';
import {
  paperDrawSchema,
  paperSaveSchema,
  type PaperDetail,
  type PaperCandidate,
  type PageResult,
} from '@metaexam/contracts';
import { api } from '../api';
import { Editor, RemotePicker } from '../management/common';
import { typeOptions } from '../questions/editor';
export function DrawEditor({
  paper,
  done,
  close,
}: {
  paper: PaperDetail;
  done: () => void;
  close: () => void;
}) {
  return (
    <Editor
      title="按条件抽题"
      submitText="抽题并加入"
      initialValues={{ count: 1, score: 1, type: 'single' }}
      done={done}
      close={close}
      save={async (values) => {
        const parsed = paperDrawSchema.safeParse({ ...values, revision: paper.revision });
        if (!parsed.success)
          throw new Error('请检查题库、题型、题数和分值；每题分值须为 0.5 的倍数。');
        await api(`/papers/${paper.id}/draw`, 'POST', parsed.data);
      }}
    >
      <Alert
        type="info"
        showIcon
        title="随机抽取未选入的题目"
        description="所有条件同时满足才会抽中；数量不足时整批不加入。一次最多 100 题，每卷最多 200 题。"
        className="identity-alert"
      />
      <Form.Item name="bankId" label="来源题库" rules={[{ required: true }]}>
        <RemotePicker
          placeholder="搜索并选择题库"
          endpoint={`/question-banks?courseId=${paper.courseId}&archived=false`}
          enabledOnly={false}
        />
      </Form.Item>
      <Form.Item name="type" label="题型" rules={[{ required: true }]}>
        <Select options={typeOptions} placeholder="请选择题型" />
      </Form.Item>
      <Form.Item name="difficulty" label="难度">
        <Select
          allowClear
          options={[1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }))}
          placeholder="全部难度"
        />
      </Form.Item>
      <Form.Item name="tag" label="标签">
        <Input maxLength={40} placeholder="完整匹配，可留空" />
      </Form.Item>
      <Form.Item name="knowledgePoint" label="知识点">
        <Input maxLength={80} placeholder="完整匹配，可留空" />
      </Form.Item>
      <Form.Item name="count" label="抽题数量" rules={[{ required: true }]}>
        <InputNumber
          min={1}
          max={Math.min(100, 200 - paper.items.length)}
          precision={0}
          placeholder="请输入题数"
        />
      </Form.Item>
      <Form.Item name="score" label="每题分值" rules={[{ required: true }]}>
        <InputNumber min={0.5} max={1000} step={0.5} placeholder="请输入分值" />
      </Form.Item>
    </Editor>
  );
}
export function ManualPicker({
  paper,
  done,
  close,
}: {
  paper: PaperDetail;
  done: () => void;
  close: () => void;
}) {
  const [bank, setBank] = useState<string>(),
    [query, setQuery] = useState<Record<string, string>>({}),
    [page, setPage] = useState(1),
    [result, setResult] = useState<PageResult<PaperCandidate>>(),
    [selected, setSelected] = useState<PaperCandidate[]>([]),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [score, setScore] = useState<number | null>(1),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!bank) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError('');
      try {
        const r = await api<PageResult<PaperCandidate>>(
          `/papers/${paper.id}/candidates?` +
            new URLSearchParams({ ...query, bankId: bank, page: String(page), pageSize: '10' }),
        );
        if (active) setResult(r);
      } catch (e) {
        if (active) {
          setResult(undefined);
          setError((e as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [bank, query, page, paper.id, retry]);
  return (
    <Drawer
      open
      title="手动选题"
      size={960}
      onClose={() => {
        if (!busy) close();
      }}
      closable={!busy}
      maskClosable={!busy}
      footer={
        <Space wrap>
          <Button
            type="primary"
            loading={busy}
            disabled={!selected.length || loading || !!error}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const input = paperSaveSchema.safeParse({
                  revision: paper.revision,
                  name: paper.name,
                  instructions: paper.instructions,
                  items: [
                    ...paper.items.map((i) => ({ versionId: i.versionId, score: i.score })),
                    ...selected.map((i) => ({ versionId: i.versionId, score })),
                  ],
                });
                if (!input.success)
                  throw new Error('每卷最多 200 题，每题分值须为 0.5～1000，且是 0.5 的倍数。');
                await api('/papers/' + paper.id, 'PATCH', input.data);
                done();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            加入试卷（{selected.length} 题）
          </Button>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        title="仅显示本课程可用、尚未选入的题目"
        description="加入时保留列表中显示的题目版本；选入后可在试卷中预览完整题目和答案。跨页选择会保留，切换题库会清空本次选择。"
        className="identity-alert"
      />
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={() => setRetry((v) => v + 1)}>重试</Button>}
          className="identity-alert"
        />
      )}
      <Form layout="vertical" disabled={busy}>
        <Form.Item label="来源题库" htmlFor="paper-bank">
          <RemotePicker
            id="paper-bank"
            placeholder="搜索并选择题库"
            endpoint={`/question-banks?courseId=${paper.courseId}&archived=false`}
            enabledOnly={false}
            value={bank}
            onChange={(id) => {
              setBank(id);
              setPage(1);
              setSelected([]);
              setResult(undefined);
            }}
          />
        </Form.Item>
        <Form.Item label="所选题目分值">
          <InputNumber
            placeholder="请输入分值"
            aria-label="所选题目分值"
            min={0.5}
            max={1000}
            step={0.5}
            value={score}
            onChange={setScore}
          />
        </Form.Item>
      </Form>
      <Form
        layout="inline"
        className="management-filters"
        onFinish={(values) => {
          setQuery(
            Object.fromEntries(
              Object.entries(values)
                .filter(([, v]) => v !== undefined && v !== '')
                .map(([k, v]) => [k, String(v)]),
            ),
          );
          setPage(1);
        }}
        disabled={busy}
      >
        <Form.Item name="q" label="题干搜索">
          <Input maxLength={100} placeholder="请输入题干关键词" />
        </Form.Item>
        <Form.Item name="type" label="题型">
          <Select className="filter-select" allowClear options={typeOptions} placeholder="全部" />
        </Form.Item>
        <Button htmlType="submit" disabled={!bank}>
          查询
        </Button>
      </Form>
      <Table<PaperCandidate>
        rowKey="versionId"
        loading={loading}
        dataSource={result?.items ?? []}
        scroll={{ x: 650 }}
        locale={{ emptyText: bank ? '没有符合条件的题目' : '请先选择来源题库' }}
        pagination={{
          current: page,
          pageSize: 10,
          total: result?.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        rowSelection={{
          selectedRowKeys: selected.map((r) => r.versionId),
          preserveSelectedRowKeys: true,
          getCheckboxProps: () => ({ disabled: busy || loading }),
          onChange: (keys) => {
            const rows = new Map(
              [...selected, ...(result?.items ?? [])].map((r) => [r.versionId, r]),
            );
            setSelected(
              keys.map((k) => rows.get(String(k))).filter((r): r is PaperCandidate => !!r),
            );
          },
        }}
        columns={[
          { title: '题干', dataIndex: 'stem', ellipsis: true },
          { title: '题型', render: (_, r) => typeOptions.find((o) => o.value === r.type)?.label },
          { title: '难度', dataIndex: 'difficulty' },
          { title: '选入版本', render: (_, r) => 'V' + r.version },
        ]}
      />
    </Drawer>
  );
}
