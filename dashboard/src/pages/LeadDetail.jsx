import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Clock, CheckCircle, XCircle, RotateCw } from 'lucide-react';
import api from '../hooks/api';

const DISP_ICON = {
  RM_CONNECTED: { icon: CheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  RM_NO_ANSWER: { icon: XCircle, color: 'text-amber-600', bg: 'bg-amber-50' },
  RM_CONNECTED_CX_NO_ANSWER: { icon: Phone, color: 'text-blue-600', bg: 'bg-blue-50' },
  CALL_FAILED: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
  UTM_LEAD_CREATED: { icon: RotateCw, color: 'text-purple-600', bg: 'bg-purple-50' },
  INITIATED: { icon: Clock, color: 'text-surface-400', bg: 'bg-surface-100' },
};

export default function LeadDetail() {
  const { leadId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/v1/leads/${leadId}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [leadId]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" /></div>;
  if (!data?.lead) return <div className="text-center py-16 text-surface-400">Lead not found</div>;

  const { lead, calls, retries } = data;

  return (
    <div className="space-y-6 max-w-4xl">
      <Link to="/leads" className="inline-flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600">
        <ArrowLeft size={16} /> Back to Leads
      </Link>

      {/* Lead Info Card */}
      <div className="card p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold">{lead.customer_name || 'Unknown Customer'}</h1>
            <p className="text-sm text-surface-500 font-mono">{lead.lead_id}</p>
          </div>
          <span className={`badge ${lead.status === 'connected' ? 'badge-green' : lead.status === 'failed' ? 'badge-red' : 'badge-yellow'}`}>
            {lead.status}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {[
            ['Phone', lead.customer_phone],
            ['City', lead.city],
            ['Pincode', lead.pincode],
            ['Branch', lead.branch_id?.slice(0, 12) + '...'],
            ['Source', lead.lead_source],
            ['Loan Type', lead.loan_type],
            ['Amount', lead.loan_amount ? `₹${Number(lead.loan_amount).toLocaleString()}` : '—'],
            ['RM Assigned', lead.assigned_rm_phone || '—'],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-xs text-surface-400">{label}</div>
              <div className="font-medium mt-0.5">{val || '—'}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Call Timeline */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold mb-4">Call History ({calls.length} entries)</h2>
        {calls.length === 0 ? (
          <p className="text-surface-400 text-sm">No calls yet</p>
        ) : (
          <div className="space-y-0">
            {calls.map((c, i) => {
              const disp = DISP_ICON[c.disposition] || DISP_ICON.INITIATED;
              const Icon = disp.icon;
              return (
                <div key={c.id} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full ${disp.bg} flex items-center justify-center shrink-0`}>
                      <Icon size={14} className={disp.color} />
                    </div>
                    {i < calls.length - 1 && <div className="w-px flex-1 bg-surface-200 my-1" />}
                  </div>
                  <div className="pb-5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{c.disposition || 'PENDING'}</span>
                      <span className="text-xs text-surface-400">
                        {new Date(c.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </span>
                    </div>
                    <div className="text-xs text-surface-500 mt-1 space-y-0.5">
                      <div>Type: {c.call_type} | Attempt #{c.attempt_number}</div>
                      {c.call_sid && <div className="font-mono">CallSid: {c.call_sid}</div>}
                      {c.rm_who_answered && <div>RM Answered: {c.rm_who_answered}</div>}
                      {c.call_duration_sec > 0 && <div>Duration: {c.call_duration_sec}s</div>}
                      {c.recording_url && (
                        <a href={c.recording_url} target="_blank" rel="noreferrer"
                          className="text-brand-600 hover:underline">Play Recording</a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Retries */}
      {retries.length > 0 && (
        <div className="card p-6">
          <h2 className="text-sm font-semibold mb-4">Retry History</h2>
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Type</th><th>Attempt</th><th>Scheduled</th><th>Status</th></tr></thead>
              <tbody>
                {retries.map(r => (
                  <tr key={r.id}>
                    <td>{r.retry_type}</td>
                    <td>{r.attempt_number} / {r.max_attempts}</td>
                    <td className="text-xs">{new Date(r.scheduled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                    <td><span className={r.status === 'pending' ? 'badge-yellow' : r.status === 'exhausted' ? 'badge-red' : 'badge-green'}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
