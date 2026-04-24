import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../hooks/api';

const STATUS_BADGE = {
  new:                   'badge-blue',
  in_progress:           'badge-yellow',
  cx_notpicked_retrying: 'badge-yellow',
  connected:             'badge-green',
  call_center_handled:   'badge-purple',
  queued:                'badge-purple',
  failed:                'badge-red',
  utm_created:           'badge-gray',   // historical only
};

const STATUS_LABEL = {
  new:                   'new',
  in_progress:           'in progress',
  cx_notpicked_retrying: 'retrying',
  connected:             'connected',
  call_center_handled:   'call centre',
  queued:                'queued',
  failed:                'failed',
  utm_created:           'utm (legacy)',
};

export default function Leads() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ leads: [], total: 0 });
  const [loading, setLoading] = useState(true);

  const page = parseInt(params.get('page') || '1');
  const status = params.get('status') || '';
  const search = params.get('search') || '';
  const source = params.get('source') || '';

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page, limit: 30 });
      if (status) qs.set('status', status);
      if (search) qs.set('search', search);
      if (source) qs.set('lead_source', source);
      const res = await api.get(`/api/v1/leads?${qs}`);
      setData(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, status, search, source]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const setFilter = (key, val) => {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val); else next.delete(key);
    next.set('page', '1');
    setParams(next);
  };

  const totalPages = Math.ceil(data.total / 30);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">Leads</h1>
        <span className="text-sm text-surface-500">{data.total} total</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input className="input pl-9" placeholder="Search lead ID, name, phone..."
            value={search} onChange={e => setFilter('search', e.target.value)} />
        </div>
        <select className="select w-auto" value={status} onChange={e => setFilter('status', e.target.value)}>
          <option value="">All Statuses</option>
          {Object.keys(STATUS_BADGE).map(s => <option key={s} value={s}>{STATUS_LABEL[s] || s.replace(/_/g, ' ')}</option>)}
        </select>
        <select className="select w-auto" value={source} onChange={e => setFilter('source', e.target.value)}>
          <option value="">All Sources</option>
          <option value="chakra">chakra</option>
          <option value="inbound">inbound</option>
          <option value="website">website</option>
        </select>
      </div>

      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Lead ID</th>
              <th>Customer</th>
              <th>Phone</th>
              <th>City</th>
              <th>Source</th>
              <th>Status</th>
              <th>RM Assigned</th>
              <th>Calls</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : data.leads.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-8 text-surface-400">No leads found</td></tr>
            ) : data.leads.map(l => (
              <tr key={l.id} className="cursor-pointer" onClick={() => navigate(`/leads/${l.lead_id}`)}>
                <td className="font-mono text-xs">{l.lead_id}</td>
                <td>{l.customer_name || '—'}</td>
                <td className="font-mono text-xs">{l.customer_phone}</td>
                <td>{l.city || '—'}</td>
                <td><span className="badge-blue">{l.lead_source}</span></td>
                <td><span className={STATUS_BADGE[l.status] || 'badge-gray'}>{STATUS_LABEL[l.status] || l.status}</span></td>
                <td className="text-xs">{l.assigned_rm_name || l.assigned_rm_phone || '—'}</td>
                <td>{l.call_count || 0}</td>
                <td className="text-xs text-surface-500">{new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
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
