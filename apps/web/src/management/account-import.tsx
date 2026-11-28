import { useState } from 'react';
import { Alert, Button, Modal, Space, Table, Typography, Upload } from '@metaexam/ui';
import type { AccountImportPreview, AccountImportResult } from '@metaexam/contracts';
import { api, apiResponse } from '../api';
import { dateText } from './common';

export function AccountImport({ done }: { done: () => void }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AccountImportPreview>();
  const [error, setError] = useState(''),
    [result, setResult] = useState<AccountImportResult>();
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () =>
    void run(async () => {
      if (preview) await api('/admin/account-imports/' + preview.id, 'DELETE');
      setPreview(undefined);
      setResult(undefined);
      setOpen(false);
    });
  return (
    <>
      <Button onClick={() => setOpen(true)}>批量导入</Button>
      <Modal
        open={open}
        title="账号与班级成员导入"
        width={960}
        onCancel={close}
        closable={!busy}
        maskClosable={!busy}
        footer={
          <Space>
            <Button disabled={busy} onClick={close}>
              关闭
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={
                busy || !preview || !!result || preview.rows.some((r) => r.errors.length > 0)
              }
              onClick={() =>
                void run(async () => {
                  const value = await api<AccountImportResult>(
                    '/admin/account-imports/' + preview!.id + '/confirm',
                    'POST',
                  );
                  setResult(value);
                  done();
                })
              }
            >
              确认导入
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          先下载模板。新账号首次登录须修改密码；已有账号密码留空，仅加入现有班级，不覆盖姓名、密码或角色。
        </Typography.Paragraph>
        <Space wrap className="identity-alert">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const response = await apiResponse('/admin/account-imports/template');
                const url = URL.createObjectURL(await response.blob());
                const a = document.createElement('a');
                a.href = url;
                a.download = '账号导入模板.xlsx';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            下载账号模板
          </Button>
          <Upload
            accept=".xlsx"
            showUploadList={false}
            disabled={busy}
            beforeUpload={(file) => {
              void run(async () => {
                if (preview) await api('/admin/account-imports/' + preview.id, 'DELETE');
                setPreview(undefined);
                setResult(undefined);
                if (file.size > 2 * 1024 * 1024) throw new Error('文件不能超过 2 MiB');
                const form = new FormData();
                form.append('file', file);
                const response = await apiResponse('/admin/account-imports', 'POST', form, 120000);
                setPreview((await response.json()) as AccountImportPreview);
              });
              return false;
            }}
          >
            <Button loading={busy} disabled={busy}>
              上传并预检
            </Button>
          </Upload>
        </Space>
        {error && (
          <Alert role="alert" type="error" showIcon title={error} className="identity-alert" />
        )}
        {result && (
          <Alert
            type="success"
            showIcon
            title={`导入完成：新建 ${result.created} 个账号，加入 ${result.added} 个班级成员，跳过 ${result.skipped} 行。`}
            className="identity-alert"
          />
        )}
        {preview && (
          <>
            <Typography.Paragraph>
              共 {preview.rows.length} 行；预检有效期至 {dateText(preview.expiresAt)}
              。存在错误时整批不能导入。
            </Typography.Paragraph>
            <Table
              rowKey="row"
              size="small"
              dataSource={preview.rows}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 800 }}
              columns={[
                { title: '源行', dataIndex: 'row', width: 72 },
                { title: '用户名', dataIndex: 'username' },
                { title: '姓名', dataIndex: 'displayName' },
                {
                  title: '角色',
                  render: (_, r) =>
                    r.role === 'student' ? '学生' : r.role === 'teacher' ? '教师' : '无效角色',
                },
                { title: '班级编码', dataIndex: 'classCode' },
                {
                  title: '预检结果',
                  render: (_, r) =>
                    r.errors.length
                      ? r.errors.join('；')
                      : { create: '新建账号', member: '加入班级', skip: '已有记录，跳过' }[
                          r.action
                        ],
                },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
