import React, { useState, useEffect, createContext, useContext } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Phone, Settings, GitBranch, RotateCw, FileText,
  LogOut, Menu, X, ChevronRight
} from 'lucide-react';
import api from './hooks/api';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Agents from './pages/Agents';
import CallLogs from './pages/CallLogs';
import SourceRouting from './pages/SourceRouting';
import GlobalSettings from './pages/GlobalSettings';
import RetryQueue from './pages/RetryQueue';
import Login from './pages/Login';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    api.get('/api/v1/auth/me')
      .then(u => { setUser(u); localStorage.setItem('user', JSON.stringify(u)); })
      .catch(() => { setUser(null); localStorage.removeItem('token'); localStorage.removeItem('user'); })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const data = await api.post('/api/v1/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  if (loading) return (
    <div className="h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
    </div>
  );

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

const NAV = [
  { to: '/',             icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/leads',        icon: FileText,        label: 'Leads' },
  { to: '/agents',       icon: Users,           label: 'Agents' },
  { to: '/call-logs',    icon: Phone,           label: 'Call Logs' },
  { to: '/routing',      icon: GitBranch,       label: 'Source Routing' },
  { to: '/settings',     icon: Settings,        label: 'Global Settings' },
  { to: '/retry-queue',  icon: RotateCw,        label: 'Retry Queue' },
];

function Sidebar({ open, setOpen }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-surface-900 text-white flex flex-col
        transition-transform duration-200 lg:translate-x-0 lg:static lg:z-auto
        ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-5 border-b border-white/10">
          <div className="text-lg font-bold tracking-tight">Rupeek Dialer</div>
          <div className="text-xs text-surface-300 mt-0.5">Lead Routing System</div>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors
                ${isActive ? 'bg-brand-600 text-white font-medium' : 'text-surface-300 hover:bg-white/10 hover:text-white'}`
              }>
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center justify-between px-3 py-2">
            <div>
              <div className="text-sm font-medium">{user?.name || user?.email}</div>
              <div className="text-xs text-surface-300">{user?.role}</div>
            </div>
            <button onClick={() => { logout(); navigate('/login'); }}
              className="p-1.5 rounded-lg hover:bg-white/10 text-surface-300 hover:text-white transition-colors">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" />;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} setOpen={setSidebarOpen} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex items-center gap-3 px-4 border-b bg-white shrink-0 lg:px-6">
          <button className="lg:hidden p-1.5 rounded-lg hover:bg-surface-100" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="text-sm text-surface-500 flex items-center gap-1">
            <span className="hidden sm:inline">Lead Routing</span>
            <ChevronRight size={14} className="hidden sm:inline" />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/leads/:leadId" element={<LeadDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/call-logs" element={<CallLogs />} />
            <Route path="/routing" element={<SourceRouting />} />
            <Route path="/settings" element={<GlobalSettings />} />
            <Route path="/retry-queue" element={<RetryQueue />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<Layout />} />
      </Routes>
    </AuthProvider>
  );
}
