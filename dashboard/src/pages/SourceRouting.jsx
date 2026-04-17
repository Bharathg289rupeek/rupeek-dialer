import React, { useState, useEffect } from 'react';
import { Plus, X, Trash2, Play, ArrowRight, GripVertical } from 'lucide-react';
import api from '../hooks/api';

const LEVELS = ['pincode', 'branch_id', 'city'];

export default function SourceRouting() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testForm, setTestForm] = useState({ lead_source: 'chakra', city: '', pincode: '', branch_id: '' });

  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/v1/source-routing-rules');
      setRules(res.rules);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchRules(); }, []);

  const deleteRule = async (id, source) => {
    if (source === 'default') return alert('Cannot delete the default rule');
    if (!confirm(`Delete routing rule for "${source}"?`)) return;
    try {
      await api.delete(`/api/v1/source-routing-rules/${id}`);
      fetchRules();
    } catch (err) { alert(err.message); }
  };

  const runTest = async () => {
    try {
      const res = await api.post('/api/v1/source-routing-rules/test', testForm);
      setTestResult(res);
    } catch (err) { alert(err.message); }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Source Routing Rules</h1>
          <p className="text-sm text-surface-500 mt-0.5">Define which routing level to use per lead source</p>
        </div>
        <button className="btn-primary btn-sm" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add Rule
        </button>
      </div>

      {/* Rules Table */}
      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Primary Level</th>
              <th>Fallback Chain</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : rules.map(r => (
              <tr key={r.id}>
                <td>
                  <span className="badge-blue">{r.lead_source}</span>
                  {r.lead_source === 'default' && <span className="text-xs text-surface-400 ml-1">(catch-all)</span>}
                </td>
                <td>
                  {editId === r.id ? (
                    <EditRuleInline rule={r} onSave={() => { setEditId(null); fetchRules(); }} onCancel={() => setEditId(null)} />
                  ) : (
                    <span className="font-medium text-brand-700 bg-brand-50 px-2 py-1 rounded text-sm">{r.routing_level}</span>
                  )}
                </td>
                <td>
                  {editId !== r.id && (
                    <div className="flex items-center gap-1 flex-wrap">
                      {(r.fallback_levels || []).map((fb, i) => (
                        <React.Fragment key={fb}>
                          {i > 0 && <ArrowRight size={12} className="text-surface-300" />}
                          <span className="text-xs bg-surface-100 px-2 py-0.5 rounded">{fb}</span>
                        </React.Fragment>
                      ))}
                      {(r.fallback_levels || []).length > 0 && (
                        <>
                          <ArrowRight size={12} className="text-surface-300" />
                          <span className="text-xs text-red-500">call center</span>
                        </>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  <span className={r.is_active ? 'badge-green' : 'badge-red'}>{r.is_active ? 'active' : 'off'}</span>
                </td>
                <td>
                  <div className="flex gap-1">
                    {editId !== r.id && (
                      <button className="btn-secondary btn-sm" onClick={() => setEditId(r.id)}>Edit</button>
                    )}
                    {r.lead_source !== 'default' && (
                      <button className="p-1.5 rounded hover:bg-red-50 text-red-500" onClick={() => deleteRule(r.id, r.lead_source)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Flow Visualization */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-3">Routing Flow Preview</h2>
        <div className="space-y-3">
          {rules.filter(r => r.is_active).map(r => (
            <div key={r.id} className="flex items-center gap-2 flex-wrap text-sm">
              <span className="badge-blue">{r.lead_source}</span>
              <ArrowRight size={14} className="text-surface-300" />
              <span className="font-medium text-brand-700">{r.routing_level}</span>
              {(r.fallback_levels || []).map(fb => (
                <React.Fragment key={fb}>
                  <ArrowRight size={14} className="text-surface-300" />
                  <span className="text-surface-600">{fb}</span>
                </React.Fragment>
              ))}
              <ArrowRight size={14} className="text-surface-300" />
              <span className="text-red-500 text-xs">call center</span>
            </div>
          ))}
        </div>
      </div>

      {/* Test Panel */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-3">Test Routing</h2>
        <p className="text-xs text-surface-500 mb-4">Enter sample lead data to see which agents would be selected</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="text-xs font-medium">Source</label>
            <select className="select mt-1" value={testForm.lead_source} onChange={e => setTestForm(p => ({ ...p, lead_source: e.target.value }))}>
              {rules.map(r => <option key={r.lead_source} value={r.lead_source}>{r.lead_source}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium">City</label>
            <input className="input mt-1" value={testForm.city} onChange={e => setTestForm(p => ({ ...p, city: e.target.value }))} placeholder="ahmedabad" />
          </div>
          <div>
            <label className="text-xs font-medium">Pincode</label>
            <input className="input mt-1" value={testForm.pincode} onChange={e => setTestForm(p => ({ ...p, pincode: e.target.value }))} placeholder="560050" />
          </div>
          <div>
            <label className="text-xs font-medium">Branch ID</label>
            <input className="input mt-1" value={testForm.branch_id} onChange={e => setTestForm(p => ({ ...p, branch_id: e.target.value }))} placeholder="5cef50..." />
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={runTest}><Play size={14} /> Run Test</button>

        {testResult && (
          <div className="mt-4 p-4 bg-surface-50 rounded-lg space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Source Rule:</span>
              <span className="badge-blue">{testResult.source_rule?.lead_source || 'none'}</span>
              <span>→ primary: <span className="font-mono">{testResult.source_rule?.routing_level}</span></span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">Chain tried:</span>
              {testResult.routing_chain?.map((level, i) => (
                <React.Fragment key={level}>
                  {i > 0 && <ArrowRight size={12} className="text-surface-300" />}
                  <span className={`font-mono text-xs px-2 py-0.5 rounded ${level === testResult.matched_level ? 'bg-emerald-100 text-emerald-700 font-bold' : 'bg-surface-200'}`}>
                    {level} {level === testResult.matched_level && '✓'}
                  </span>
                </React.Fragment>
              ))}
            </div>
            {testResult.matched_agents?.length > 0 ? (
              <div>
                <span className="font-medium">Matched agents ({testResult.matched_level}):</span>
                <div className="mt-1 space-y-1">
                  {testResult.matched_agents.map(a => (
                    <div key={a.id} className="flex items-center gap-3 text-xs bg-white rounded p-2">
                      <span className="font-medium">{a.agent_name}</span>
                      <span className="font-mono text-surface-500">{a.agent_phone}</span>
                      <span className="badge-gray">P{a.priority}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-red-600 font-medium">No agents matched → would fall back to call center</div>
            )}
          </div>
        )}
      </div>

      {showAdd && <AddRuleModal onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); fetchRules(); }} />}
    </div>
  );
}

function EditRuleInline({ rule, onSave, onCancel }) {
  const [level, setLevel] = useState(rule.routing_level);
  const [fallbacks, setFallbacks] = useState(rule.fallback_levels || []);
  const [saving, setSaving] = useState(false);

  const availableFallbacks = LEVELS.filter(l => l !== level);

  useEffect(() => {
    setFallbacks(availableFallbacks);
  }, [level]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/v1/source-routing-rules/${rule.id}`, {
        routing_level: level,
        fallback_levels: fallbacks,
      });
      onSave();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const moveFallback = (idx, dir) => {
    const arr = [...fallbacks];
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    setFallbacks(arr);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select className="select w-auto text-sm" value={level} onChange={e => setLevel(e.target.value)}>
        {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
      </select>
      <span className="text-xs text-surface-400">then:</span>
      {fallbacks.map((fb, i) => (
        <div key={fb} className="flex items-center gap-1">
          <span className="text-xs bg-surface-100 px-2 py-1 rounded">{fb}</span>
          {i > 0 && <button className="text-xs text-surface-400 hover:text-brand-600" onClick={() => moveFallback(i, -1)}>↑</button>}
          {i < fallbacks.length - 1 && <button className="text-xs text-surface-400 hover:text-brand-600" onClick={() => moveFallback(i, 1)}>↓</button>}
        </div>
      ))}
      <button className="btn-primary btn-sm" onClick={save} disabled={saving}>Save</button>
      <button className="btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function AddRuleModal({ onClose, onDone }) {
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('pincode');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fallbacks = LEVELS.filter(l => l !== level);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!source.trim()) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/api/v1/source-routing-rules', {
        lead_source: source.toLowerCase().trim(),
        routing_level: level,
        fallback_levels: fallbacks,
      });
      onDone();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onSubmit={handleSubmit} className="card p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Add Routing Rule</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-100"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
        <div>
          <label className="text-xs font-medium">Lead Source *</label>
          <input className="input mt-1" required value={source} onChange={e => setSource(e.target.value)} placeholder="e.g. website, partner_x" />
        </div>
        <div>
          <label className="text-xs font-medium">Primary Routing Level</label>
          <select className="select mt-1" value={level} onChange={e => setLevel(e.target.value)}>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium">Fallback Chain</label>
          <div className="flex items-center gap-2 mt-1 text-sm">
            {fallbacks.map((fb, i) => (
              <React.Fragment key={fb}>
                {i > 0 && <ArrowRight size={12} className="text-surface-300" />}
                <span className="bg-surface-100 px-2 py-1 rounded text-xs">{fb}</span>
              </React.Fragment>
            ))}
            <ArrowRight size={12} className="text-surface-300" />
            <span className="text-red-500 text-xs">call center</span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary btn-sm" disabled={loading}>
            {loading ? 'Creating...' : 'Create Rule'}
          </button>
        </div>
      </form>
    </div>
  );
}
