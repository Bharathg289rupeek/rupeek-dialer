import React, { useState, useEffect } from 'react';
import { Save, Check, Plus, Phone, Clock, RotateCw, Shield } from 'lucide-react';
import api from '../hooks/api';

const ALL_DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const DEFAULT_CONFIG = {
  fallback_call_center_number: '+910000000000',
  max_parallel_rms: 3,
  rm_ring_duration_sec: 20,
  business_hours_start: '09:00',
  business_hours_end: '18:00',
  business_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};

export default function GlobalSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchConfig = async () => {
    try {
      const c = await api.get('/api/v1/routing-config');
      if (c && c.id) {
        setConfig(c);
      } else {
        setConfig(null);
      }
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

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

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await api.post('/api/v1/routing-config', DEFAULT_CONFIG);
      setConfig(res);
    } catch (err) {
      alert('Failed to create config: ' + err.message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-16">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-600 border-t-transparent" />
    </div>
  );

  // No config exists — show create button
  if (!config?.id) {
    return (
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-xl font-bold">Global Settings</h1>
        <div className="card p-8 text-center space-y-4">
          <div className="w-12 h-12 bg-brand-50 rounded-full flex items-center justify-center mx-auto">
            <Shield size={24} className="text-brand-600" />
          </div>
          <h2 className="text-lg font-semibold">No configuration found</h2>
          <p className="text-sm text-surface-500 max-w-sm mx-auto">
            Create default settings to get started. You can customize everything after creation.
          </p>
          <div className="text-left max-w-xs mx-auto text-sm text-surface-600 space-y-1">
            <div>Business Hours: 9:00 AM – 6:00 PM IST</div>
            <div>Business Days: Mon – Sat</div>
            <div>Max Parallel RMs: 3</div>
            <div>Ring Duration: 20 seconds</div>
          </div>
          <button className="btn-primary" onClick={handleCreate} disabled={creating}>
            <Plus size={16} />
            {creating ? 'Creating...' : 'Create Default Settings'}
          </button>
        </div>
      </div>
    );
  }

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

      {/* Business Hours */}
      <div className="card p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-brand-600" />
          <h3 className="text-sm font-semibold">Business Hours (IST)</h3>
        </div>
        <p className="text-xs text-surface-500 -mt-2">Leads outside these hours are queued for next business day at start time</p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium">Start Time</label>
            <input type="time" className="input mt-1"
              value={config.business_hours_start?.slice(0, 5) || '09:00'}
              onChange={e => set('business_hours_start', e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium">End Time</label>
            <input type="time" className="input mt-1"
              value={config.business_hours_end?.slice(0, 5) || '18:00'}
              onChange={e => set('business_hours_end', e.target.value)} />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium mb-2 block">Business Days</label>
          <div className="flex flex-wrap gap-2">
            {ALL_DAYS.map(({ key, label }) => {
              const active = (config.business_days || []).includes(key);
              return (
                <button key={key} type="button" onClick={() => toggleDay(key)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                    ${active ? 'bg-brand-600 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'}`}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Call Routing */}
      <div className="card p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Phone size={18} className="text-brand-600" />
          <h3 className="text-sm font-semibold">Call Routing</h3>
        </div>

        <div>
          <label className="text-xs font-medium">Fallback Call Center Number (E.164)</label>
          <input className="input mt-1 max-w-xs"
            value={config.fallback_call_center_number || ''}
            onChange={e => set('fallback_call_center_number', e.target.value)}
            placeholder="+91XXXXXXXXXX" />
          <p className="text-xs text-surface-400 mt-1">Customer is routed here when no RM answers</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium">Max Parallel RMs</label>
            <select className="select mt-1" value={config.max_parallel_rms || 3}
              onChange={e => set('max_parallel_rms', e.target.value)}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="text-xs text-surface-400 mt-1">How many RMs are dialed at once</p>
          </div>
          <div>
            <label className="text-xs font-medium">Ring Duration: {config.rm_ring_duration_sec || 20}s</label>
            <input type="range" min={10} max={45} step={5}
              value={config.rm_ring_duration_sec || 20}
              onChange={e => set('rm_ring_duration_sec', e.target.value)}
              className="w-full mt-2 accent-brand-600" />
            <div className="flex justify-between text-xs text-surface-400 mt-0.5">
              <span>10s</span><span>45s</span>
            </div>
          </div>
        </div>
      </div>

      {/* Retry Settings (read-only info) */}
      <div className="card p-6 space-y-5">
        <div className="flex items-center gap-2">
          <RotateCw size={18} className="text-brand-600" />
          <h3 className="text-sm font-semibold">Retry & Fallback Settings</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-surface-50 rounded-lg p-4">
            <div className="text-xs font-semibold text-surface-600 uppercase tracking-wider mb-2">Customer Not Picked</div>
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="text-surface-500">Max retries</span><span className="font-medium">2 attempts</span></div>
              <div className="flex justify-between"><span className="text-surface-500">Retry interval</span><span className="font-medium">10 minutes</span></div>
              <div className="flex justify-between"><span className="text-surface-500">After exhausted</span><span className="font-medium text-amber-600">UTM lead created</span></div>
            </div>
          </div>

          <div className="bg-surface-50 rounded-lg p-4">
            <div className="text-xs font-semibold text-surface-600 uppercase tracking-wider mb-2">No RM Answered</div>
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="text-surface-500">Max retries</span><span className="font-medium">3 attempts</span></div>
              <div className="flex justify-between"><span className="text-surface-500">Retry interval</span><span className="font-medium">10 minutes</span></div>
              <div className="flex justify-between"><span className="text-surface-500">After exhausted</span><span className="font-medium text-amber-600">UTM lead created</span></div>
            </div>
          </div>

          <div className="bg-surface-50 rounded-lg p-4">
            <div className="text-xs font-semibold text-surface-600 uppercase tracking-wider mb-2">Customer Drops Voicebot</div>
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="text-surface-500">Max retries</span><span className="font-medium">2 attempts</span></div>
              <div className="flex justify-between"><span className="text-surface-500">Retry interval</span><span className="font-medium">10 minutes</span></div>
              <div className="flex justify-between"><span className="text-surface-500">After exhausted</span><span className="font-medium text-amber-600">UTM lead created</span></div>
            </div>
          </div>

          <div className="bg-surface-50 rounded-lg p-4">
            <div className="text-xs font-semibold text-surface-600 uppercase tracking-wider mb-2">Call Failed (Technical)</div>
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="text-surface-500">Max retries</span><span className="font-medium">No retry</span></div>
              <div className="flex justify-between"><span className="text-surface-500">Action</span><span className="font-medium text-red-600">Logged as CALL_FAILED</span></div>
            </div>
          </div>
        </div>

        <p className="text-xs text-surface-400">Retry settings are system-configured. Contact engineering to modify retry counts or intervals.</p>
      </div>

      {/* Current Config Info */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-3">System Info</h3>
        <div className="text-xs text-surface-500 space-y-1 font-mono">
          <div>Config ID: {config.id}</div>
          <div>Created: {new Date(config.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
          <div>Last Updated: {new Date(config.updated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
        </div>
      </div>

      {/* Floating save button */}
      <div className="sticky bottom-4 flex justify-end">
        <button className="btn-primary shadow-lg" onClick={handleSave} disabled={saving}>
          {saved ? <><Check size={16} /> Saved</> : saving ? 'Saving...' : <><Save size={16} /> Save Changes</>}
        </button>
      </div>
    </div>
  );
}
