import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Table,
  type TableColumnsType,
} from '@metaexam/ui';
import type { PageResult } from '@metaexam/contracts';
import { api, RequestError } from '../api';
export const roleOptions = [
  { value: 'admin', label: '管理员' },
  { value: 'teacher', label: '教师' },
  { value: 'student', label: '学生' },
];
export const roleName = (v: string) => roleOptions.find((r) => r.value === v)?.label ?? v;
export const dateText = (v: string) =>
  new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function usePaged<T>(endpoint: string) {
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const [result, setResult] = useState<PageResult<T> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(true);
      setError('');
      try {
        const next = await api<PageResult<T>>(endpoint + '?' + query);
        if (active) setResult(next);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
    };
  }, [endpoint, query, version]);
  const filter = (values: Record<string, unknown>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined && value !== '') next.set(key, String(value));
    next.set('page', '1');
    next.set('pageSize', params.get('pageSize') ?? '20');
    setParams(next);
  };
  const pagination = {
    current: Number(params.get('page') ?? 1),
    pageSize: Number(params.get('pageSize') ?? 20),
    total: result?.total ?? 0,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
    showTotal: (total: number) => `共 ${total} 条`,
    onChange: (page: number, pageSize: number) => {
      const next = new URLSearchParams(params);
      next.set('page', String(page));
      next.set('pageSize', String(pageSize));
      setParams(next);
    },
  };
  return { params, result, error, busy, reload, filter, pagination };
}
export function Filters({
  list,
  users = false,
  status = true,
  children,
}: {
  list: ReturnType<typeof usePaged>;
  users?: boolean;
  status?: boolean;
  children?: ReactNode;
}) {
  return (
    <Form
      key={list.params.toString()}
      layout="inline"
      name="management-filters"
      className="management-filters"
      initialValues={Object.fromEntries(list.params)}
      onFinish={list.filter}
    >
      <Form.Item name="classId" hidden>
        <Input />
      </Form.Item>
      <Form.Item name="courseId" hidden>
        <Input />
      </Form.Item>
      <Form.Item name="q" label="搜索">
        <Input allowClear placeholder="输入名称或编码" maxLength={100} />
      </Form.Item>
      {users && (
        <Form.Item name="role" label="角色">
          <Select
            allowClear
            placeholder="全部角色"
            options={roleOptions}
            className="filter-select"
          />
        </Form.Item>
      )}
      {status && (
        <Form.Item name="enabled" label="状态">
          <Select
            allowClear
            placeholder="全部状态"
            className="filter-select"
            options={[
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ]}
          />
        </Form.Item>
      )}
      {children}
      <Space>
        <Button htmlType="submit">查询</Button>
        <Button onClick={() => list.filter({})}>重置</Button>
      </Space>
    </Form>
  );
}
export function DataTable<T extends object>({
  list,
  columns,
  rowKey = 'id',
}: {
  list: ReturnType<typeof usePaged<T>>;
  columns: TableColumnsType<T>;
  rowKey?: string | ((row: T) => string);
}) {
  return (
    <>
      {list.error && (
        <Alert
          className="identity-alert"
          showIcon
          type="error"
          title={list.error}
          description={list.result ? '以下为上次读取的数据，可能已过时。' : undefined}
          action={<Button onClick={list.reload}>重试</Button>}
        />
      )}
      <Table<T>
        rowKey={rowKey}
        columns={columns}
        dataSource={list.result?.items ?? []}
        loading={list.busy}
        pagination={list.pagination}
        scroll={{ x: 800 }}
        locale={{
          emptyText: (
            <Empty
              description={
                list.error
                  ? '无法读取数据'
                  : list.params.get('q') || list.params.get('role') || list.params.get('enabled')
                    ? '没有符合筛选条件的记录'
                    : '暂无记录'
              }
            />
          ),
        }}
      />
    </>
  );
}
export function Editor({
  title,
  initialValues,
  children,
  save,
  done,
  close,
  size = 480,
}: {
  title: string;
  initialValues?: object;
  children: ReactNode;
  save: (values: Record<string, unknown>) => Promise<unknown>;
  done: () => void;
  close: () => void;
  size?: number;
}) {
  const [form] = Form.useForm(),
    [modal, holder] = Modal.useModal();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [dirty, setDirty] = useState(false);
  const cancel = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: '放弃尚未保存的修改？',
        content: '关闭后需要重新填写。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: close,
      });
    else close();
  };
  return (
    <>
      {holder}
      <Drawer
        title={title}
        open
        size={size}
        onClose={cancel}
        closable={!busy}
        maskClosable={!busy}
        destroyOnHidden
        footer={
          <Space>
            <Button type="primary" loading={busy} onClick={() => form.submit()}>
              保存
            </Button>
            <Button disabled={busy} onClick={cancel}>
              取消
            </Button>
          </Space>
        }
      >
        {error && (
          <Alert
            type="error"
            showIcon
            role="alert"
            title={error}
            className="identity-alert"
            action={conflict ? <Button onClick={done}>关闭并重新加载</Button> : undefined}
          />
        )}
        <Form
          form={form}
          name="management-editor"
          layout="vertical"
          initialValues={initialValues}
          disabled={busy}
          clearOnDestroy
          onValuesChange={() => setDirty(true)}
          onFinish={async (values) => {
            setBusy(true);
            setError('');
            setConflict(false);
            try {
              await save(values);
              done();
            } catch (e) {
              setError((e as Error).message);
              setConflict(e instanceof RequestError && e.code === 'EDIT_CONFLICT');
            } finally {
              form.setFieldValue('password', undefined);
              setBusy(false);
            }
          }}
        >
          {children}
        </Form>
      </Drawer>
    </>
  );
}
export function RemotePicker({
  endpoint,
  value,
  onChange,
  id,
  enabledOnly = true,
}: {
  endpoint: string;
  value?: string;
  onChange?: (value: string) => void;
  id?: string;
  enabledOnly?: boolean;
}) {
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [items, setItems] = useState<{ value: string; label: string }[]>([]),
    [selected, setSelected] = useState<{ value: string; label: string }>(),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const result = await api<
          PageResult<{
            id: string;
            name?: string;
            code?: string;
            displayName?: string;
            username?: string;
          }>
        >(
          endpoint +
            (endpoint.includes('?') ? '&' : '?') +
            new URLSearchParams({
              ...(enabledOnly ? { enabled: 'true' } : {}),
              q: search,
              page: String(page),
              pageSize: '20',
            }),
        );
        if (active) {
          setItems(
            result.items.map((r) => ({
              value: r.id,
              label: `${r.displayName ?? r.name}（${r.username ?? r.code}）`,
            })),
          );
          setTotal(result.total);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setItems([]);
        }
      } finally {
        if (active) setBusy(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [endpoint, search, page, enabledOnly]);
  const options =
    selected && !items.some((i) => i.value === selected.value) ? [selected, ...items] : items;
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      showSearch={{
        filterOption: false,
        onSearch: (s: string) => {
          setSearch(s);
          setPage(1);
        },
      }}
      placeholder="搜索并选择"
      loading={busy}
      options={options}
      onSelect={(_, option) => setSelected(option)}
      notFoundContent={error || (busy ? '正在查询…' : '无可选记录')}
      popupRender={(menu) => (
        <>
          {menu}
          <Pagination
            simple
            size="small"
            current={page}
            pageSize={20}
            total={total}
            onChange={setPage}
          />
        </>
      )}
    />
  );
}
