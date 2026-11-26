import { useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd';
import type { BackupBridge, BackupInfo, BackupResult } from '@metaexam/contracts';
const messages: Record<string, string> = {
  ADMINISTRATOR_REQUIRED: '请以管理员身份运行本地管理器。',
  SERVICES_RUNNING: '请先停止考试服务、后台任务及其他维护命令，再重试。数据库需保持运行。',
  EXAMS_ACTIVE: '当前有进行中的考试，结束后才能备份或恢复。',
  BACKUP_UNTRUSTED: '无法验证备份来源。请选择本机创建的完整备份。',
  BACKUP_CHANGED: '备份内容已变化或损坏，请重新选择完整备份。',
  BACKUP_INCOMPATIBLE: '备份与当前程序或数据库版本不兼容。',
  BACKUP_WRONG_INSTANCE: '备份不属于当前安装实例。',
  BACKUP_WRONG_DEVICE: '备份不属于当前设备。',
  BACKUP_SPACE_REQUIRED: '可用空间不足，请清理备份位置或数据磁盘后重试。',
  BACKUP_ATTACHMENT_MISSING: '备份附件缺失或校验失败。',
  BACKUP_INITIALIZATION_ROLLBACK: '不能恢复到管理员尚未初始化的备份。',
  BACKUP_UNSAFE_PATH: '请选择普通本地文件夹，不支持链接目录或文件。',
  PREVIEW_EXPIRED: '恢复预览已过期，请重新选择备份。',
  OPERATION_BUSY: '已有维护操作正在执行，请等待完成。',
  MAINTENANCE_REQUIRED: '上次维护未完成，请先回退中断的维护。',
  RESTORE_RECOVERY_REQUIRED: '恢复中断，服务已被阻止启动。请回退中断的维护。',
  RESTORE_RESULT_UNKNOWN: '暂时无法确认恢复结果。请回退中断的维护并检查服务状态。',
};
export function BackupActions({ bridge }: { bridge: BackupBridge }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<(BackupInfo & { previewId: string }) | null>(null);
  const [notice, setNotice] = useState<{
    type: 'success' | 'error';
    message: string;
    recovery?: boolean;
  } | null>(null);
  const run = async <T,>(action: () => Promise<BackupResult<T>>, done: (value: T) => void) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      if (result.status === 'success') done(result.value);
      else if (result.status === 'error')
        setNotice({
          type: 'error',
          message: messages[result.code] ?? '维护未完成，请检查目录权限、可用空间和数据库后重试。',
          recovery: [
            'MAINTENANCE_REQUIRED',
            'RESTORE_RECOVERY_REQUIRED',
            'RESTORE_RESULT_UNKNOWN',
          ].includes(result.code),
        });
    } catch {
      setNotice({ type: 'error', message: '维护结果无法确认，请检查后重试。', recovery: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Typography.Paragraph type="secondary">
        先停止考试服务和后台任务，保留数据库运行。恢复仅支持本机。
      </Typography.Paragraph>
      <Space wrap>
        <Button
          disabled={busy}
          loading={busy && !preview}
          onClick={() =>
            void run(
              () => bridge.createBackup(),
              () =>
                setNotice({
                  type: 'success',
                  message: '备份已保存到所选位置。请妥善保管完整文件夹。',
                }),
            )
          }
        >
          创建备份
        </Button>
        <Button disabled={busy} onClick={() => void run(() => bridge.previewRestore(), setPreview)}>
          恢复备份
        </Button>
      </Space>
      {notice && (
        <Alert
          className="license-notice"
          showIcon
          type={notice.type}
          title={notice.message}
          action={
            notice.recovery ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => bridge.recoverRestore(),
                    (value) =>
                      setNotice({
                        type: 'success',
                        message: value.recovered
                          ? '已回退中断的维护，可以重新启动服务。'
                          : '没有待回退的维护，请重新检查服务状态。',
                      }),
                  )
                }
              >
                回退中断维护
              </Button>
            ) : undefined
          }
        />
      )}
      <Modal
        title="确认恢复备份"
        open={!!preview}
        destroyOnHidden
        width={560}
        confirmLoading={busy}
        okText="确认恢复"
        okButtonProps={{ danger: true, disabled: busy }}
        cancelButtonProps={{ disabled: busy, 'aria-label': '取消恢复' }}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        onCancel={() => {
          if (preview) void bridge.cancelRestore(preview.previewId);
          setPreview(null);
        }}
        onOk={() => {
          if (preview)
            void run(
              () => bridge.confirmRestore(preview.previewId),
              () => {
                setNotice({
                  type: 'success',
                  message: '恢复完成，请重新启动服务。所有用户需要重新登录。',
                });
              },
            ).finally(() => setPreview(null));
        }}
      >
        {preview && (
          <>
            <Descriptions
              column={1}
              items={[
                {
                  key: 'time',
                  label: '备份时间',
                  children: new Date(preview.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  }),
                },
                { key: 'files', label: '附件数量', children: preview.fileCount },
                {
                  key: 'size',
                  label: '备份大小',
                  children: `${(preview.bytes / 1024 / 1024).toFixed(1)} MiB`,
                },
              ]}
            />
            <Alert
              type="warning"
              showIcon
              title="业务数据将恢复到备份时点，之后的修改不再显示。"
              description="当前授权和本机配置保留；旧登录会话失效。原数据会保留供维护回退。"
            />
          </>
        )}
      </Modal>
    </>
  );
}
