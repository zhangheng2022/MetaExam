import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from '@metaexam/ui';
import type {
  CurrentUser,
  PageResult,
  QuestionBank,
  QuestionDetail,
  QuestionSummary,
  QuestionVersion,
} from '@metaexam/contracts';
import { api } from '../api';
import { DataTable, Editor, RemotePicker, dateText, usePaged } from '../management/common';
import { QuestionEditor, QuestionPreview, typeName, typeOptions } from './editor';
import { ImportManager } from './imports';
function BankEditor({
  bank,
  user,
  done,
  close,
}: {
  bank?: QuestionBank;
  user: CurrentUser;
  done: () => void;
  close: () => void;
}) {
  return (
    <Editor
      title={bank ? '编辑题库' : '创建题库'}
      initialValues={
        bank ?? { visibility: user.roles.includes('admin') ? 'public' : 'private', description: '' }
      }
      close={close}
      done={done}
      save={(v) =>
        api(
          '/question-banks' + (bank ? '/' + bank.id : ''),
          bank ? 'PATCH' : 'POST',
          bank
            ? {
                name: v.name,
                description: v.description,
                archived: v.archived,
                revision: bank.revision,
              }
            : v,
        )
      }
    >
      <Form.Item
        name="name"
        label="题库名称"
        rules={[{ required: true, whitespace: true, message: '请填写名称' }]}
      >
        <Input maxLength={100} placeholder="请输入题库名称" />
      </Form.Item>
      {!bank && (
        <>
          <Form.Item
            name="courseId"
            label="所属课程"
            rules={[{ required: true, message: '请选择课程' }]}
          >
            <RemotePicker
              placeholder="搜索并选择课程"
              endpoint="/question-banks/courses"
              enabledOnly={false}
            />
          </Form.Item>
          <Form.Item
            name="visibility"
            label="可见范围"
            extra="公共题库对该课程任课教师可读；个人题库由本人维护，管理员可管理。"
          >
            <Select
              placeholder="请选择可见范围"
              options={[
                ...(user.roles.includes('admin') ? [{ value: 'public', label: '公共题库' }] : []),
                { value: 'private', label: '个人题库' },
              ]}
            />
          </Form.Item>
        </>
      )}
      <Form.Item name="description" label="说明">
        <Input.TextArea maxLength={500} rows={3} placeholder="选填，说明题库用途或适用范围" />
      </Form.Item>
      {bank && (
        <Form.Item
          name="archived"
          label="归档"
          valuePropName="checked"
          extra="归档后保留题目和历史版本，恢复后可继续维护。"
        >
          <Switch />
        </Form.Item>
      )}
    </Editor>
  );
}
export function BanksPage({ user }: { user: CurrentUser }) {
  const { bankId } = useParams();
  return bankId ? <BankDetail key={bankId} bankId={bankId} /> : <BankList user={user} />;
}
function BankList({ user }: { user: CurrentUser }) {
  const list = usePaged<QuestionBank>('/question-banks');
  const [edit, setEdit] = useState<QuestionBank | 'new' | null>(null);
  return (
    <Card
      title="课程题库"
      extra={
        <Button type="primary" onClick={() => setEdit('new')}>
          创建题库
        </Button>
      }
    >
      <Form
        key={list.params.toString()}
        name="banks-filter"
        layout="inline"
        className="management-filters"
        initialValues={Object.fromEntries(list.params)}
        onFinish={list.filter}
      >
        <Form.Item name="q" label="搜索">
          <Input maxLength={100} allowClear placeholder="题库名称或说明" />
        </Form.Item>
        <Form.Item name="visibility" label="范围">
          <Select
            className="filter-select"
            allowClear
            placeholder="全部"
            options={[
              { value: 'public', label: '公共题库' },
              { value: 'private', label: '个人题库' },
            ]}
          />
        </Form.Item>
        <Form.Item name="archived" label="状态">
          <ArchiveSelect />
        </Form.Item>
        <Button htmlType="submit">查询</Button>
        <Button onClick={() => list.filter({})}>重置</Button>
      </Form>
      <DataTable
        list={list}
        columns={[
          {
            title: '题库名称',
            dataIndex: 'name',
            render: (v: string, r) => <Link to={'/question-banks/' + r.id}>{v}</Link>,
          },
          { title: '所属课程', dataIndex: 'courseName' },
          {
            title: '范围',
            dataIndex: 'visibility',
            render: (v) => (v === 'public' ? '公共' : '个人'),
          },
          { title: '创建人', dataIndex: 'ownerName' },
          { title: '可用题数', dataIndex: 'questionCount' },
          {
            title: '状态',
            render: (_, r) => (r.archived ? '已归档' : !r.courseEnabled ? '课程停用' : '使用中'),
          },
          {
            title: '操作',
            render: (_, r) => (
              <Space>
                <Link to={'/question-banks/' + r.id}>查看题目</Link>
                {r.canEdit && r.courseEnabled && (
                  <Button type="link" onClick={() => setEdit(r)}>
                    编辑题库
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      {edit && (
        <BankEditor
          bank={edit === 'new' ? undefined : edit}
          user={user}
          close={() => setEdit(null)}
          done={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
    </Card>
  );
}
function ArchiveSelect(props: { value?: string; onChange?: (v: string) => void; id?: string }) {
  return (
    <Select
      {...props}
      className="filter-select"
      allowClear
      placeholder="全部"
      options={[
        { value: 'false', label: '使用中' },
        { value: 'true', label: '已归档' },
      ]}
    />
  );
}
function BankDetail({ bankId }: { bankId: string }) {
  const [imports, setImports] = useState(false);
  const list = usePaged<QuestionSummary>(`/question-banks/${bankId}/questions`);
  const [bank, setBank] = useState<QuestionBank>(),
    [error, setError] = useState(''),
    [load, setLoad] = useState(0),
    [edit, setEdit] = useState<QuestionDetail | 'new' | null>(null),
    [view, setView] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [modal, holder] = Modal.useModal();
  useEffect(() => {
    let active = true;
    void api<QuestionBank>('/question-banks/' + bankId)
      .then((b) => {
        if (active) {
          setBank(b);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [bankId, load]);
  const reload = () => {
    setLoad((v) => v + 1);
    list.reload();
  };
  const writable = bank?.canEdit && !bank.archived && bank.courseEnabled;
  return (
    <>
      {holder}
      <div className="management-toolbar">
        <Button onClick={() => setImports(true)}>Excel 导入与记录</Button>
      </div>
      {imports && (
        <ImportManager
          bankId={bankId}
          writable={!!writable}
          changed={reload}
          close={() => setImports(false)}
        />
      )}
      <div className="management-toolbar">
        <Link to="/question-banks">返回题库列表</Link>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={reload}>重试</Button>}
          className="identity-alert"
        />
      )}
      {!bank && !error ? (
        <Skeleton />
      ) : (
        bank && (
          <Card
            title={bank.name}
            extra={
              writable && (
                <Button type="primary" disabled={busy} onClick={() => setEdit('new')}>
                  录入题目
                </Button>
              )
            }
          >
            <Typography.Paragraph type="secondary">
              {bank.courseName} · {bank.visibility === 'public' ? '公共题库' : '个人题库'} ·{' '}
              {bank.description || '暂无说明'}
            </Typography.Paragraph>
            {!writable && (
              <Alert
                type="info"
                showIcon
                title={
                  bank.archived ? '题库已归档' : !bank.courseEnabled ? '课程已停用' : '只读题库'
                }
                description="可以查看题目与版本历史。"
                className="identity-alert"
              />
            )}
            <Form
              key={list.params.toString()}
              name="questions-filter"
              layout="inline"
              className="management-filters"
              initialValues={Object.fromEntries(list.params)}
              onFinish={list.filter}
            >
              <Form.Item name="q" label="搜索">
                <Input maxLength={100} allowClear placeholder="题干关键词" />
              </Form.Item>
              <Form.Item name="type" label="题型">
                <Select
                  className="filter-select"
                  allowClear
                  placeholder="全部"
                  options={typeOptions}
                />
              </Form.Item>
              <Form.Item name="difficulty" label="难度">
                <Select
                  className="filter-select"
                  allowClear
                  placeholder="全部"
                  options={[1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: String(v) }))}
                />
              </Form.Item>
              <Form.Item name="tag" label="标签">
                <Input maxLength={40} allowClear placeholder="完整标签" />
              </Form.Item>
              <Form.Item name="knowledgePoint" label="知识点">
                <Input maxLength={80} allowClear placeholder="完整知识点" />
              </Form.Item>
              <Form.Item name="archived" label="状态">
                <ArchiveSelect />
              </Form.Item>
              <Button htmlType="submit">查询</Button>
              <Button onClick={() => list.filter({})}>重置</Button>
            </Form>
            <DataTable
              list={list}
              columns={[
                { title: '题干', dataIndex: 'stem', width: 320, ellipsis: true },
                { title: '题型', dataIndex: 'type', render: typeName },
                { title: '难度', dataIndex: 'difficulty' },
                { title: '版本', dataIndex: 'version', render: (v) => 'V' + v },
                { title: '状态', dataIndex: 'archived', render: (v) => (v ? '已归档' : '使用中') },
                {
                  title: '操作',
                  width: 260,
                  render: (_, r) => (
                    <Space wrap>
                      <Button type="link" onClick={() => setView(r.id)}>
                        预览与历史
                      </Button>
                      {writable && (
                        <>
                          {!r.archived && (
                            <Button
                              type="link"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  setEdit(
                                    await api<QuestionDetail>(
                                      `/question-banks/${bankId}/questions/${r.id}`,
                                    ),
                                  );
                                } catch (e) {
                                  setError((e as Error).message);
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              编辑
                            </Button>
                          )}
                          <Button
                            type="link"
                            disabled={busy}
                            onClick={() =>
                              modal.confirm({
                                title: r.archived ? '恢复这道题目？' : '归档这道题目？',
                                content: '保留题目与历史版本，归档题目不能继续编辑。',
                                okText: r.archived ? '恢复' : '归档',
                                cancelText: '取消',
                                onOk: async () => {
                                  try {
                                    await api(
                                      `/question-banks/${bankId}/questions/${r.id}/archive`,
                                      'POST',
                                      { revision: r.revision, archived: !r.archived },
                                    );
                                    reload();
                                  } catch (e) {
                                    setError((e as Error).message);
                                    throw e;
                                  }
                                },
                              })
                            }
                          >
                            {r.archived ? '恢复' : '归档'}
                          </Button>
                        </>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        )
      )}
      {edit && (
        <QuestionEditor
          bankId={bankId}
          detail={edit === 'new' ? undefined : edit}
          close={() => setEdit(null)}
          done={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
      {view && <History key={view} bankId={bankId} id={view} close={() => setView(null)} />}
    </>
  );
}
function History({ bankId, id, close }: { bankId: string; id: string; close: () => void }) {
  const [page, setPage] = useState(1),
    [result, setResult] = useState<PageResult<QuestionVersion>>(),
    [selected, setSelected] = useState<QuestionVersion>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(true);
      setError('');
      try {
        const r = await api<PageResult<QuestionVersion>>(
          `/question-banks/${bankId}/questions/${id}/versions?page=${page}&pageSize=10`,
        );
        if (active) {
          setResult(r);
          setSelected(r.items[0]);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setResult(undefined);
          setSelected(undefined);
        }
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
    };
  }, [bankId, id, page, retry]);
  return (
    <Drawer title="题目预览与版本历史" open size={800} onClose={close} destroyOnHidden>
      {error && (
        <Alert
          showIcon
          type="error"
          title={error}
          action={<Button onClick={() => setRetry((v) => v + 1)}>重试</Button>}
        />
      )}
      <Table<QuestionVersion>
        rowKey="id"
        size="small"
        loading={busy}
        dataSource={result?.items ?? []}
        pagination={false}
        columns={[
          {
            title: '版本',
            dataIndex: 'version',
            render: (v: number, r) => (
              <Button type="link" onClick={() => setSelected(r)}>
                查看 V{v}
              </Button>
            ),
          },
          { title: '编辑人', dataIndex: 'authorName' },
          { title: '保存时间（北京）', dataIndex: 'createdAt', render: dateText },
        ]}
      />
      <Pagination
        size="small"
        current={page}
        total={result?.total ?? 0}
        pageSize={10}
        showSizeChanger={false}
        onChange={setPage}
      />
      {selected && (
        <div className="question-history">
          <Typography.Title level={4}>
            V{selected.version} <Tag>历史内容保留</Tag>
          </Typography.Title>
          <QuestionPreview bankId={bankId} question={selected.question} />
        </div>
      )}
    </Drawer>
  );
}
