import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

export function startPostgres(bin, data, port) {
  // Keep WinSW's console Ctrl+C away from PostgreSQL and its backend processes.
  // The supervisor remains attached and owns the explicit pg_ctl shutdown.
  return spawn(
    path.join(bin, 'postgres.exe'),
    ['-D', data, '-h', '127.0.0.1', '-p', String(port)],
    { stdio: 'inherit', windowsHide: true, detached: true },
  );
}

export function installPostgresShutdown(child, bin, data) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    execFile(
      path.join(bin, 'pg_ctl.exe'),
      ['-D', data, 'stop', '-m', 'fast', '-w', '-t', '45'],
      { windowsHide: true, timeout: 50000 },
      (error) => {
        if (error && child.exitCode === null) console.error('DATABASE_STOP_FAILED');
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
