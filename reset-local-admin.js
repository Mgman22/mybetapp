'use strict';
// LOCAL DEVELOPMENT ONLY. This script resets only the local admin login.
// It does not run automatically on Railway; run-local.bat invokes it locally.
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const dbPath = path.join(__dirname, 'betting.db');
const passwordHash = bcrypt.hashSync('admin123', 10);
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err); else resolve(this);
  }));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
(async () => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      balance REAL DEFAULT 0,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'Active',
      failed_login_attempts INTEGER DEFAULT 0,
      locked_until DATETIME,
      last_login_at DATETIME
    )`);
    const columns = await all('PRAGMA table_info(users)');
    const existing = new Set(columns.map(c => c.name));
    const additions = [
      ['status', "TEXT DEFAULT 'Active'"],
      ['failed_login_attempts', 'INTEGER DEFAULT 0'],
      ['locked_until', 'DATETIME'],
      ['last_login_at', 'DATETIME']
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) await run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
    await run(`INSERT OR IGNORE INTO users (username,password,balance,role,status) VALUES ('admin',?,0,'admin','Active')`, [passwordHash]);
    await run(`UPDATE users SET password=?, role='admin', status='Active', failed_login_attempts=0, locked_until=NULL WHERE username='admin'`, [passwordHash]);
    const row = await get(`SELECT id,username,role,status FROM users WHERE username='admin'`);
    if (!row) throw new Error('Admin account could not be created.');
    console.log('Local admin account is ready.');
    console.log('Username: admin');
    console.log('Password: admin123');
    console.log('Account status: ' + row.status + ' | role: ' + row.role);
    console.log('Database: ' + dbPath);
    console.log('Only the local admin password/status were reset; existing users and balances were not deleted.');
    db.close();
  } catch (err) {
    console.error('Could not reset local admin:', err.message);
    db.close(() => process.exit(1));
  }
})();
