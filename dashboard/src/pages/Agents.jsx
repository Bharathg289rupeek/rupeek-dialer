import React, { useState, useEffect, useCallback } from 'react';
import { Search, Upload, Plus, X, Check } from 'lucide-react';
import api from '../hooks/api';

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [showUpload, setShowUpload] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [cities, setCities] = useState([]);
  const [page, setPage] = useState(1);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page, limit: 50 });
      if (search) qs.set('search', search);
      if (cityFilter) qs.set('city', cityFilter);
      if (activeFilter) qs.set('is_active', activeFilter);
      const res = await api.get(`/api/v1/agents?${qs}`);
      setAgents(res.agents);
      setTotal(res.total);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [search, cityFilter, activeFilter, page]);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);
  useEffect(() => {
    api.get('/api/v1/agents/filters').then(f => setCities(f.cities)).catch(() => {});
  }, []);

  const toggleIdentifier = async (agent, field) => {
    const newVal = agent[field] === 'assign' ? 'dont assign' : 'assign';
    try {
      await api.put(`/api/v1/agents/${agent.id}`, { [field]: newVal });
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, [field]: newVal } : a));
    } catch (err) { alert('Update failed: ' + err.message); }
  };

  const toggleActive = async (agent) => {
    try {
      await api.put(`/api/v1/agents/${agent.id}`, { is_active: !agent.is_active });
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, is_active: !a.is_active } : a));
    } catch (err) { alert('Update failed: ' + err.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">Agents</h1>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" onClick={() => setShowUpload(true)}>
            <Upload size={14} /> Upload CSV
          </button>
          <button className="btn-primary btn-sm" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add Agent
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input className="input pl-9" placeholder="Search name, email, phone..."
            value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <select className="select w-auto" value={cityFilter} onChange={e => { setCityFilter(e.target.value); setPage(1); }}>
          <option value="">All Cities</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="select w-auto" value={activeFilter} onChange={e => { setActiveFilter(e.target.value); setPage(1); }}>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </select>
      </div>

      <p className="text-xs text-surface-500">Click identifier badges to toggle assign/don't assign. {total} agents total.</p>

      {/* Table */}
      <div className="card table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>City</th>
              <th>Pincode</th>
              <th>Branch</th>
              <th>P</th>
              <th>City ID</th>
              <th>Pincode ID</th>
              <th>Branch ID</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="text-center py-8 text-surface-400">Loading...</td></tr>
            ) : agents.length === 0 ? (
              <tr><td colSpan={10} className="text-center py-8 text-surface-400">No agents found</td></tr>
            ) : agents.map(a => (
              <tr key={a.id}>
                <td>
                  <div className="font-medium text-sm">{a.agent_name}</div>
                  <div className="text-xs text-surface-400">{a.agent_email}</div>
                </td>
                <td className="font-mono text-xs">{a.agent_phone}</td>
                <td>{a.city}</td>
                <td>{a.pincode}</td>
                <td className="font-mono text-xs" title={a.branch_id}>{a.branch_id?.slice(0, 8)}...</td>
                <td>{a.priority}</td>
                <td>
                  <IdentifierToggle value={a.city_identifier} onClick={() => toggleIdentifier(a, 'city_identifier')} />
                </td>
                <td>
                  <IdentifierToggle value={a.pincode_identifier} onClick={() => toggleIdentifier(a, 'pincode_identifier')} />
                </td>
                <td>
                  <IdentifierToggle value={a.branch_identifier} onClick={() => toggleIdentifier(a, 'branch_identifier')} />
                </td>
                <td>
                  <button onClick={() => toggleActive(a)}
                    className={`w-9 h-5 rounded-full transition-colors relative ${a.is_active ? 'bg-emerald-500' : 'bg-surface-300'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform
                      ${a.is_active ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modals */}
      {showUpload && <CsvUploadModal onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); fetchAgents(); }} />}
      {showAdd && <AddAgentModal onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); fetchAgents(); }} />}
    </div>
  );
}

function IdentifierToggle({ value, onClick }) {
  const isAssign = value === 'assign';
  return (
    <button onClick={onClick}
      className={`px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer
        ${isAssign ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-surface-100 text-surface-400 hover:bg-surface-200'}`}>
      {isAssign ? 'assign' : 'skip'}
    </button>
  );
}

function CsvUploadModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload('/api/v1/agents/upload-csv', fd);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Upload Agent CSV</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-100"><X size={18} /></button>
        </div>

        {!result ? (
          <>
            <div className="border-2 border-dashed rounded-lg p-6 text-center">
              <input type="file" accept=".csv" onChange={e => setFile(e.target.files[0])}
                className="block w-full text-sm file:btn-secondary file:btn-sm file:mr-3" />
              <p className="text-xs text-surface-400 mt-2">
                Required columns: branch_id, agent_email, agent_name, agent_phone, city, pincode
              </p>
            </div>
            {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={handleUpload} disabled={!file || loading}>
                {loading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>Total rows:</span><span className="font-medium">{result.total_rows}</span></div>
              <div className="flex justify-between"><span>New agents:</span><span className="font-medium text-emerald-600">{result.new_agents}</span></div>
              <div className="flex justify-between"><span>Updated:</span><span className="font-medium text-blue-600">{result.updated_agents}</span></div>
              <div className="flex justify-between"><span>Skipped:</span><span className="font-medium text-amber-600">{result.skipped_agents}</span></div>
            </div>
            {result.errors?.length > 0 && (
              <div className="text-xs bg-red-50 rounded-lg p-3 max-h-32 overflow-y-auto">
                {result.errors.map((e, i) => <div key={i}>Row {e.row}: {e.errors.join(', ')}</div>)}
              </div>
            )}
            <button className="btn-primary btn-sm w-full" onClick={onDone}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

function AddAgentModal({ onClose, onDone }) {
  const [form, setForm] = useState({
    branch_id: '', agent_email: '', agent_name: '', agent_phone: '',
    city: '', pincode: '', priority: 1,
    city_identifier: 'dont assign', pincode_identifier: 'dont assign', branch_identifier: 'dont assign',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/api/v1/agents', form);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onSubmit={handleSubmit} className="card p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Add Agent</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-100"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium">Name *</label><input className="input mt-1" required value={form.agent_name} onChange={e => set('agent_name', e.target.value)} /></div>
          <div><label className="text-xs font-medium">Email *</label><input className="input mt-1" required type="email" value={form.agent_email} onChange={e => set('agent_email', e.target.value)} /></div>
          <div><label className="text-xs font-medium">Phone *</label><input className="input mt-1" required value={form.agent_phone} onChange={e => set('agent_phone', e.target.value)} /></div>
          <div><label className="text-xs font-medium">City *</label><input className="input mt-1" required value={form.city} onChange={e => set('city', e.target.value)} /></div>
          <div><label className="text-xs font-medium">Pincode *</label><input className="input mt-1" required value={form.pincode} onChange={e => set('pincode', e.target.value)} /></div>
          <div><label className="text-xs font-medium">Branch ID *</label><input className="input mt-1" required value={form.branch_id} onChange={e => set('branch_id', e.target.value)} /></div>
          <div><label className="text-xs font-medium">Priority</label><input className="input mt-1" type="number" min={1} value={form.priority} onChange={e => set('priority', parseInt(e.target.value) || 1)} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {['city_identifier','pincode_identifier','branch_identifier'].map(k => (
            <div key={k}>
              <label className="text-xs font-medium">{k.replace('_', ' ')}</label>
              <select className="select mt-1" value={form[k]} onChange={e => set(k, e.target.value)}>
                <option value="dont assign">dont assign</option>
                <option value="assign">assign</option>
              </select>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary btn-sm" disabled={loading}>
            {loading ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
      </form>
    </div>
  );
}
