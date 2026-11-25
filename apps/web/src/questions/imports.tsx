import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from '@metaexam/ui';
import type { ImportSummary, ImportRow, PageResult, QuestionInput } from '@metaexam/contracts';
import { api, apiResponse } from '../api';
import { dateText } from '../management/common';
import { QuestionPreview } from './editor';
const statuses = {
  pending: '等待预检',
  processing: '正在预检',
  ready: '预检完成',
  queued: '等待入库',
  completed: '已入库',
  failed: '处理失败',
};
const failure = (code: string | null) =>
  (
    ({
      INVALID_TEMPLATE: '模板格式不匹配，请重新下载模板。',
      EMPTY_WORKBOOK: '没有可导入的题目。',
      INVALID_WORKBOOK: '工作簿格式或内容超出限制，请使用模板。',
      FORBIDDEN: '当前账号已无权写入题库。',
      NOT_FOUND: '当前题库已不可访问。',
      BANK_READ_ONLY: '题库归档或课程停用。',
      IMPORT_EXPIRED: '预检已过期，请重新上传。',
      FILE_UNAVAILABLE: '本地源文件不可用，请检查数据目录。',
      RETRIES_EXHAUSTED: '后台重试失败，请检查服务后重新上传。',
      SOURCE_CHANGED: '源文件校验失败，请重新上传。',
      FILE_PROCESSING_TIMEOUT: '处理超时，请缩小工作簿。',
    }) as Record<string, string>
  )[code ?? ''] ?? '文件处理失败，请检查文件与后台服务。';
