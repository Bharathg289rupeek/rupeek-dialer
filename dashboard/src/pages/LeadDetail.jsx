import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Clock, CheckCircle, XCircle, RotateCw, Headphones, PhoneMissed, AlertTriangle } from 'lucide-react';
import api from '../hooks/api';

const DISP_ICON = {
  RM_CONNECTED:             { icon: CheckCircle,   color: 'text-emerald-600', bg: 'bg-emerald-50' },
  RM_NO_ANSWER_CALLCENTER:  { icon: Headphones,    color: 'text-purple-600',  bg: 'bg-purple-50' },
  CALLCENTER_NO_ANSWER:     { icon: PhoneMissed,   color: 'text-orange-600',  bg: 'bg-orange-50' },
  CUSTOMER_NOT_PICKED:      { icon: Phone,         color: 'text-blue-600',    bg: 'bg-blue-50' },
  CX_DROP_VOICEBOT:         { icon: XCircle,       color: 'text-amber-600',   bg: 'bg-amber-50' },
  CALL_FAILED:              { icon: XCircle,       color: 'text-red-600',     bg: 'bg-red-50' },
  INVALID_NUMBER:           { icon: AlertTriangle, color: 'text-red-700',     bg: 'bg-red-100' },
  INITIATED:                { icon: Clock,         color: 'text-surface-400', bg: 'bg-surface-100' },
  // Historical / deprecated
  RM_NO_ANSWER:             { icon: XCircle,       color: 'text-amber-600',   bg: 'bg-amber-50' },
  UTM_LEAD_CREATED:         { icon: RotateCw,      color: 'text-purple-600',  bg: 'bg-purple-50' },
  RM_CONNECTED_CX_NO_ANSWER:{ icon: Phone,         color: 'text-blue-600',    bg: 'bg-blue-50' },
};

const STATUS_BADGE = {
  new:                   'badge-blue',
  in_progress:           'badge-yellow',
  cx_notpicked_retrying: 'badge-yellow',
  connected:             'badge-green',
  call_center_handled:   'badge-purple',
  queued:                'badge-purple',
  failed:                'badge-red',
  utm_created:           'badge-gray',
};

const STATUS_LABEL = {
  cx_notpicked_retrying: 'retrying',
  in_progress:           'in progress',
  call_center_handled:   'call centre',
  utm_created:           'utm (legacy)',
};

export default function LeadDetail() {
  const { leadId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () => api.get(`/api/v1/leads/${leadId}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));

    load();
    // Auto-refresh every 15s while any call is INITIATED — the resolver runs
    // every minute, so the page will reflect the terminal state within ~3.5 min
    // of the call ending.
    const interval = setInterval(() => {
      if (data?.calls?.some(c => c.disposition === 'INITIATED') ||
          data?.lead?.status === 'in_progress' ||
          data?.lead?.status === 'cx_notpicked_retrying') {
        load();
      }
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" /></div>;
  if (!data?.lead) return <div className="text-center py-16 text-surface-400">Lead not found</div>;

  const { lead, calls, retries } = data;

  // Retry progress — compute for the retrying state
  const pendingRetry = retries?.find(r => r.status === 'pending');
  const retryAttempt = pendingRetry?.attempt_number;
  const retryMax = pendingRetry?.max_attempts;

  return (
    <div className="space-y-6 max-w-4xl">
      <Link to="/leads" className="inline-flex items-center gap-1 text-sm text-surface-500 hover:text-brand-600">
        <ArrowLeft size={16} /> Back to Leads
      </Link>

      <div className="card p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold">{lead.customer_name || 'Unknown Customer'}</h1>
            <p className="text-sm text-surface-500 font-mono">{lead.lead_id}</p>
          </div>
          <div className="text-right">
            <span className={STATUS_BADGE[lead.status] || 'badge-gray'}>
              {STATUS_LABEL[lead.status] || lead.status}
            </span>
            {lead.status === 'cx_notpicked_retrying' && retryAttempt && retryMax && (
              <div className="text-xs text-surface-500 mt-1">
                Retry {retryAttempt} of {retryMax}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {[
            ['Phone',       lead.customer_phone],
            ['City',        lead.city],
            ['Pincode',     lead.pincode],
            ['Branch',      lead.branch_id?.length > 12 ? lead.branch_id.slice(0, 12) + '...' : lead.branch_id],
            ['Source',      lead.lead_source],
            ['Loan Type',   lead.loan_type],
            ['Amount',      lead.loan_amount ? `₹${Number(lead.loan_amount).toLocaleString()}` : '—'],
            ['RM Assigned', lead.assigned_rm_name || lead.assigned_rm_phone || '—'],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-xs text-surface-400">{label}</div>
              <div className="font-medium mt-0.5">{val || '—'}</div>
            </div>
          ))}
        </div>

        {/* Contextual banners */}
        {lead.status === 'in_progress' && calls.some(c => c.disposition === 'INITIATED') && (
          <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700 flex items-start gap-2">
            <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-600 border-t-transparent mt-0.5 shrink-0" />
            <div>
              <strong>Call in progress.</strong> Classification is deferred by up to 3 minutes
              while Exotel finalises the call details. This page refreshes automatically.
            </div>
          </div>
        )}
        {lead.status === 'call_center_handled' && (
          <div className="mt-4 p-3 bg-purple-50 border border-purple-100 rounded-lg text-xs text-purple-700">
            <strong>Routed to call centre.</strong> No RM picked up within the ring window;
            Exotel's call-centre fallback handled this customer. No retry scheduled. No WhatsApp notification fired.
          </div>
        )}
        {lead.utm_identifier === 'invalid_number' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700">
            <strong>Invalid number.</strong> Customer phone number could not be dialled. No retries scheduled.
          </div>
        )}
        {lead.status === 'cx_notpicked_retrying' && (
          <div className="mt-4 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700">
            <strong>Retrying.</strong> {retryAttempt && retryMax ? `Attempt ${retryAttempt} of ${retryMax} scheduled.` : 'Next retry scheduled.'}
            {' '}No WhatsApp will fire until all retries are exhausted.
          </div>
        )}
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
                      {c.rm_who_answered && <div>RM Answered: <span className="font-mono">{c.rm_who_answered}</span></div>}
                      {c.disposition === 'RM_NO_ANSWER_CALLCENTER' && c.to_number && (
                        <div>Routed to call centre: <span className="font-mono">{c.to_number}</span></div>
                      )}
                      {c.disposition === 'CALLCENTER_NO_ANSWER' && (
                        <div className="text-orange-600">Call centre did not pick up</div>
                      )}
                      {c.disposition === 'INVALID_NUMBER' && (
                        <div className="text-red-600">Phone number is invalid</div>
                      )}
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
                    <td className="font-mono text-xs">{r.retry_type}</td>
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
