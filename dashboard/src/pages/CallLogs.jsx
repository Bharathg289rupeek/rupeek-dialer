import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../hooks/api';

const DISPOSITIONS = [
  'RM_CONNECTED','RM_CONNECTED_CX_NO_ANSWER','RM_NO_ANSWER','RM_NO_ANSWER_CALLCENTER',
  'CUSTOMER_NOT_PICKED','CX_DROP_VOICEBOT','CALL_FAILED','UTM_LEAD_CREATED',
  'INBOUND_CONNECTED','INBOUND_NO_RM','INITIATED',
];

const DISP_COLOR = {
  RM_CONNECTED: 'badge-green', INBOUND_CONNECTED: 'badge-green',
  RM_NO_ANSWER: 'badge-yellow', RM_NO_ANSWER_CALLCENTER: 'badge-yellow',
  RM_CONNECTED_CX_NO_ANSWER: 'badge-blue', CUSTOMER_NOT_PICKED: 'badge-blue',
  CALL_FAILED: 'badge-red', CX_DROP_VOICEBOT: 'badge-red',
  UTM_LEAD_CREATED: 'badge-purple', INITIATED: 'badge-gray',
};

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
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
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
        <span className="text-sm text-surface-500">{data.total} records</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <select className="select w-auto" value={disposition} onChange={e => setFilter('disposition', e.target.value)}>
          <option value="">All Dispositions</option>
          {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="select w-auto" value={callType} onChange={e => setFilter('call_type', e.target.value)}>
          <option value="">All Types</option>
          <option value="outbound_rm">Outbound RM</option>
          <option value="outbound_cx">Outbound CX</option>
          <option value="inbound">Inbound</option>
        </select>
      </div>

      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Lead ID</th>
              <th>Type</th>
              <th>CallSid</th>
              <th>From</th>
              <th>To</th>
              <th>Disposition</th>
              <th>RM Answered</th>
              <th>Duration</th>
              <th>Attempt</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : data.logs.length === 0 ? (
              <tr><td colSpan={10} className="text-center py-8 text-surface-400">No logs found</td></tr>
            ) : data.logs.map(l => (
              <tr key={l.id}>
                <td className="text-xs text-surface-500">{new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                <td className="font-mono text-xs">{l.lead_id}</td>
                <td><span className="badge-gray">{l.call_type}</span></td>
                <td className="font-mono text-xs">{l.call_sid?.slice(0, 12) || '—'}</td>
                <td className="font-mono text-xs">{l.from_number || '—'}</td>
                <td className="font-mono text-xs">{l.to_number || '—'}</td>
                <td><span className={DISP_COLOR[l.disposition] || 'badge-gray'}>{l.disposition || '—'}</span></td>
                <td className="font-mono text-xs">{l.rm_who_answered || '—'}</td>
                <td>{l.call_duration_sec ? `${l.call_duration_sec}s` : '—'}</td>
                <td>#{l.attempt_number}</td>
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
              onClick={() => { const n = new URLSearchParams(params); n.set('page', page - 1); setParams(n); }}>
              <ChevronLeft size={14} /> Prev
            </button>
            <button className="btn-secondary btn-sm" disabled={page >= totalPages}
              onClick={() => { const n = new URLSearchParams(params); n.set('page', page + 1); setParams(n); }}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
