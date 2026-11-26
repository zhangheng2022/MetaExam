import { useRef, useState } from 'react';
import { Alert, Button, Descriptions, Flex, Typography } from 'antd';
import type {
  DiagnosticBridge,
  DiagnosticReport,
  DiagnosticProbe,
  DiagnosticFileState,
} from '@metaexam/contracts';

const messages = {
  BUSY: '正在处理诊断请求，请稍后重试。',
  CHECK_FAILED: '检查失败，请重试。',
  SAVE_FAILED: '无法保存报告，请检查目标文件夹的写入权限。',
  FILE_EXISTS: '文件已存在，请使用新的文件名。',
  UNSAFE_PATH: '请选择程序与数据目录之外的普通本地文件夹。',
};
const probeLabel = (probe: DiagnosticProbe) =>
  ({
    ok: '正常',
    unreachable: '无法连接',
    invalid_response: '响应异常',
    http_error: `请求失败（${probe.httpStatus}）`,
  })[probe.state];
const fileLabel = (state: DiagnosticFileState) =>
  ({ present: '存在待处理记录', absent: '无待处理记录', unknown: '无法确认' })[state];
export function DiagnosticActions({
  bridge,
  onChecked,
}: {
  bridge: DiagnosticBridge;
  onChecked: () => Promise<void>;
}) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState<'check' | 'export' | null>(null);
  const pending = useRef(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const run = async (action: 'check' | 'export') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setFeedback(null);
    try {
      const result = await (action === 'check'
        ? bridge.checkDiagnostics()
        : bridge.exportDiagnostics());
      if (result.status === 'error') setFeedback({ error: true, text: messages[result.code] });
      if (result.status === 'success') {
        setReport(result.value);
        if (action === 'export') setFeedback({ error: false, text: '诊断报告已导出。' });
        await onChecked();
      }
    } catch {
      setFeedback({ error: true, text: '诊断操作失败，请重试。' });
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  return (
    <Flex vertical gap="middle">
      <Typography.Text type="secondary">
        报告包含版本、服务与维护状态，可在服务断连时导出。
      </Typography.Text>
      <Flex wrap gap="small">
        <Button onClick={() => void run('check')} loading={busy === 'check'} disabled={!!busy}>
          检查诊断
        </Button>
        <Button onClick={() => void run('export')} loading={busy === 'export'} disabled={!!busy}>
          导出诊断报告
        </Button>
      </Flex>
      {feedback && (
        <Alert
          type={feedback.error ? 'error' : 'success'}
          showIcon
          title={feedback.text}
          role="alert"
        />
      )}
      {report && (
        <>
          <Typography.Text type="secondary">
            检查快照：
            {new Date(report.createdAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
            })}
          </Typography.Text>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'live', label: '考试服务', children: probeLabel(report.checks.live) },
              { key: 'ready', label: '数据库就绪', children: probeLabel(report.checks.ready) },
              { key: 'system', label: '系统状态', children: probeLabel(report.checks.system) },
              {
                key: 'worker',
                label: '后台任务',
                children: { online: '在线', offline: '离线', unknown: '无法确认' }[
                  report.system.worker
                ],
              },
              { key: 'version', label: '服务版本', children: report.system.version ?? '无法确认' },
              {
                key: 'upgrade',
                label: '升级记录',
                children: fileLabel(report.maintenance.upgrade),
              },
              {
                key: 'operation',
                label: '维护记录',
                children: fileLabel(report.maintenance.operation),
              },
            ]}
          />
        </>
      )}
    </Flex>
  );
}
