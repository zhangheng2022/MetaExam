import { useEffect } from 'react';
import { useBlocker } from 'react-router';
import { Modal } from '@metaexam/ui';

export function UnsavedChangesGuard({ dirty, busy }: { dirty: boolean; busy: boolean }) {
  const blocker = useBlocker(dirty || busy);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  return (
    <Modal
      open={blocker.state === 'blocked'}
      title={busy ? '正在保存，请稍候' : '放弃尚未保存的修改？'}
      okText="放弃修改"
      cancelText="继续编辑"
      okButtonProps={{ disabled: busy }}
      onOk={() => {
        if (!busy && blocker.state === 'blocked') blocker.proceed();
      }}
      onCancel={() => {
        if (blocker.state === 'blocked') blocker.reset();
      }}
    >
      {busy ? '请等待操作完成后再离开。' : '离开后，尚未保存的修改将丢失。'}
    </Modal>
  );
}
