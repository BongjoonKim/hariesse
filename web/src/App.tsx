import { useCallback, useEffect, useState } from 'react';
import { UnauthorizedError, api, type Me } from './api';
import Today from './Today';
import Routines from './Routines';

const LOGIN_ERROR: Record<string, string> = {
  state: '로그인 요청이 만료됐어요. 다시 시도해 주세요.',
  exchange: 'Google 인증에 실패했어요.',
  email: '이메일을 확인할 수 없는 계정이에요.',
  forbidden: '허용되지 않은 계정입니다.',
};

type Tab = 'today' | 'routines';

export default function App() {
  // undefined = 확인 중, null = 로그인 필요
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('today');
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('login');
    if (reason) {
      setNotice(LOGIN_ERROR[reason] ?? '로그인에 실패했어요.');
      window.history.replaceState({}, '', window.location.pathname);
    }
    api
      .me()
      .then(setMe)
      .catch((err) => {
        setMe(null);
        if (!(err instanceof UnauthorizedError)) setNotice((err as Error).message);
      });
  }, []);

  const onUnauthorized = useCallback(() => {
    setMe(null);
    setNotice('세션이 만료됐어요. 다시 로그인해 주세요.');
  }, []);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
  };

  if (me === undefined) {
    return <p className="empty-state">불러오는 중…</p>;
  }

  if (me === null) {
    return (
      <div className="login">
        <h1>hariesse</h1>
        <p>주간 루틴을 등록하면 매일 9시·12시·8시에 텔레그램으로 챙겨줍니다.</p>
        {notice && <div className="banner">{notice}</div>}
        <a className="btn primary" href="/api/auth/login">
          Google로 로그인
        </a>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <h1>hariesse</h1>
        <span className="spacer" />
        <span className="who">{me.email}</span>
        <button className="btn ghost" onClick={logout}>
          로그아웃
        </button>
      </header>

      <nav className="tabs">
        <button aria-current={tab === 'today'} onClick={() => setTab('today')}>
          오늘
        </button>
        <button aria-current={tab === 'routines'} onClick={() => setTab('routines')}>
          주간 루틴
        </button>
      </nav>

      {notice && <div className="banner">{notice}</div>}

      {tab === 'today' ? (
        <Today today={me.today} onUnauthorized={onUnauthorized} />
      ) : (
        <Routines onUnauthorized={onUnauthorized} />
      )}
    </div>
  );
}
