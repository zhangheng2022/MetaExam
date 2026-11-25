import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from '@metaexam/ui';
import {
  questionInputSchema,
  type QuestionContent,
  type QuestionDetail,
  type QuestionInput,
} from '@metaexam/contracts';
import { Editor } from '../management/common';
import { api } from '../api';
import { ImageEditor, QuestionImage } from './images';
export const typeOptions = [
  { value: 'single', label: '单选题' },
  { value: 'multiple', label: '多选题' },
  { value: 'boolean', label: '判断题' },
  { value: 'blank', label: '填空题' },
  { value: 'essay', label: '简答题' },
];
export const typeName = (type: string) => typeOptions.find((o) => o.value === type)?.label ?? type;
function initialContent(type: QuestionContent['type']): QuestionContent {
  if (type === 'single' || type === 'multiple')
    return {
      type,
      options: [
        { id: crypto.randomUUID(), text: '' },
        { id: crypto.randomUUID(), text: '' },
      ],
      answer: [],
    };
  if (type === 'boolean') return { type, answer: true };
  if (type === 'blank')
    return {
      type,
      blanks: [{ id: crypto.randomUUID(), answers: [''] }],
      caseSensitive: false,
      trimWhitespace: true,
    };
  return { type, referenceAnswer: '' };
}
function ContentEditor({
  value,
  onChange,
}: {
  value: QuestionContent;
  onChange?: (v: QuestionContent) => void;
}) {
  const [modal, holder] = Modal.useModal();
  const change = (v: QuestionContent) => onChange?.(v);
  return (
    <div className="question-fields">
      {holder}
      <div>
        <Typography.Paragraph>题型</Typography.Paragraph>
        <Select
          aria-label="题型"
          value={value.type}
          options={typeOptions}
          className="question-type"
          onChange={(type) => {
            if (type !== value.type)
              modal.confirm({
                title: '切换题型？',
                content: '当前选项和答案将被清空，题干与解析保留。',
                okText: '切换题型',
                cancelText: '保留当前题型',
                onOk: () => change(initialContent(type)),
              });
          }}
        />
      </div>
      {(value.type === 'single' || value.type === 'multiple') && (
        <>
          <Typography.Paragraph type="secondary">
            填写 2～8 个不同选项。
            {value.type === 'single'
              ? '选择一个正确答案。'
              : '至少选择两个正确答案，后续评分按全对得分。'}
          </Typography.Paragraph>
          {value.options.map((o, i) => (
            <div key={o.id} className="question-option">
              <Input.TextArea
                aria-label={`选项 ${String.fromCharCode(65 + i)}`}
                placeholder={`选项 ${String.fromCharCode(65 + i)}`}
                value={o.text}
                maxLength={2000}
                autoSize={{ minRows: 1, maxRows: 4 }}
                onChange={(e) =>
                  change({
                    ...value,
                    options: value.options.map((x) =>
                      x.id === o.id ? { ...x, text: e.target.value } : x,
                    ),
                  })
                }
              />
              <Button
                danger
                aria-label={`移除选项 ${String.fromCharCode(65 + i)}`}
                disabled={value.options.length <= 2}
                onClick={() =>
                  change({
                    ...value,
                    options: value.options.filter((x) => x.id !== o.id),
                    answer: value.answer.filter((id) => id !== o.id),
                  })
                }
              >
                移除
              </Button>
            </div>
          ))}
          <Button
            disabled={value.options.length >= 8}
            onClick={() =>
              change({
                ...value,
                options: [...value.options, { id: crypto.randomUUID(), text: '' }],
              })
            }
          >
            添加选项
          </Button>
          <div>
            <Typography.Paragraph>正确答案</Typography.Paragraph>
            <Select
              aria-label="正确答案"
              className="question-answer"
              mode={value.type === 'multiple' ? 'multiple' : undefined}
              value={value.type === 'multiple' ? value.answer : value.answer[0]}
              onChange={(v) => change({ ...value, answer: Array.isArray(v) ? v : [v] })}
              options={value.options.map((o, i) => ({
                value: o.id,
                label: `${String.fromCharCode(65 + i)}. ${o.text.slice(0, 60) || '待填写'}`,
              }))}
            />
          </div>
        </>
      )}
      {value.type === 'boolean' && (
        <Select
          aria-label="判断答案"
          value={value.answer ? 'true' : 'false'}
          options={[
            { value: 'true', label: '正确' },
            { value: 'false', label: '错误' },
          ]}
          onChange={(v) => change({ ...value, answer: v === 'true' })}
        />
      )}
      {value.type === 'blank' && (
        <>
          <Alert
            type="info"
            showIcon
            title="按空位顺序填写答案"
            description="在题干中用 [[blank]] 标记每个空位。每行一个可接受答案，空位与标记数量须相同。"
          />
          {value.blanks.map((b, i) => (
            <div key={b.id} className="question-option">
              <Input.TextArea
                aria-label={`第 ${i + 1} 空答案`}
                placeholder={`第 ${i + 1} 空答案，每行一个候选`}
                value={b.answers.join('\n')}
                onChange={(e) =>
                  change({
                    ...value,
                    blanks: value.blanks.map((x) =>
                      x.id === b.id ? { ...x, answers: e.target.value.split('\n') } : x,
                    ),
                  })
                }
                autoSize={{ minRows: 2, maxRows: 5 }}
              />
              <Button
                danger
                disabled={value.blanks.length <= 1}
                onClick={() =>
                  change({ ...value, blanks: value.blanks.filter((x) => x.id !== b.id) })
                }
              >
                移除空位
              </Button>
            </div>
          ))}
          <Button
            disabled={value.blanks.length >= 20}
            onClick={() =>
              change({
                ...value,
                blanks: [...value.blanks, { id: crypto.randomUUID(), answers: [''] }],
              })
            }
          >
            添加空位
          </Button>
          <Space wrap>
            <Switch
              checked={value.caseSensitive}
              onChange={(v) => change({ ...value, caseSensitive: v })}
              aria-label="区分大小写"
            />
            区分大小写
            <Switch
              checked={value.trimWhitespace}
              onChange={(v) => change({ ...value, trimWhitespace: v })}
              aria-label="忽略答案首尾空白"
            />
            忽略答案首尾空白
          </Space>
        </>
      )}
      {value.type === 'essay' && (
        <Input.TextArea
          aria-label="参考答案"
          placeholder="参考答案与评分要点；简答题后续人工评分"
          value={value.referenceAnswer}
          maxLength={8000}
          rows={5}
          onChange={(e) => change({ ...value, referenceAnswer: e.target.value })}
        />
      )}
    </div>
  );
}
export function QuestionEditor({
  bankId,
  detail,
  done,
  close,
}: {
  bankId: string;
  detail?: QuestionDetail;
  done: () => void;
  close: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [initial] = useState(
    () =>
      detail?.current.question ?? {
        stem: '',
        content: initialContent('single'),
        explanation: '',
        difficulty: 3,
        tags: [],
        knowledgePoints: [],
      },
  );
  return (
    <Editor
      externalBusy={uploading}
      size={720}
      title={detail ? '编辑题目 · 保存为新版本' : '录入题目'}
      initialValues={initial}
      close={close}
      done={done}
      save={async (values) => {
        const parsed = questionInputSchema.safeParse(values);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('；'));
        if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > 48000)
          throw new Error('题目内容过长，请缩短题干、选项或解析（总计不超过 48 KB）。');
        const url = `/question-banks/${bankId}/questions`;
        return detail
          ? api(url + '/' + detail.id, 'PATCH', {
              revision: detail.revision,
              question: parsed.data,
            })
          : api(url, 'POST', parsed.data);
      }}
    >
      <Form.Item name="stem" label="题干" rules={[{ required: true, message: '请填写题干' }]}>
        <Input.TextArea
          rows={4}
          maxLength={8000}
          showCount
          placeholder="输入题目正文；本批支持纯文本"
        />
      </Form.Item>
      <Form.Item name="content">
        <ContentEditor value={initial.content} />
      </Form.Item>
      <Form.Item name="images" label="题目图片">
        <ImageEditor bankId={bankId} onBusy={setUploading} />
      </Form.Item>
      <Form.Item name="difficulty" label="难度" rules={[{ required: true }]}>
        <Select
          options={[1, 2, 3, 4, 5].map((value) => ({
            value,
            label: `${value} · ${['容易', '较易', '中等', '较难', '困难'][value - 1]}`,
          }))}
        />
      </Form.Item>
      <Form.Item name="knowledgePoints" label="知识点" extra="输入后按回车添加，最多 10 个。">
        <Select mode="tags" maxCount={10} options={[]} />
      </Form.Item>
      <Form.Item name="tags" label="标签" extra="输入后按回车添加，最多 10 个。">
        <Select mode="tags" maxCount={10} options={[]} />
      </Form.Item>
      <Form.Item name="explanation" label="解析">
        <Input.TextArea rows={3} maxLength={8000} />
      </Form.Item>
    </Editor>
  );
}
export function QuestionPreview({
  question,
  bankId,
}: {
  question: QuestionInput;
  bankId?: string;
}) {
  const c = question.content;
  return (
    <div className="question-preview">
      <Space wrap>
        <Tag color="blue">{typeName(c.type)}</Tag>
        <Tag>难度 {question.difficulty}</Tag>
        {question.tags.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </Space>
      <Typography.Paragraph className="question-text">{question.stem}</Typography.Paragraph>
      {bankId &&
        question.images?.map((image) => (
          <QuestionImage key={image.id} bankId={bankId} {...image} />
        ))}
      {(c.type === 'single' || c.type === 'multiple') && (
        <>
          {c.options.map((o, i) => (
            <Typography.Paragraph key={o.id} className="question-text">
              {String.fromCharCode(65 + i)}. {o.text}
            </Typography.Paragraph>
          ))}
          <Card size="small" title="正确答案">
            {c.options
              .flatMap((o, i) => (c.answer.includes(o.id) ? [String.fromCharCode(65 + i)] : []))
              .join('、')}
          </Card>
        </>
      )}
      {c.type === 'boolean' && (
        <Card size="small" title="正确答案">
          {c.answer ? '正确' : '错误'}
        </Card>
      )}
      {c.type === 'blank' && (
        <Card size="small" title="填空答案">
          {c.blanks.map((b, i) => (
            <Typography.Paragraph key={b.id}>
              第 {i + 1} 空：{b.answers.join(' / ')}
            </Typography.Paragraph>
          ))}
          <Typography.Text type="secondary">
            {c.caseSensitive ? '区分' : '不区分'}大小写；{c.trimWhitespace ? '忽略' : '保留'}
            首尾空白
          </Typography.Text>
        </Card>
      )}
      {c.type === 'essay' && (
        <Card size="small" title="参考答案（人工评分）">
          <Typography.Paragraph className="question-text">{c.referenceAnswer}</Typography.Paragraph>
        </Card>
      )}
      <Card size="small" title="解析">
        <Typography.Paragraph className="question-text">
          {question.explanation || '暂无解析'}
        </Typography.Paragraph>
      </Card>
      {question.knowledgePoints.length > 0 && (
        <Typography.Paragraph>知识点：{question.knowledgePoints.join('、')}</Typography.Paragraph>
      )}
    </div>
  );
}