type Report = { summary: ImportSummary; rows: PageResult<ImportRow> };
export function ImportManager({
  bankId,
  writable,
  close,
  changed,
}: {
  bankId: string;
  writable: boolean;
  close: () => void;
  changed: () => void;
}) {
  const [history, setHistory] = useState<PageResult<ImportSummary>>(),
    [selected, setSelected] = useState<string>(),
    [report, setReport] = useState<Report>(),
    [page, setPage] = useState(1),
    [historyPage, setHistoryPage] = useState(1),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [preview, setPreview] = useState<QuestionInput>(),
    [policy, setPolicy] = useState<'skip' | 'keep'>('skip');
  const base = `/question-banks/${bankId}/imports`;
  const requestVersion = useRef(0);
  const invalidate = useCallback(() => {
    requestVersion.current++;
  }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const h = await api<PageResult<ImportSummary>>(base + `?page=${historyPage}&pageSize=10`);
      const r = selected
        ? await api<Report>(base + '/' + selected + `?page=${page}&pageSize=20`)
        : undefined;
      if (version !== requestVersion.current) return;
      setHistory(h);
      setReport(r);
      setReadError('');
    } catch (e) {
      if (version === requestVersion.current) setReadError((e as Error).message);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [base, historyPage, selected, page]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!active) return;
      await refresh();
      if (active) timer = setTimeout(() => void tick(), 2500);
    };
    void tick();
    return () => {
      active = false;
      invalidate();
      clearTimeout(timer);
    };
  }, [refresh, invalidate]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File) =>
    act(async () => {
      if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 2 * 1024 * 1024)
        throw new Error('请选择不超过 2 MiB 的 .xlsx 文件。');
      const form = new FormData();
      form.append('file', file);
      const result = await api<{ id: string }>(base, 'POST', form);
      choose(result.id);
    });
  const choose = (id: string) => {
    invalidate();
    setReport(undefined);
    setLoading(true);
    setError('');
    setSelected(id);
    setPage(1);
    setPolicy('skip');
  };
  return (
    <Drawer
      title="Excel 题目导入"
      open
      size={1040}
      onClose={() => {
        if (!busy) {
          changed();
          close();
        }
      }}
      closable={!busy}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="先预检，后确认入库"
        description="每次最多 500 行、文件 2 MiB，仅导入文字题目。有错误时须修正并重新上传；图片可在题目入库后添加。后台任务在关闭窗口后继续运行，可从导入记录恢复查看。"
        className="identity-alert"
      />
      {(error || readError) && (
        <Alert
          type="error"
          showIcon
          title={error || readError}
          description={readError ? '读取失败时下方可能显示上次数据。' : undefined}
          action={<Button onClick={() => void refresh()}>重试</Button>}
          className="identity-alert"
        />
      )}
      <Space wrap className="management-toolbar">
        <Button
          disabled={!writable || busy}
          onClick={() =>
            void act(async () => {
              const r = await apiResponse(`/question-banks/${bankId}/import-template`);
              const url = URL.createObjectURL(await r.blob());
              const a = document.createElement('a');
              a.href = url;
              a.download = 'MetaExam-questions-template.xlsx';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          下载 Excel 模板
        </Button>
        <Upload
          accept=".xlsx"
          showUploadList={false}
          maxCount={1}
          disabled={!writable || busy}
          beforeUpload={(file) => {
            void upload(file);
            return false;
          }}
        >
          <Button type="primary" loading={busy} disabled={!writable}>
            上传并预检
          </Button>
        </Upload>
      </Space>
      <Table<ImportSummary>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={history?.items ?? []}
        scroll={{ x: 700 }}
        pagination={{
          current: historyPage,
          pageSize: 10,
          total: history?.total ?? 0,
          showSizeChanger: false,
          onChange: setHistoryPage,
        }}
        columns={[
          { title: '文件', dataIndex: 'filename' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: ImportSummary['status']) => statuses[s],
          },
          { title: '时间（北京）', dataIndex: 'createdAt', render: dateText },
          {
            title: '操作',
            render: (_, r) => (
              <Button type="link" disabled={busy} onClick={() => choose(r.id)}>
                查看报告
              </Button>
            ),
          },
        ]}
      />
      {report && (
        <Card title="预检报告" className="question-history">
          <Space wrap>
            <Tag>{statuses[report.summary.status]}</Tag>
            <Typography.Text>
              共 {report.summary.total} 行 · 错误 {report.summary.errors} 行 · 重复{' '}
              {report.summary.duplicates} 行
            </Typography.Text>
          </Space>
          {report.summary.status === 'failed' && (
            <Alert type="error" showIcon title={failure(report.summary.errorCode)} />
          )}
          {report.summary.status === 'ready' && (
            <div className="question-fields">
              <Alert
                type={report.summary.errors ? 'error' : 'info'}
                title={
                  report.summary.errors
                    ? '存在错误，请修正 Excel 后重新上传'
                    : '预检完成，请核对题目再确认'
                }
                description="重复按题型、题干、选项和答案判断；确认时会再次检查，不覆盖任何已有题目。预检有效期为上传后 24 小时。"
              />
              <Space wrap>
                <Select
                  aria-label="重复题处理"
                  value={policy}
                  onChange={setPolicy}
                  options={[
                    { value: 'skip', label: '跳过重复题（默认）' },
                    { value: 'keep', label: '保留为新题' },
                  ]}
                  disabled={busy}
                />
                <Button
                  type="primary"
                  loading={busy}
                  disabled={!writable || report.summary.errors > 0}
                  onClick={() =>
                    void act(async () => {
                      await api(base + '/' + selected + '/confirm', 'POST', {
                        duplicatePolicy: policy,
                      });
                      changed();
                    })
                  }
                >
                  确认导入
                </Button>
              </Space>
            </div>
          )}
          {report.summary.status === 'completed' && (
            <Alert
              type="success"
              showIcon
              title={`导入完成：新增 ${report.summary.imported} 题，跳过 ${report.summary.skipped} 题`}
              description="题目已保存，可关闭窗口后查看题库。"
            />
          )}
          {['pending', 'processing', 'queued'].includes(report.summary.status) && (
            <Alert
              type="info"
              title="后台正在处理，请稍候"
              description="若长时间没有变化，请确认 Worker 正在运行。"
            />
          )}
          <Table<ImportRow>
            rowKey="rowNumber"
            size="small"
            dataSource={report.rows.items}
            scroll={{ x: 650 }}
            pagination={{
              current: page,
              pageSize: 20,
              total: report.rows.total,
              showSizeChanger: false,
              onChange: setPage,
            }}
            columns={[
              { title: 'Excel 行', dataIndex: 'rowNumber', width: 90 },
              { title: '题干', render: (_, r) => r.question?.stem ?? '请查看错误', ellipsis: true },
              {
                title: '校验结果',
                render: (_, r) =>
                  r.errors.length ? r.errors.join('；') : r.duplicate ? '重复题' : '通过',
              },
              {
                title: '操作',
                render: (_, r) =>
                  r.question && (
                    <Button type="link" onClick={() => setPreview(r.question!)}>
                      预览题目
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      )}
      <Modal
        title="导入题目预览"
        open={!!preview}
        footer={null}
        onCancel={() => setPreview(undefined)}
        destroyOnHidden
      >
        {preview && <QuestionPreview question={preview} />}
      </Modal>
    </Drawer>
  );
}
