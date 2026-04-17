import React, { useState, useEffect, useCallback } from 'react';
import { RotateCw, X, Play, Clock } from 'lucide-react';
import api from '../hooks/api';

export default function RetryQueue() {
  const [data, setData] = useState({ retries: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');

  const fetchRetries = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: 50 });
      if (statusFilter) qs.set('status', statusFilter);
      const res = await api.get(`/api/v1/retry-queue?${qs}`);
      setData(res);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { fetchRetries(); }, [fetchRetries]);
  useEffect(() => {
    if (statusFilter === 'pending') {
      const iv = setInterval(fetchRetries, 15000);
      return () => clearInterval(iv);
    }
  }, [statusFilter, fetchRetries]);

  const triggerNow = async (id) => {
    try {
      await api.post(`/api/v1/retry-queue/${id}/trigger`);
      fetchRetries();
    } catch (err) { alert(err.message); }
  };

  const cancelRetry = async (id) => {
    if (!confirm('Cancel this retry?')) return;
    try {
      await api.delete(`/api/v1/retry-queue/${id}`);
      fetchRetries();
    } catch (err) { alert(err.message); }
  };

  const pendingCount = data.retries.filter(r => r.status === 'pending').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold">Retry Queue</h1>
          <p className="text-sm text-surface-500 mt-0.5">
            {statusFilter === 'pending' ? `${pendingCount} pending retries • auto-refreshes every 15s` : `${data.total} total records`}
          </p>
        </div>
        <button className="btn-secondary btn-sm" onClick={fetchRetries}>
          <RotateCw size={14} /> Refresh
        </button>
      </div>

      <div className="flex gap-2">
        {['pending', 'processing', 'completed', 'exhausted', ''].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
              ${statusFilter === s ? 'bg-brand-600 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Lead ID</th>
              <th>Customer</th>
              <th>Type</th>
              <th>Attempt</th>
              <th>Scheduled At</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : data.retries.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-surface-400">
                {statusFilter === 'pending' ? 'No pending retries' : 'No records found'}
              </td></tr>
            ) : data.retries.map(r => {
              const isPast = new Date(r.scheduled_at) <= new Date();
              const isPending = r.status === 'pending';
              return (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.lead_id}</td>
                  <td>
                    <div className="text-sm">{r.customer_name || '—'}</div>
                    <div className="text-xs text-surface-400">{r.customer_phone} • {r.city || '—'}</div>
                  </td>
                  <td>
                    <span className={r.retry_type === 'rm_no_answer' ? 'badge-yellow' : 'badge-blue'}>
                      {r.retry_type === 'rm_no_answer' ? 'RM No Answer' : 'CX No Answer'}
                    </span>
                  </td>
                  <td>
                    <span className="font-medium">{r.attempt_number}</span>
                    <span className="text-surface-400"> / {r.max_attempts}</span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <Clock size={12} className={isPast && isPending ? 'text-amber-500' : 'text-surface-400'} />
                      <span className={`text-xs ${isPast && isPending ? 'text-amber-600 font-medium' : ''}`}>
                        {new Date(r.scheduled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </span>
                    </div>
                    {isPast && isPending && (
                      <div className="text-xs text-amber-500 mt-0.5">overdue — will process shortly</div>
                    )}
                  </td>
                  <td>
                    <span className={
                      r.status === 'pending' ? 'badge-yellow' :
                      r.status === 'processing' ? 'badge-blue' :
                      r.status === 'exhausted' ? 'badge-red' : 'badge-green'
                    }>{r.status}</span>
                  </td>
                  <td>
                    {isPending && (
                      <div className="flex gap-1">
                        <button className="btn-secondary btn-sm" onClick={() => triggerNow(r.id)} title="Trigger now">
                          <Play size={12} />
                        </button>
                        <button className="p-1.5 rounded hover:bg-red-50 text-red-500" onClick={() => cancelRetry(r.id)} title="Cancel">
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
