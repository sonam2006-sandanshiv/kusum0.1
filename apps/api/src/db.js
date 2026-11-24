'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPass } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'kusum.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff'
);
CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL, pass_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER, gender TEXT,
  bed_code TEXT NOT NULL UNIQUE, diagnosis TEXT,
  guardian_name TEXT NOT NULL, guardian_phone TEXT NOT NULL, guardian_relation TEXT,
  linking_code TEXT NOT NULL UNIQUE, camera_id TEXT NOT NULL DEFAULT 'room_1',
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS bboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id),
  camera_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  label TEXT, created_by INTEGER, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bed_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  label TEXT NOT NULL, created_by INTEGER, active INTEGER NOT NULL DEFAULT 1,
  blur_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  submitted TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS patient_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  bbox_id INTEGER NOT NULL REFERENCES bboxes(id),
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
`);

const bedSlotCols = db.prepare('PRAGMA table_info(bed_slots)').all().map((c) => c.name);
if (!bedSlotCols.includes('blur_enabled')) db.exec('ALTER TABLE bed_slots ADD COLUMN blur_enabled INTEGER NOT NULL DEFAULT 0');

// Bed geometry belongs to a camera/bed slot, not to the patient occupying it.
const patientCols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
if (!patientCols.includes('bed_slot_id')) db.exec('ALTER TABLE patients ADD COLUMN bed_slot_id INTEGER REFERENCES bed_slots(id)');
// Preserve any bed geometry from databases created by earlier app versions.
db.exec(`INSERT INTO bed_slots (camera_id,x,y,w,h,label,created_by)
  SELECT b.camera_id,b.x,b.y,b.w,b.h,COALESCE(b.label,'Bed'),b.created_by FROM bboxes b
  WHERE b.active=1 AND NOT EXISTS (SELECT 1 FROM bed_slots s WHERE s.camera_id=b.camera_id
    AND ABS(s.x-b.x)<0.0001 AND ABS(s.y-b.y)<0.0001 AND ABS(s.w-b.w)<0.0001 AND ABS(s.h-b.h)<0.0001)`);
db.exec(`UPDATE patients SET bed_slot_id=(SELECT s.id FROM bed_slots s JOIN bboxes b ON b.camera_id=s.camera_id
  AND ABS(s.x-b.x)<0.0001 AND ABS(s.y-b.y)<0.0001 AND ABS(s.w-b.w)<0.0001 AND ABS(s.h-b.h)<0.0001
  WHERE b.patient_id=patients.id AND b.active=1 ORDER BY b.id DESC LIMIT 1)
  WHERE bed_slot_id IS NULL AND EXISTS (SELECT 1 FROM bboxes b WHERE b.patient_id=patients.id AND b.active=1)`);

const now = () => new Date().toISOString();
const audit = (actor, action, detail = '') =>
  db.prepare('INSERT INTO audit_logs (ts, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(now(), actor, action, detail);

// First-boot seed: one hospital admin + one demo patient (matches README walkthrough).
if (db.prepare('SELECT COUNT(*) c FROM staff_users').get().c === 0) {
  db.prepare('INSERT INTO staff_users (name, email, pass_hash, role) VALUES (?, ?, ?, ?)')
    .run('Head Nurse', 'admin@hospital.test', hashPass('admin123'), 'admin');
  db.prepare(`INSERT INTO patients
      (name, age, gender, bed_code, diagnosis, guardian_name, guardian_phone, guardian_relation, linking_code, camera_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('Alex Demo', 34, 'unspecified', 'DEMO-101', 'Demo observation',
      'Jordan Demo', '0000000000', 'family member', 'KSM-DEMO01', 'room_1');
  audit('system', 'seed', 'admin user + demo patient created');
  console.log('[db] seeded admin@hospital.test / admin123 and demo patient (code KSM-DEMO01)');
}

module.exports = { db, audit, now };
