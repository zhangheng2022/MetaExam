import { useState } from 'react';
import { Alert, Button, Descriptions, Modal, Typography } from 'antd';
import type {
  LicenseImportPreview,
  LicenseManagerBridge,
  LicenseOperationResult,
} from '@metaexam/contracts';

const messages: Record<string, string> = {
  ADMINISTRATOR_REQUIRED: '请从系统托盘退出管理器，再右键选择“以管理员身份运行”后重试。',
  BAD_FORMAT: '授权文件格式不正确，请重新选择。',
  UNKNOWN_KEY: '无法确认授权签发方，请联系供应方。',
  BAD_SIGNATURE: '授权签名校验失败，请重新获取授权文件。',
  WRONG_PRODUCT: '授权文件不适用于 MetaExam。',
  WRONG_INSTANCE: '授权文件不属于当前安装实例。',
  WRONG_DEVICE: '授权文件不属于当前设备。',
  VERSION_MISMATCH: '授权文件不支持当前程序版本。',
  EXPIRED: '授权文件已到期。',
  NOT_YET_VALID: '授权文件尚未生效。',
  STALE_SEQUENCE: '授权序号低于已使用的版本，请获取新授权。',
  SEQUENCE_CONFLICT: '授权序号与已有文件冲突，请联系供应方。',
  CLOCK_ANOMALY: '系统时间异常，请核对本机时间后重试。',
  LICENSE_CHANGED: '当前授权已更新，请重新选择文件并核对变更。',
  IMPORT_RESULT_UNKNOWN: '导入结果暂时无法确认，请检查授权状态后再操作。',
  FILE_TOO_LARGE: '授权文件不能超过 64 KiB。',
  FILE_UNAVAILABLE: '无法读写文件，请检查文件和目录权限。',
  FILE_EXISTS: '该文件已存在，请选择其他文件名。',
  PREVIEW_EXPIRED: '预检已失效，请重新选择授权文件。',
  OPERATION_BUSY: '授权操作正在进行，请稍后重试。',
};
const stateNames = {
  unactivated: '未激活',
  valid: '授权有效',
  expired: '已到期',
  not_yet_valid: '尚未生效',
  invalid: '校验未通过',
  clock_anomaly: '系统时间异常',
};
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '永久授权';
const feature = (value: string) => (value === 'exam.core' ? '考试发布与入场' : value);

export function LicenseActions({
  bridge,
  onImported,
}: {
  bridge: LicenseManagerBridge;
  onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'export' | 'preview' | 'import' | 'cancel' | null>(null);
  const [preview, setPreview] = useState<LicenseImportPreview | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const failure = (code: string) =>
    setNotice({ type: 'error', text: messages[code] ?? '授权操作失败，请检查后台服务后重试。' });
  const run = async <T,>(
    kind: 'export' | 'preview' | 'import',
    action: () => Promise<LicenseOperationResult<T>>,
    success: (value: T) => void,
  ) => {
    if (busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      const result = await action();
      if (result.status === 'success') success(result.value);
      else if (result.status === 'error') failure(result.code);
      if (kind === 'import') await onImported();
    } catch {
      failure(kind === 'import' ? 'IMPORT_RESULT_UNKNOWN' : 'MAINTENANCE_FAILED');
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    if (!preview || busy) return;
    setBusy('cancel');
    try {
      await bridge.cancelLicenseImport(preview.id);
    } catch {
      failure('MAINTENANCE_FAILED');
    } finally {
      setPreview(null);
      setBusy(null);
    }
  };
  return (
    <div className="license-actions">
      <div className="local-manager-actions">
        <Button
          disabled={busy !== null}
          loading={busy === 'export'}
          onClick={() =>
            void run(
              'export',
              () => bridge.exportLicenseRequest(),
              (value) => setNotice({ type: 'success', text: `授权申请已导出：${value.fileName}` }),
            )
          }
        >
          导出授权申请
        </Button>
        <Button
          disabled={busy !== null}
          loading={busy === 'preview'}
          onClick={() => void run('preview', () => bridge.previewLicenseImport(), setPreview)}
        >
          导入授权文件
        </Button>
      </div>
      {notice && (
        <Alert
          className="license-notice"
          type={notice.type}
          showIcon
          role={notice.type === 'error' ? 'alert' : 'status'}
          title={notice.text}
        />
      )}
      <Modal
        title="确认导入授权"
        open={!!preview}
        destroyOnHidden
        width={600}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        confirmLoading={busy === 'import'}
        cancelButtonProps={{ disabled: busy !== null, 'aria-label': '取消' }}
        styles={{ body: { overflowWrap: 'anywhere' } }}
        okText="确认导入"
        cancelText="取消"
        onCancel={() => void cancel()}
        onOk={() => {
          if (!preview) return;
          const id = preview.id;
          void run(
            'import',
            () => bridge.confirmLicenseImport(id),
            () => setNotice({ type: 'success', text: '授权已导入。' }),
          ).finally(() => setPreview(null));
        }}
      >
        {preview && (
          <>
            <Typography.Paragraph type="secondary">{preview.fileName}</Typography.Paragraph>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: 'current', label: '当前授权', children: stateNames[preview.current.state] },
                {
                  key: 'expiry',
                  label: '有效期',
                  children: `${preview.current.state === 'valid' ? date(preview.current.expiresAt) : '—'} → ${date(preview.candidate.expiresAt)}`,
                },
                {
                  key: 'capacity',
                  label: '同时作答',
                  children: `${preview.current.maxConcurrentAttempts ?? '—'} → ${preview.candidate.maxConcurrentAttempts} 人`,
                },
                {
                  key: 'features',
                  label: '授权功能',
                  children: `${preview.current.features.map(feature).join('、') || '—'} → ${preview.candidate.features.map(feature).join('、')}`,
                },
                { key: 'start', label: '生效时间', children: date(preview.candidate.notBefore) },
                { key: 'id', label: '授权编号', children: preview.candidate.licenseId },
                { key: 'sequence', label: '授权序号', children: preview.candidate.sequence },
              ]}
            />
            <Typography.Paragraph type="secondary" className="license-notice">
              确认后更新当前授权。已合法入场的考生继续作答，新增入场按新授权判断。
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </div>
  );
}
