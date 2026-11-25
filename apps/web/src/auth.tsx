import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type PropsWithChildren,
} from 'react';
import type { CurrentUser } from '@metaexam/contracts';
import { api, RequestError } from './api';
interface Auth {
  user: CurrentUser | null;
  loading: boolean;
  error: string;
  expired: boolean;
  notice: string;
  setNotice: (value: string) => void;
  refresh: () => Promise<void>;
  setUser: (u: CurrentUser | null) => void;
}
const AuthContext = createContext<Auth | null>(null);
export function AuthProvider({ children }: PropsWithChildren) {
  const [user, updateUser] = useState<CurrentUser | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false),
    [notice, setNotice] = useState('');
  const authenticated = useRef(false);
  const setUser = useCallback((value: CurrentUser | null) => {
    authenticated.current = !!value;
    if (value) setExpired(false);
    updateUser(value);
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await api<CurrentUser>('/auth/me'));
      setError('');
      setExpired(false);
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) {
        setUser(null);
        setError('');
      } else setError(e instanceof Error ? e.message : '暂时无法读取账号，请重试。');
    } finally {
      setLoading(false);
    }
  }, [setUser]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return refresh();
    });
    const expired = () => {
      const wasAuthenticated = authenticated.current;
      setUser(null);
      setError('');
      setExpired(wasAuthenticated);
    };
    window.addEventListener('metaexam:session-expired', expired);
    return () => {
      active = false;
      window.removeEventListener('metaexam:session-expired', expired);
    };
  }, [refresh, setUser]);
  return (
    <AuthContext.Provider
      value={{ user, loading, error, expired, refresh, setUser, notice, setNotice }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider required');
  return auth;
}
