import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { playWhep } from './player.js';

const tokenFor = async (path) => (await api(`/media/token?path=${encodeURIComponent(path)}`)).token;

/* ---------- live video with optional bbox overlays ---------- */
function LiveVideo({ path, boxes = [], overlay, className = '' }) {
  const vRef = useRef(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let pc;
    setErr('');
    playWhep(vRef.current, path, tokenFor).then((p) => (pc = p)).catch((e) => setErr(e.message));
    return () => pc && pc.close();
  }, [path]);
  return (
    <div className={`video-wrap ${className}`}>
      <video ref={vRef} autoPlay muted playsInline />
      {overlay && boxes.map((b, i) => (
        <div key={i} className="bbox-overlay" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
          {b.label && <span>{b.label}</span>}
        </div>
      ))}
      {err && <div className="video-err">{err}</div>}
    </div>
  );
}

/* ---------- staff draws a bounding box over the live blurred room view ---------- */
function BboxEditor({ camera, onRect, value, drawing = false, saved = [], selectedSlotId }) {
  const vRef = useRef(null);
  const cRef = useRef(null);
  const [rect, setRect] = useState(null);
  const drag = useRef(null);
  const [err, setErr] = useState('');
  useEffect(() => setRect(value || null), [value]);

  useEffect(() => {
    let pc;
    setErr('');
    setRect(null);
    playWhep(vRef.current, `${camera}_blurred`, tokenFor).then((p) => (pc = p)).catch((e) => setErr(e.message));
    return () => pc && pc.close();
  }, [camera]);

  const pos = (e) => {
    const r = cRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const down = (e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = pos(e); setRect(null); };
  const move = (e) => {
    if (!drag.current) return;
    const p = pos(e);
    const r = { x: Math.min(drag.current.x, p.x), y: Math.min(drag.current.y, p.y),
      w: Math.abs(p.x - drag.current.x), h: Math.abs(p.y - drag.current.y) };
    setRect(r);
  };
  const up = (e) => {
    if (!drag.current) return;
    const p = pos(e), start = drag.current;
    const next = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    if (next.w > 0.02 && next.h > 0.02) { setRect(next); onRect(next); }
    drag.current = null;
  };

  return (
    <div className="video-wrap">
      <video ref={vRef} autoPlay muted playsInline />
      {saved.map((b) => <div key={b.id} className={`bbox-overlay ${b.id === selectedSlotId ? 'selected' : ''} ${b.blur_enabled ? 'blur-mask' : ''}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}><span>{b.patient_name || b.label}{b.blur_enabled ? ' · Blurred' : ''}</span></div>)}
      <canvas ref={cRef} className="bbox-canvas" style={{ pointerEvents: drawing ? 'auto' : 'none', cursor: drawing ? 'crosshair' : 'default' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {rect && <div className="bbox-overlay draft" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}><span>New bed box</span></div>}
      {err && <div className="video-err">{err}</div>}
      <p className="hint">{drawing ? 'Drag around one bed, then keep the box.' : 'Choose Draw box to mark a bed manually.'}</p>
    </div>
  );
}

/* ---------- views ---------- */
function Login({ onLogin }) {
  const [email, setEmail] = useState('admin@hospital.test');
  const [pass, setPass] = useState('admin123');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email, pass } });
      if (r.role !== 'staff' && r.role !== 'admin') return setErr('This dashboard is for hospital staff.');
      localStorage.setItem('token', r.token);
      onLogin(r);
    } catch (ex) { setErr(ex.message); }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>Kusum <small>Hospital Dashboard</small></h1>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff email" />
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="password" />
      {err && <p className="err">{err}</p>}
      <button>Sign in</button>
    </form>
  );
}

function Patients() {
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [lastCode, setLastCode] = useState('');
  const [form, setForm] = useState({ name: '', age: '', gender: 'male', bed_code: '', diagnosis: '', guardian_name: '', guardian_phone: '', guardian_relation: '', camera_id: 'room_1' });
  const load = useCallback(() => api('/patients').then((d) => setRows(d.patients)), []);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/patients', { method: 'POST', body: form });
      setLastCode(r.linking_code);
      setShowForm(false);
      load();
    } catch (ex) { alert(ex.message); }
  };
  const F = (k, ph, type = 'text') => <input required={k !== 'diagnosis'} type={type} placeholder={ph} value={form[k]} onChange={set(k)} />;
  return (
    <section>
      <div className="row"><h2>Patients</h2>
        <button onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ Register patient'}</button></div>
      {lastCode && <div className="card ok">Patient registered. Linking code for the guardian: <b className="code">{lastCode}</b> — share it only with the verified guardian.</div>}
      {showForm && (
        <form className="card grid" onSubmit={create}>
          {F('name', 'patient full name')}{F('age', 'age', 'number')}{F('bed_code', 'bed / room code')}
          <select value={form.gender} onChange={set('gender')}><option>male</option><option>female</option><option>other</option></select>
          {F('camera_id', 'camera id (room_1)')}
          {F('diagnosis', 'condition / diagnosis')}{F('guardian_name', 'guardian full name')}{F('guardian_phone', 'guardian phone')}
          {F('guardian_relation', 'guardian relation (wife, son…)')}
          <button>Register</button>
        </form>
      )}
      <table>
        <thead><tr><th>Name</th><th>Bed</th><th>Guardian</th><th>Linking code</th><th>Camera</th><th>Bbox</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.id}>
            <td>{p.name} ({p.age ?? '—'})</td><td>{p.bed_code}</td>
            <td>{p.guardian_name} · {p.guardian_relation || '—'} · {p.guardian_phone}</td>
            <td className="code">{p.linking_code}</td><td>{p.camera_id}</td>
            <td>{p.bbox_id ? '✅ assigned' : '—'}</td>
          </tr>))}
        </tbody>
      </table>
    </section>
  );
}

function Requests() {
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);
  const [rect, setRect] = useState(null);
  const [beds, setBeds] = useState([]);
  const [bedErr, setBedErr] = useState('');
  const load = useCallback(() => api('/requests?status=pending').then((d) => setRows(d.requests)), []);
  useEffect(() => { load(); }, [load]);
  const pick = (r) => {
    setSel(r); setRect(r.bed_slot_id ? { x: r.bed_x, y: r.bed_y, w: r.bed_w, h: r.bed_h } : null); setBeds([]); setBedErr('');
    api(`/detect-beds?camera=${encodeURIComponent(r.camera_id)}`)
      .then((d) => setBeds(d.beds || []))
      .catch((e) => setBedErr(e.message));
  };
  const detect = () => sel && pick(sel);
  const decide = async (approve) => {
    try {
      if (approve) {
        if (!rect) return alert('Pick a detected bed or draw the bounding box first.');
        await api(`/requests/${sel.id}/approve`, { method: 'POST', body: { bbox: rect } });
      } else {
        await api(`/requests/${sel.id}/reject`, { method: 'POST' });
      }
      setSel(null);
      load();
    } catch (ex) { alert(ex.message); }
  };
  const s = sel && sel.submitted ? JSON.parse(sel.submitted) : null;
  return (
    <section>
      <h2>Guardian access requests</h2>
      {rows.length === 0 && <p className="hint">No pending requests.</p>}
      <table>
        <thead><tr><th>Guardian account</th><th>Patient</th><th>Submitted</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className={sel?.id === r.id ? 'sel' : ''} onClick={() => pick(r)}>
            <td>{r.guardian_account_name} · {r.guardian_email}</td><td>{r.patient_name} ({r.bed_code})</td>
            <td>{new Date(r.created_at).toLocaleString()}</td>
          </tr>))}
        </tbody>
      </table>
      {sel && s && (
        <div className="card">
          <h3>Verify request #{sel.id}</h3>
          <div className="verify">
            <div><h4>Guardian submitted</h4>
              <p>Patient: <b>{s.patient_name}</b></p><p>Guardian: <b>{s.guardian_name}</b></p><p>Phone: <b>{s.guardian_phone}</b></p>
              <p className="hint">Account: {sel.guardian_account_name} ({sel.guardian_email})</p></div>
            <div><h4>Hospital record</h4>
              <p>Patient: <b>{sel.patient_name}</b></p><p>Guardian: <b>{sel.rec_guardian_name}</b></p><p>Phone: <b>{sel.rec_guardian_phone}</b></p>
              <p className="hint">Bed: {sel.bed_code} · camera {sel.camera_id}</p></div>
          </div>
          <div className="row"><h4>Bounding box</h4><span className="spacer" />
            <button onClick={detect}>Re-detect beds (YOLO)</button></div>
          {bedErr && <p className="err">{bedErr}</p>}
          {!bedErr && beds.length > 0 && <p className="hint">{beds.length} bed(s) detected — click the right one.</p>}
          <BboxEditor camera={sel.camera_id} value={rect} onRect={setRect} suggestions={beds} />
          <div className="row">
            <button className="danger" onClick={() => decide(false)}>Reject</button>
            <button className="okb" onClick={() => decide(true)}>Approve with saved/drawn box</button>
          </div>
        </div>
      )}
    </section>
  );
}

function VideoBoxes() {
  const [rows, setRows] = useState([]);
  const [rect, setRect] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [beds, setBeds] = useState([]);
  const [slots, setSlots] = useState([]);
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  const [recordPatientId, setRecordPatientId] = useState(null);
  const [camera, setCamera] = useState('room_1');
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');
  const [detectMsg, setDetectMsg] = useState('');
  const [detecting, setDetecting] = useState(false);
  const load = useCallback(async () => {
    const [p, b] = await Promise.all([api('/patients'), api(`/bed-slots?camera=${encodeURIComponent(camera)}`)]);
    setRows(p.patients); setSlots(b.slots); return b;
  }, [camera]);
  useEffect(() => { load().catch((e) => setMsg(e.message)); }, [load]);
  useEffect(() => {
    if (slots.length && !slots.some((s) => s.id === selectedSlotId)) {
      setSelectedSlotId(slots[0].id);
      setRecordPatientId(slots[0].patient_id || null);
    }
  }, [slots, selectedSlotId]);
  const selectedSlot = slots.find((s) => s.id === selectedSlotId) || null;
  const detect = async () => {
    setDetecting(true);
    setDetectMsg('Detecting beds…');
    setBeds([]);
    try {
      const d = await api(`/detect-beds?camera=${encodeURIComponent(camera)}`);
      setBeds(d.beds || []);
      setDetectMsg(d.beds?.length ? `${d.beds.length} beds detected. Click one or draw a box.` : 'No beds detected. Draw a box manually.');
    } catch (ex) { setDetectMsg(`Bed detection failed: ${ex.message}`); }
    finally { setDetecting(false); }
  };
  const keep = async () => {
    if (!rect) return setMsg('Choose Draw box and mark one bed first.');
    try {
      const saved = await api('/bed-slots', { method: 'POST', body: { camera_id: camera, label: `Bed ${slots.length + 1}`, ...rect } });
      setSelectedSlotId(saved.id); setRect(null); setDrawing(false); setMsg('Bed box kept. It will remain available when patients change.');
      await load();
    } catch (ex) { alert(ex.message); }
  };
  const assign = async (slotId, patientId) => {
    try { await api(`/bed-slots/${slotId}/assign`, { method: 'POST', body: { patient_id: patientId || null } }); await load(); }
    catch (ex) { setMsg(ex.message); }
  };
  const updateSlot = async (slot) => {
    try { await api('/bed-slots', { method: 'POST', body: { id: slot.id, camera_id: camera, ...rect } }); setRect(null); setMsg('Bed position updated and broadcast crop refreshed.'); await load(); }
    catch (ex) { setMsg(ex.message); }
  };
  const moveSlot = (step) => {
    if (!slots.length) return;
    const current = Math.max(0, slots.findIndex((s) => s.id === selectedSlotId));
    const next = slots[(current + step + slots.length) % slots.length];
    setSelectedSlotId(next.id); setRecordPatientId(next.patient_id || null);
    setRect(null);
  };
  const resetDraft = () => { setRect(null); setDrawing(false); setEditorKey((n) => n + 1); setMsg('Draft cleared. Saved boxes were not changed.'); };
  const assignSelected = (patientId) => {
    if (!selectedSlot) return;
    setRecordPatientId(patientId ? Number(patientId) : null);
    assign(selectedSlot.id, patientId);
  };
  const resetSlot = async (slot) => {
    const label = slot.patient_name ? `${slot.patient_name}'s bed box` : slot.label;
    if (!window.confirm(`Reset ${label}? This removes that saved box and ends any guardian stream using it.`)) return;
    try {
      await api(`/bed-slots/${slot.id}/reset`, { method: 'POST', body: {} });
      setRect(null); setDrawing(false); setMsg(`${label} reset. Draw and keep a new box when ready.`); await load();
    } catch (ex) { setMsg(ex.message); }
  };
  const toggleBlur = async () => {
    if (!selectedSlot) return;
    try { await api(`/bed-slots/${selectedSlot.id}/blur`, { method: 'POST', body: { enabled: !selectedSlot.blur_enabled } }); setMsg(!selectedSlot.blur_enabled ? 'Blur enabled for this box and guardian view.' : 'Blur removed for this box.'); await load(); }
    catch (ex) { setMsg(`Could not update blur: ${ex.message}`); }
  };
  const visiblePatients = rows.filter((p) => `${p.name} ${p.bed_code} ${p.guardian_name} ${p.guardian_phone}`.toLowerCase().includes(search.toLowerCase()));
  const recordPatient = rows.find((p) => p.id === recordPatientId) || null;
  return (
    <section>
      <h2>Video & bounding boxes</h2>
      <p className="hint">Choose a camera, adjust YOLO boxes or draw bed positions, then keep them. Saved bed positions stay when patients change and can be edited anytime.</p>
      <div className="row"><label>Camera <select value={camera} onChange={(e) => { setCamera(e.target.value); setRect(null); setBeds([]); }}>
        {[...new Set(rows.map((p) => p.camera_id))].map((c) => <option key={c}>{c}</option>)}
      </select></label>
        <button onClick={detect} disabled={detecting}>{detecting ? 'Detecting beds…' : 'Detect beds (YOLO)'}</button>
        <span className="hint" role="status">{detectMsg}</span></div>
      <div className="card">
        <h3>Bed positions · {camera}</h3>
          <div className="row">
            {beds.length > 0 && <span className="hint">{beds.length} suggestions — choose one or draw manually.</span>}
          </div>
          <BboxEditor key={editorKey} camera={camera} value={rect} onRect={setRect} drawing={drawing} saved={slots} selectedSlotId={selectedSlotId} />
          <div className="row"><button className={drawing ? 'active' : ''} onClick={() => { setRect(null); setDrawing(true); setMsg('Draw one bed box on the image.'); }}>Draw box</button>
            {drawing && <button className="ghost" onClick={() => setDrawing(false)}>Cancel drawing</button>}
            <button className="okb" onClick={keep} disabled={!rect}>Keep bed box</button><button className="danger" onClick={resetDraft}>Reset draft</button>
            {rect && slots.length > 0 && <><span className="spacer" /><label>Apply edited box to <select onChange={(e) => { const s = slots.find((v) => v.id === Number(e.target.value)); if (s) updateSlot(s); }} defaultValue=""><option value="">Choose saved bed…</option>{slots.map((s) => <option key={s.id} value={s.id}>{s.patient_name || s.label}</option>)}</select></label></>}</div>
          {beds.length > 0 && <div className="suggestion-list" aria-label="YOLO bed suggestions">{beds.map((b, i) => <button key={i} className="ghost" onClick={() => { setRect({ x: b.x, y: b.y, w: b.w, h: b.h }); setDrawing(false); setMsg(`Bed suggestion ${i + 1} loaded as a draft. Review it, then keep it.`); }}>Use suggestion {i + 1} · {(b.conf * 100).toFixed(0)}%</button>)}</div>}
          <div className="bed-selector row">
            <button className="ghost" aria-label="Previous bed box" onClick={() => moveSlot(-1)} disabled={!slots.length}>←</button>
            <span>{selectedSlot ? `Box ${slots.findIndex((s) => s.id === selectedSlot.id) + 1} of ${slots.length}: ${selectedSlot.patient_name || selectedSlot.label}` : 'No saved bed boxes'}</span>
            <button className="ghost" aria-label="Next bed box" onClick={() => moveSlot(1)} disabled={!slots.length}>→</button>
            {selectedSlot && <label>Assign patient <select value={selectedSlot.patient_id || ''} onChange={(e) => assignSelected(e.target.value)}>
              <option value="">No patient</option>{rows.filter((p) => p.status === 'active' && p.camera_id === camera).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.bed_code}</option>)}
            </select></label>}
            {selectedSlot && <button className={selectedSlot.blur_enabled ? 'active' : 'ghost'} onClick={toggleBlur}>{selectedSlot.blur_enabled ? 'Blur on · turn off' : 'Blur box'}</button>}
          </div>
          <div className="slot-list">{slots.map((slot, i) => <div className="slot-item" key={slot.id}>
            <button className={slot.id === selectedSlotId ? 'active' : 'ghost'} onClick={() => { setSelectedSlotId(slot.id); setRecordPatientId(slot.patient_id || null); setRect(null); }}>Box {i + 1} · {slot.patient_name || slot.label}</button>
            <button className="danger small" onClick={() => resetSlot(slot)} aria-label={`Reset box ${i + 1}`}>Reset box</button>
          </div>)}</div>
          <h3>Patient records</h3>
          <label className="search-row">Search patients <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, bed, guardian or phone" /></label>
          <div className="patient-record-list">{visiblePatients.map((p) => <button key={p.id} className={p.id === recordPatientId ? 'active' : 'ghost'} onClick={() => setRecordPatientId(p.id)}>{p.name} · {p.bed_code}</button>)}</div>
          {recordPatient && <div className="patient-record"><h4>{recordPatient.name} · Bed {recordPatient.bed_code}</h4>
            <p>Age: {recordPatient.age ?? '—'} · Gender: {recordPatient.gender || '—'} · Status: {recordPatient.status}</p>
            <p>Diagnosis: {recordPatient.diagnosis || '—'} · Camera: {recordPatient.camera_id}</p>
            <p>Guardian: {recordPatient.guardian_name} · {recordPatient.guardian_relation || '—'} · {recordPatient.guardian_phone}</p>
            <p>Linking code: <span className="code">{recordPatient.linking_code}</span></p>
          </div>}
          {msg && <p className="ok-msg">{msg}</p>}
        </div>
    </section>
  );
}

function Live() {
  const [data, setData] = useState(null);
  useEffect(() => { api('/streams').then(setData).catch((e) => alert(e.message)); }, []);
  if (!data) return <p className="hint">Loading…</p>;
  return (
    <section>
      <h2>Live ward view (privacy-blurred)</h2>
      <p className="hint">All frames pass the nudity-blur pipeline before leaving the server.</p>
      <div className="grid-cams">
        {data.cameras.map((cam) => (
          <div key={cam}>
            <h3>{cam}</h3>
            <LiveVideo path={`${cam}_blurred`} overlay
              boxes={(data.bed_slots || []).filter((b) => b.camera_id === cam)
                .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.patient_name ? `${b.patient_name} · ${b.bed_code}` : b.label }))} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Audit() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { api('/audit').then((d) => setLogs(d.logs)); }, []);  return (
    <section>
      <h2>Audit log</h2>
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>{logs.map((l) => (
          <tr key={l.id}><td>{new Date(l.ts).toLocaleString()}</td><td>{l.actor}</td><td>{l.action}</td><td>{l.detail}</td></tr>))}
        </tbody>
      </table>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('patients');
  useEffect(() => {
    if (localStorage.getItem('token')) api('/me').then((u) => {
      if (u.role === 'guardian') return localStorage.clear();
      setUser(u);
    }).catch(() => {});
  }, []);
  if (!user) return <Login onLogin={(r) => { setUser(r); }} />;
  const tabs = [['patients', 'Patients'], ['requests', 'Requests'], ['video', 'Video & Boxes'], ['live', 'Live view'], ['audit', 'Audit']];
  return (
    <div className="app">
      <nav className="row">
        <b>Kusum</b>
        {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        <span className="spacer" />
        <small>{user.name}</small>
        <button onClick={() => { localStorage.clear(); setUser(null); }}>Logout</button>
      </nav>
      {tab === 'patients' && <Patients />}
      {tab === 'requests' && <Requests />}
      {tab === 'video' && <VideoBoxes />}
      {tab === 'live' && <Live />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
