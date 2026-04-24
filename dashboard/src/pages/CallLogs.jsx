import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { Play, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../hooks/api';

const DISP_COLOR = {
  RM_CONNECTED:             'badge-green',
  RM_NO_ANSWER_CALLCENTER:  'badge-purple',
  CALLCENTER_NO_ANSWER:     'badge-orange',
  CUSTOMER_NOT_PICKED:      'badge-blue',
  CX_DROP_VOICEBOT:         'badge-yellow',
  INVALID_NUMBER:           'badge-red',
  CALL_FAILED:              'badge-red',
  INITIATED:                'badge-gray',
  // historical
  RM_NO_ANSWER:             'badge-yellow',
  UTM_LEAD_CREATED:         'badge-purple',
  INBOUND_INITIATED:        'badge-blue',
};

const ACTIVE_DISPOSITIONS = [
  'RM_CONNECTED',
  'RM_NO_ANSWER_CALLCENTER',
  'CALLCENTER_NO_ANSWER',
  'CUSTOMER_NOT_PICKED',
  'CX_DROP_VOICEBOT',
  'INVALID_NUMBER',
  'CALL_FAILED',
];

export default function CallLogs() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ logs: [], total: 0 });
  const [loading, setLoading] = useState(true);

  const page = parseInt(params.get('page') || '1');
  const disposition = params.get('disposition') || '';
  const callType = params.get('call_type') || '';

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page, limit: 50 });
      if (disposition) qs.set('disposition', disposition);
      if (callType) qs.set('call_type', callType);
      const res = await api.get(`/api/v1/call-logs?${qs}`);
      setData(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, disposition, callType]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const setFilter = (key, val) => {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val); else next.delete(key);
    next.set('page', '1');
    setParams(next);
  };

  const totalPages = Math.ceil(data.total / 50);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Call Logs</h1>
        <span className="text-sm text-surface-500">{data.total} total</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <select className="select w-auto" value={disposition} onChange={e => setFilter('disposition', e.target.value)}>
          <option value="">All Dispositions</option>
          {ACTIVE_DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="select w-auto" value={callType} onChange={e => setFilter('call_type', e.target.value)}>
          <option value="">All Types</option>
          <option value="outbound_cx">Outbound CX</option>
          <option value="inbound">Inbound</option>
          <option value="retry">Retry</option>
        </select>
      </div>

      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Lead</th>
              <th>Type</th>
              <th>Disposition</th>
              <th>Duration</th>
              <th>RM</th>
              <th>Recording</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : data.logs.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-surface-400">No calls found</td></tr>
            ) : data.logs.map(l => (
              <tr key={l.id}>
                <td className="text-xs text-surface-500">{new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td><Link to={`/leads/${l.lead_id}`} className="font-mono text-xs text-brand-600 hover:underline">{l.lead_id}</Link></td>
                <td className="text-xs">{l.call_type}</td>
                <td><span className={DISP_COLOR[l.disposition] || 'badge-gray'}>{l.disposition}</span></td>
                <td>{l.call_duration_sec ? `${l.call_duration_sec}s` : '—'}</td>
                <td className="text-xs font-mono">{l.rm_who_answered || '—'}</td>
                <td>
                  {l.recording_url ? (
                    <a href={l.recording_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline text-xs">
                      <Play size={12} /> Play
                    </a>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-surface-500">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button className="btn-secondary btn-sm" disabled={page <= 1}
              onClick={() => { const next = new URLSearchParams(params); next.set('page', page - 1); setParams(next); }}>
              <ChevronLeft size={14} /> Prev
            </button>
            <button className="btn-secondary btn-sm" disabled={page >= totalPages}
              onClick={() => { const next = new URLSearchParams(params); next.set('page', page + 1); setParams(next); }}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
