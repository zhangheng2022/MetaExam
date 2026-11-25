import { useCallback, useEffect, useState } from 'react';
import type { SystemStatus } from '@metaexam/contracts';
export interface DashboardProps {
  loadStatus: () => Promise<SystemStatus>;
  desktop?: boolean;
}
const labels = {
  unactivated: '未激活',
  valid: '授权有效',
  expired: '授权已到期',
  not_yet_valid: '尚未生效',
  invalid: '校验未通过',
  clock_anomaly: '系统时间异常',
};
export function Dashboard({ loadStatus, desktop = false }: DashboardProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await loadStatus());
      setError('');
    } catch {
      setError('暂时无法连接考试服务。请检查服务是否启动，然后重试。');
    } finally {
      setBusy(false);
    }
  }, [loadStatus]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15000);
    return () => clearInterval(id);
  }, [refresh]);
  const ready = !!status && status.database === 'ready' && status.worker === 'online';
  const unavailable = !!error && !status && !busy;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="./" aria-label="MetaExam 运行概览">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M5 25V7l11 10L27 7v18M11 25V18l5 5 5-5v7" />
          </svg>
          <span>
            MetaExam<small>本地考试管理</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <span className="nav-current" aria-current="page">
            运行概览
          </span>
        </nav>
        <p className="sidebar-note">
          数据留在本地
          <br />
          授权离线验证
        </p>
      </aside>
      <main>
        <header>
          <div>
            <h1>运行概览</h1>
            <p>检查服务状态，做好考试前的准备。</p>
          </div>
          <button onClick={() => void refresh()} disabled={busy}>
            {busy ? '检查中…' : '重新检查'}
          </button>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            {status && <span>以下为上次检查结果，可能已过时。</span>}
          </div>
        )}
        <section className="overview" aria-labelledby="service-heading">
          <div className="section-heading">
            <h2 id="service-heading">系统服务</h2>
            <span className={'badge ' + (error ? 'warn' : ready ? 'good' : 'warn')}>
              {error ? '连接中断' : !status ? '等待检查' : ready ? '运行正常' : '需要检查'}
            </span>
          </div>
          <div className="service-row">
            <div>
              <h3>考试服务</h3>
              <p>为局域网浏览器提供访问</p>
            </div>
            <strong>{error ? '连接失败' : status ? '已连接' : '检查中'}</strong>
          </div>
          <div className="service-row">
            <div>
              <h3>本地数据库</h3>
              <p>保存系统配置和业务数据</p>
            </div>
            <strong>
              {status?.database === 'ready'
                ? '已连接'
                : status
                  ? '连接失败'
                  : unavailable
                    ? '无法获取'
                    : '检查中'}
            </strong>
          </div>
          <div className="service-row">
            <div>
              <h3>后台任务</h3>
              <p>独立处理任务，不依赖管理窗口</p>
            </div>
            <strong>
              {status?.worker === 'online'
                ? '运行中'
                : status
                  ? '未运行'
                  : unavailable
                    ? '无法获取'
                    : '检查中'}
            </strong>
          </div>
        </section>
        <section className="license-section" aria-labelledby="license-heading">
          <div>
            <h2 id="license-heading">软件授权</h2>
            <p>在部署电脑上验证授权文件，无需连接互联网。</p>
          </div>
          <div className="license-status">
            <strong>
              {status ? labels[status.license.state] : unavailable ? '无法获取' : '正在读取'}
            </strong>
            <p>
              {status?.license.state === 'valid'
                ? status.license.expiresAt
                  ? '有效期至 ' + new Date(status.license.expiresAt).toLocaleDateString('zh-CN')
                  : '永久授权'
                : unavailable
                  ? '恢复服务连接后重新检查授权状态。'
                  : '请由本机维护人员导入有效授权文件。'}
            </p>
            {status?.license.maxConcurrentAttempts && (
              <p>授权同时作答人数：{status.license.maxConcurrentAttempts}</p>
            )}
          </div>
        </section>
        <section className="next-step">
          <h2>技术验证阶段</h2>
          <p>当前版本用于验证服务运行、数据库连接和本地授权，尚未开放正式考试。</p>
          {desktop && <p>关闭此窗口不会停止后台考试服务。</p>}
        </section>
        <footer>
          <span>
            {desktop ? '桌面管理程序' : '本机运行状态'} ·{' '}
            {status ? 'v' + status.version : 'MetaExam'}
          </span>
          <span aria-live="polite">
            {status
              ? '最近检查 ' + new Date(status.checkedAt).toLocaleTimeString('zh-CN')
              : unavailable
                ? '尚未获取检查结果'
                : '等待服务响应'}
          </span>
        </footer>
      </main>
    </div>
  );
}
