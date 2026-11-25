import { useState } from 'react';
import { Alert, Button, Input, Space, Typography, Upload } from '@metaexam/ui';
import type { ImageAttachment, QuestionInput } from '@metaexam/contracts';
import { api } from '../api';
export const imageUrl = (bankId: string, id: string) =>
  `/api/v1/question-banks/${bankId}/attachments/${id}/content`;
export function QuestionImage({ bankId, id, alt }: { bankId: string; id: string; alt: string }) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  return failed ? (
    <Alert
      type="warning"
      showIcon
      title="图片暂时无法读取"
      description={alt}
      action={
        <Button
          onClick={() => {
            setFailed(false);
            setRetry((x) => x + 1);
          }}
        >
          重试图片
        </Button>
      }
    />
  ) : (
    <img
      className="question-image"
      src={imageUrl(bankId, id) + '?retry=' + retry}
      alt={alt}
      onError={() => setFailed(true)}
    />
  );
}
export function ImageEditor({
  bankId,
  value = [],
  onChange,
  onBusy,
}: {
  bankId: string;
  value?: QuestionInput['images'];
  onChange?: (v: QuestionInput['images']) => void;
  onBusy: (v: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const upload = async (file: File) => {
    if (busy) return;
    if (
      value.length >= 6 ||
      file.size > 2 * 1024 * 1024 ||
      !['image/png', 'image/jpeg'].includes(file.type)
    ) {
      setError('最多 6 张图片，每张不超过 2 MiB，仅支持 PNG/JPEG。');
      return;
    }
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api<ImageAttachment>(
        `/question-banks/${bankId}/attachments`,
        'POST',
        form,
      );
      onChange?.([...value, { id: result.id, alt: file.name.slice(0, 200) }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <div className="question-fields">
      {error && <Alert type="error" title={error} showIcon />}
      {value.map((item, i) => (
        <div className="question-image-editor" key={item.id}>
          <QuestionImage bankId={bankId} {...item} />
          <Space.Compact block>
            <Input
              aria-label={`图片 ${i + 1} 说明`}
              value={item.alt}
              maxLength={200}
              onChange={(e) =>
                onChange?.(value.map((v) => (v.id === item.id ? { ...v, alt: e.target.value } : v)))
              }
              disabled={busy}
            />
            <Button
              disabled={busy}
              danger
              onClick={() => onChange?.(value.filter((v) => v.id !== item.id))}
            >
              移除图片
            </Button>
          </Space.Compact>
        </div>
      ))}
      <Upload
        accept="image/png,image/jpeg"
        showUploadList={false}
        maxCount={1}
        disabled={busy || value.length >= 6}
        beforeUpload={(file) => {
          void upload(file);
          return false;
        }}
      >
        <Button loading={busy} disabled={value.length >= 6}>
          上传题目图片
        </Button>
      </Upload>
      <Typography.Text type="secondary">
        最多 6 张，仅 PNG/JPEG，每张 2 MiB、800
        万像素以内。上传后保存题目才会关联到新版本；移除不会删除历史版本图片。
      </Typography.Text>
    </div>
  );
}
