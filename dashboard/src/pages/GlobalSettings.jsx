import React, { useState, useEffect } from 'react';
import { Save, Check } from 'lucide-react';
import api from '../hooks/api';

const ALL_DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

export default function GlobalSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/api/v1/routing-config')
      .then(c => setConfig(c))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const set = (key, val) => {
    setConfig(p => ({ ...p, [key]: val }));
    setSaved(false);
  };

  const toggleDay = (day) => {
    const days = config.business_days || [];
    const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
    set('business_days', next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/api/v1/routing-config/${config.id}`, {
        fallback_call_center_number: config.fallback_call_center_number,
        max_parallel_rms: parseInt(config.max_parallel_rms),
        rm_ring_duration_sec: parseInt(config.rm_ring_duration_sec),
        business_hours_start: config.business_hours_start,
        business_hours_end: config.business_hours_end,
        business_days: config.business_days,
      });
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" /></div>;
  if (!config?.id) return <div className="text-center py-16 text-surface-400">No routing config found. Run seed script first.</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Global Settings</h1>
          <p className="text-sm text-surface-500 mt-0.5">Call routing defaults and business hours</p>
        </div>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saved ? <><Check size={16} /> Saved</> : saving ? 'Saving...' : <><Save size={16} /> Save Changes</>}
        </button>
      </div>

      <div className="card p-6 space-y-6">
        {/* Call Center */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Fallback Call Center</h3>
          <label className="text-xs font-medium">Phone Number (E.164)</label>
          <input className="input mt-1 max-w-xs" value={config.fallback_call_center_number || ''}
            onChange={e => set('fallback_call_center_number', e.target.value)} placeholder="+91XXXXXXXXXX" />
        </div>

        {/* Parallel Ringing */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Parallel Ringing</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium">Max Parallel RMs</label>
              <select className="select mt-1" value={config.max_parallel_rms || 3}
                onChange={e => set('max_parallel_rms', e.target.value)}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium">Ring Duration (seconds)</label>
              <input type="range" min={10} max={30} value={config.rm_ring_duration_sec || 20}
                onChange={e => set('rm_ring_duration_sec', e.target.value)}
                className="w-full mt-2 accent-brand-600" />
              <div className="text-sm font-medium text-center mt-1">{config.rm_ring_duration_sec || 20}s</div>
            </div>
          </div>
        </div>

        {/* Business Hours */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Business Hours (IST)</h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs font-medium">Start Time</label>
              <input type="time" className="input mt-1" value={config.business_hours_start?.slice(0, 5) || '09:00'}
                onChange={e => set('business_hours_start', e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium">End Time</label>
              <input type="time" className="input mt-1" value={config.business_hours_end?.slice(0, 5) || '18:00'}
                onChange={e => set('business_hours_end', e.target.value)} />
            </div>
          </div>

          <label className="text-xs font-medium mb-2 block">Business Days</label>
          <div className="flex flex-wrap gap-2">
            {ALL_DAYS.map(({ key, label }) => {
              const active = (config.business_days || []).includes(key);
              return (
                <button key={key} type="button" onClick={() => toggleDay(key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
                    ${active ? 'bg-brand-600 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'}`}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
