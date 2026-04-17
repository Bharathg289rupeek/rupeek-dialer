import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { TrendingUp, PhoneCall, Clock, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import api from '../hooks/api';

const STAT_CARDS = [
  { key: 'total_leads',  label: 'Total Leads',  icon: PhoneCall,     color: 'text-brand-600',   bg: 'bg-brand-50' },
  { key: 'connected',    label: 'Connected',     icon: CheckCircle,   color: 'text-emerald-600', bg: 'bg-emerald-50' },
  { key: 'in_progress',  label: 'In Progress',   icon: TrendingUp,    color: 'text-blue-600',    bg: 'bg-blue-50' },
  { key: 'queued',       label: 'Queued',         icon: Clock,         color: 'text-amber-600',   bg: 'bg-amber-50' },
  { key: 'failed',       label: 'Failed',         icon: XCircle,       color: 'text-red-600',     bg: 'bg-red-50' },
  { key: 'utm_created',  label: 'UTM Fallback',   icon: AlertTriangle, color: 'text-purple-600',  bg: 'bg-purple-50' },
];

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    try {
      const data = await api.get('/api/v1/dashboard/stats');
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, []);

  if (loading) return <PageLoader />;

  const summary = stats?.summary || {};
  const hourlyData = (stats?.hourly || []).map(h => ({
    hour: `${String(Math.round(h.hour)).padStart(2, '0')}:00`,
    Connected: parseInt(h.connected) || 0,
    'RM No Answer': parseInt(h.rm_no_answer) || 0,
    Failed: parseInt(h.failed) || 0,
    Total: parseInt(h.total) || 0,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <span className="text-xs text-surface-400">Auto-refreshes every 30s</span>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {STAT_CARDS.map(({ key, label, icon: Icon, color, bg }) => (
          <div key={key} className="card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className={`p-1.5 rounded-lg ${bg}`}><Icon size={16} className={color} /></div>
            </div>
            <div className="text-2xl font-bold">{parseInt(summary[key]) || 0}</div>
            <div className="text-xs text-surface-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Hourly Chart */}
        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold mb-4">Calls by Hour (Today)</h2>
          {hourlyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={hourlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Connected" fill="#10b981" radius={[2,2,0,0]} />
                <Bar dataKey="RM No Answer" fill="#f59e0b" radius={[2,2,0,0]} />
                <Bar dataKey="Failed" fill="#ef4444" radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-surface-400 text-sm">No data yet today</div>
          )}
        </div>

        {/* Disposition Breakdown */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Dispositions</h2>
          <div className="space-y-2.5">
            {(stats?.dispositions || []).map(d => {
              const total = stats.dispositions.reduce((s, x) => s + parseInt(x.count), 0);
              const pct = total > 0 ? ((parseInt(d.count) / total) * 100).toFixed(1) : 0;
              return (
                <div key={d.disposition}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-surface-600 font-mono">{d.disposition}</span>
                    <span className="font-medium">{d.count}</span>
                  </div>
                  <div className="h-1.5 bg-surface-100 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            {(stats?.dispositions || []).length === 0 && (
              <div className="text-surface-400 text-sm">No calls yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Source Breakdown & Pending Retries */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Leads by Source</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Total</th>
                  <th>Connected</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.sources || []).map(s => (
                  <tr key={s.lead_source}>
                    <td><span className="badge-blue">{s.lead_source}</span></td>
                    <td>{s.count}</td>
                    <td>{s.connected}</td>
                    <td>{s.count > 0 ? ((s.connected / s.count) * 100).toFixed(1) : 0}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Pending Retries</h2>
          <div className="text-4xl font-bold text-amber-600">{stats?.pending_retries || 0}</div>
          <p className="text-sm text-surface-500 mt-1">calls scheduled for retry</p>
        </div>
      </div>
    </div>
  );
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
    </div>
  );
}
