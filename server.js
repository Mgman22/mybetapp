const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
process.env.TZ = 'Asia/Yangon';
const YGN_TIMEZONE = 'Asia/Yangon';
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection & WAL Mode for Concurrency Safety
const db = new sqlite3.Database('./betting.db', (err) => {
    if (err) {
        console.error('Database opening error: ', err.message);
    } else {
        console.log('Connected to SQLite Database (betting.db).');
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA foreign_keys = ON;');
    }
});

// Myanmar-time safe helpers. Admin enters datetime-local in Myanmar time (Asia/Yangon).
// Railway containers may run in UTC, so naive timestamps must NOT be interpreted
// using the server timezone.
const MYANMAR_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;
const BET_LOCK_MINUTES = 15;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function parseMatchTime(timeStr) {
    if (!timeStr) return 0;
    let raw = String(timeStr).trim();
    if (!raw) return 0;

    // If an explicit timezone/offset is present, let JS parse it normally.
    if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const t = new Date(raw).getTime();
        return Number.isNaN(t) ? 0 : t;
    }

    raw = raw.replace(' ', 'T');
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
        const t = new Date(raw).getTime();
        return Number.isNaN(t) ? 0 : t;
    }

    const [, y, mo, d, h, mi, sec='00'] = m;
    // Convert Myanmar local clock -> UTC milliseconds explicitly.
    return Date.UTC(Number(y), Number(mo)-1, Number(d), Number(h), Number(mi), Number(sec)) - MYANMAR_OFFSET_MS;
}

function getBetLockTimeMs(matchTime, lockMinutes = BET_LOCK_MINUTES) {
    const kickoff = parseMatchTime(matchTime);
    const mins = Number(lockMinutes);
    return kickoff > 0 ? kickoff - (Number.isFinite(mins) ? mins : BET_LOCK_MINUTES) * 60 * 1000 : 0;
}

function getSiteSettingNumber(key, fallback=0, validFn=null) {
    return new Promise((resolve) => {
        db.get(`SELECT value FROM site_settings WHERE key=?`, [key], (err, row) => {
            if (err) return resolve(fallback);
            const n = Number(row?.value);
            if (!Number.isFinite(n)) return resolve(fallback);
            if (validFn && !validFn(n)) return resolve(fallback);
            resolve(n);
        });
    });
}

function resolveLateBetCapSettingsSync(rows) {
    const byKey = {};
    (rows || []).forEach(r => { byKey[String(r.key)] = r.value; });
    const enabled = String(byKey.late_bet_cap_enabled || '0') === '1';
    const amountRaw = Number(byKey.late_bet_cap_amount);
    return {
        enabled,
        // Fixed business rule: cap applies only during the final 5 minutes
        // immediately before the normal betting lock time.
        window_minutes: 5,
        amount: Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0
    };
}

function resolveMatchLockMinutes(match) {
    const globalMinutes = Number(match?.global_lock_minutes);
    const validGlobal = [2,5,10,15].includes(globalMinutes) ? globalMinutes : BET_LOCK_MINUTES;
    const specificMinutes = Number(match?.lock_minutes);
    const mode = String(match?.lock_mode || 'global').toLowerCase();
    return mode === 'override' && [2,5,10,15].includes(specificMinutes) ? specificMinutes : validGlobal;
}

function isBettingLocked(match) {
    if (!match) return true;
    if (String(match.status || '').toLowerCase() !== 'open') return true;
    const lockAt = getBetLockTimeMs(match.match_time, resolveMatchLockMinutes(match));
    return lockAt > 0 && Date.now() >= lockAt;
}

function decorateMatch(match) {
    const kickoffMs = parseMatchTime(match.match_time);
    const globalMinutes = Number.isFinite(Number(match.global_lock_minutes)) && [2,5,10,15].includes(Number(match.global_lock_minutes)) ? Number(match.global_lock_minutes) : BET_LOCK_MINUTES;
    const lockMinutes = String(match.lock_mode || 'global').toLowerCase() === 'override' && [2,5,10,15].includes(Number(match.lock_minutes)) ? Number(match.lock_minutes) : globalMinutes;
    const lockAtMs = getBetLockTimeMs(match.match_time, lockMinutes);
    const locked = isBettingLocked(match);
    const lateWindow = Number(match?.late_bet_cap_window_minutes);
    const lateAmount = Number(match?.late_bet_cap_amount);
    const lateEnabled = String(match?.late_bet_cap_enabled ?? '0') === '1' && Number.isFinite(lateAmount) && lateAmount > 0;
    return {
        ...match,
        kickoff_at_ms: kickoffMs || null,
        betting_lock_at_ms: lockAtMs || null,
        betting_open: !locked,
        betting_lock_minutes: lockMinutes,
        late_bet_cap_enabled: lateEnabled,
        late_bet_cap_window_minutes: [2,5,10,15,30].includes(lateWindow) ? lateWindow : null,
        late_bet_cap_amount: lateEnabled ? lateAmount : 0
    };
}

// Database Initialization
db.serialize(() => {
    // 1. Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
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

    // Security migrations for existing users table.
    db.all(`PRAGMA table_info(users)`, [], (err, columns) => {
        if (err || !columns) return;
        const existing = new Set(columns.map(c => c.name));
        const migrations = [
            ['status', `TEXT DEFAULT 'Active'`],
            ['failed_login_attempts', 'INTEGER DEFAULT 0'],
            ['locked_until', 'DATETIME'],
            ['last_login_at', 'DATETIME']
        ];
        migrations.forEach(([name, type]) => {
            if (!existing.has(name)) db.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);

    // 2. Matches Table
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        league TEXT DEFAULT 'ENGLISH PREMIER LEAGUE',
        custom_match_id TEXT UNIQUE,
        match_name TEXT,
        body_odds TEXT,
        body_favored_side TEXT DEFAULT 'home',
        goal_odds TEXT,
        match_time TEXT,
        status TEXT DEFAULT 'Open',
        home_score INTEGER,
        away_score INTEGER
    )`);

    // 3. Bets Table
    db.run(`CREATE TABLE IF NOT EXISTS bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        match_id TEXT,
        match_name TEXT,
        bet_type TEXT,
        choice TEXT,
        amount REAL,
        odds_rate TEXT,
        status TEXT DEFAULT 'Pending',
        parlay_group_id TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Schema migration: older Railway databases may have been created before
    // parlay_group_id was introduced. CREATE TABLE IF NOT EXISTS does not add
    // missing columns, so explicitly migrate the existing table.
    db.all(`PRAGMA table_info(bets)`, [], (err, columns) => {
        if (err) {
            console.error('bets schema check failed:', err.message);
            return;
        }
        const hasParlayGroupId = columns.some(c => c.name === 'parlay_group_id');
        if (!hasParlayGroupId) {
            db.run(`ALTER TABLE bets ADD COLUMN parlay_group_id TEXT DEFAULT NULL`, (alterErr) => {
                if (alterErr) console.error('bets migration failed:', alterErr.message);
                else console.log('Database migration: added bets.parlay_group_id');
            });
        }
    });

    // Settlement audit columns. Existing Railway databases are migrated automatically.
    db.all(`PRAGMA table_info(bets)`, [], (err, columns) => {
        if (err || !columns) return;
        const existing = new Set(columns.map(c => c.name));
        const migrations = [
            ['result_factor', 'REAL DEFAULT 0'],
            ['gross_profit', 'REAL DEFAULT 0'],
            ['commission', 'REAL DEFAULT 0'],
            ['net_profit', 'REAL DEFAULT 0'],
            ['payout', 'REAL DEFAULT 0'],
            ['settled_at', 'DATETIME']
        ];
        migrations.forEach(([name, type]) => {
            if (!existing.has(name)) {
                db.run(`ALTER TABLE bets ADD COLUMN ${name} ${type}`, (e) => {
                    if (e) console.error(`bets migration failed (${name}):`, e.message);
                    else console.log(`Database migration: added bets.${name}`);
                });
            }
        });
    });

    // Canonical match/ticket snapshot fields. Match DB ID isolates records even when team names or custom IDs repeat.
    db.all(`PRAGMA table_info(bets)`, [], (err, columns) => {
        if (err || !columns) return;
        const existing = new Set(columns.map(c => c.name));
        const migrations = [['match_db_id','INTEGER'],['ticket_no','TEXT']];
        migrations.forEach(([name,type]) => {
            if (!existing.has(name)) db.run(`ALTER TABLE bets ADD COLUMN ${name} ${type}`, (e)=>{ if(e) console.error(`bets migration failed (${name}):`,e.message); });
        });
        db.run(`UPDATE bets SET match_db_id=(SELECT m.id FROM matches m WHERE CAST(m.custom_match_id AS TEXT)=CAST(bets.match_id AS TEXT) LIMIT 1) WHERE match_db_id IS NULL`,()=>{});
        db.run(`UPDATE bets SET match_db_id=CAST(match_id AS INTEGER) WHERE match_db_id IS NULL AND CAST(match_id AS INTEGER)>0`,()=>{});
        db.run(`UPDATE bets SET ticket_no='LEGACY-'||id WHERE ticket_no IS NULL OR ticket_no=''`,()=>{});
    });

    // 4. Transactions Table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        type TEXT,
        payment_method TEXT,
        account_name TEXT,
        phone TEXT,
        amount REAL,
        transaction_id TEXT,
        status TEXT DEFAULT 'Pending',
        processed_by TEXT,
        process_by_who TEXT,
        process_by_where TEXT,
        processed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Admin notifications for user deposit/withdraw requests
    db.run(`CREATE TABLE IF NOT EXISTS admin_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        reference_type TEXT DEFAULT '',
        reference_id TEXT DEFAULT '',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Per-bettor / per-match betting limits. Zero means unlimited until Admin sets a cap.
    db.run(`CREATE TABLE IF NOT EXISTS bettor_match_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        match_db_id INTEGER NOT NULL,
        body_home_limit REAL NOT NULL DEFAULT 0,
        body_away_limit REAL NOT NULL DEFAULT 0,
        gp_over_limit REAL NOT NULL DEFAULT 0,
        gp_under_limit REAL NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, match_db_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bettor_match_limits_user_match ON bettor_match_limits(user_id, match_db_id)`);

    // Generalized bet-limit rules: user_id=0 means all markers; match_db_id=0 means all matches.
    db.run(`CREATE TABLE IF NOT EXISTS bet_limit_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        match_db_id INTEGER NOT NULL DEFAULT 0,
        body_home_limit REAL NOT NULL DEFAULT 0,
        body_away_limit REAL NOT NULL DEFAULT 0,
        gp_over_limit REAL NOT NULL DEFAULT 0,
        gp_under_limit REAL NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, match_db_id)
    )`);
    db.run(`INSERT OR IGNORE INTO bet_limit_rules (user_id,match_db_id,body_home_limit,body_away_limit,gp_over_limit,gp_under_limit,updated_by,updated_at)
            SELECT user_id,match_db_id,body_home_limit,body_away_limit,gp_over_limit,gp_under_limit,updated_by,updated_at FROM bettor_match_limits`);

    // 5. Risk Forwards Table
    db.run(`CREATE TABLE IF NOT EXISTS risk_forwards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        choice TEXT,
        amount REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS risk_layouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_db_id INTEGER NOT NULL,
        match_id TEXT NOT NULL,
        home_layout REAL DEFAULT 0,
        away_layout REAL DEFAULT 0,
        over_layout REAL DEFAULT 0,
        under_layout REAL DEFAULT 0,
        total_layout REAL DEFAULT 0,
        status TEXT DEFAULT 'Confirmed',
        confirmed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS odds_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_db_id INTEGER NOT NULL,
        body_odds TEXT, goal_odds TEXT,
        changed_by TEXT,
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS admin_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_type TEXT NOT NULL,
        username TEXT,
        amount REAL DEFAULT 0,
        direction TEXT,
        reference_type TEXT,
        reference_id TEXT,
        reason TEXT,
        processed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        balance_after REAL DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS balance_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        processed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.all(`PRAGMA table_info(admin_ledger)`, [], (e, cols) => {
        if (!e && cols && !cols.some(c=>c.name==='balance_after')) db.run(`ALTER TABLE admin_ledger ADD COLUMN balance_after REAL DEFAULT 0`);
    });
    db.all(`PRAGMA table_info(transactions)`, [], (e, cols) => {
        if (e || !cols) return;
        const existing = new Set(cols.map(c => c.name));
        const add = [
            ['processed_by','TEXT'],
            ['process_by_who','TEXT'],
            ['process_by_where','TEXT'],
            ['processed_at','DATETIME']
        ];
        for (const [name, type] of add) {
            if (!existing.has(name)) db.run(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`);
        }
    });
    // Website settings / admin announcements
    // IMPORTANT: create the table before any INSERT. Older databases may not
    // have site_settings yet, so startup must never query it before creation.
    db.run(`CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('marker_low_balance_threshold','100000')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('marker_critical_balance_threshold','25000')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('global_lock_minutes','15')`);
    db.run(`INSERT OR IGNORE INTO site_settings (key, value) VALUES ('bettor_notice', 'Admin Notice: Welcome to our betting service.')`);
    db.run(`INSERT OR IGNORE INTO site_settings (key, value) VALUES ('bettor_notice_enabled', '1')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('bettor_rules','Please read the rules before placing a bet.\nBets cannot be cancelled after confirmation.\nBetting is available only before the closing time.')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('bettor_rules_enabled','1')`);
    // Versioned rule acknowledgements ensure a bettor re-accepts only when Admin changes the rules.
    db.run(`CREATE TABLE IF NOT EXISTS user_rule_acceptances (
        user_id INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, rules_version)
    )`);
    // Publication control is separate from the score itself and never triggers settlement.
    db.run(`CREATE TABLE IF NOT EXISTS final_score_publications (
        match_db_id INTEGER PRIMARY KEY,
        published INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
    )`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('late_bet_cap_enabled','0')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('late_bet_cap_window_minutes','10')`);
    db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('late_bet_cap_amount','0')`);

    // Default Admin Account (Password: admin123)
    const defaultAdminPass = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, balance, role) VALUES ('admin', ?, 0, 'admin')`, [defaultAdminPass]);

    // Security migration: older databases may contain plaintext passwords.
    // Hash them in-place while preserving the existing login password.
    db.all(`SELECT id, password FROM users`, [], (passwordErr, passwordRows) => {
        if (passwordErr || !passwordRows) return;
        passwordRows.forEach(row => {
            const pw = String(row.password || '');
            if (!/^\$2[aby]\$/.test(pw)) {
                const hashed = bcrypt.hashSync(pw, 10);
                db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, row.id]);
            }
        });
    });
});

// Helper Function: Auto-close expired matches
function checkAndCloseExpiredMatches(callback) {
    const nowMs = Date.now();
    db.all(`SELECT id, match_time FROM matches WHERE status = 'Open'`, [], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            if (callback) callback();
            return;
        }

        const expiredIds = rows.filter(row => {
            const matchTimeMs = parseMatchTime(row.match_time);
            return matchTimeMs > 0 && matchTimeMs <= nowMs;
        }).map(row => row.id);

        if (expiredIds.length > 0) {
            const placeholders = expiredIds.map(() => '?').join(',');
            db.run(`UPDATE matches SET status = 'Closed' WHERE id IN (${placeholders})`, expiredIds, () => {
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    });
}

// ================= ACCURATE MYANMAR SETTLEMENT ENGINE =================
// Myanmar odds rule used by this app:
//   1+50  -> exact line = +50% (half win), beyond line = +100% win
//   1-20  -> exact line = -20% (partial loss), beyond line = +100% win
//   1=    -> exact line = draw/refund, beyond line = +100% win
// The same line logic is applied to Body and Goal markets. The selected
// side is inverted for the opposing team / Under.
// Commission is ALWAYS 5% of positive profit only. It is NEVER charged on stake.
const COMMISSION_RATE = 0.05;

function parseOdds(oddsStr) {
    if (!oddsStr) return { baseGoal: 0, sign: '=', val: 0 };
    const str = String(oddsStr).trim().replace(/\s+/g, '');

    let sign = '=';
    let idx = -1;
    for (let i = 1; i < str.length; i++) {
        if (str[i] === '+' || str[i] === '-' || str[i] === '=') {
            sign = str[i];
            idx = i;
            break;
        }
    }

    if (idx === -1) {
        // Support decimal quarter-line input such as 1.5 as a fallback.
        const numeric = Number(str);
        if (Number.isFinite(numeric)) {
            const base = Math.floor(numeric);
            const frac = Math.round((numeric - base) * 100);
            if (frac === 50) return { baseGoal: base, sign: '+', val: 100 };
            return { baseGoal: base, sign: '=', val: 0 };
        }
        return { baseGoal: 0, sign: '=', val: 0 };
    }

    const baseGoal = parseInt(str.slice(0, idx), 10) || 0;
    const val = parseInt(str.slice(idx + 1), 10) || 0;
    return { baseGoal, sign, val };
}

function factorForLine(resultValue, oddsStr) {
    const { baseGoal, sign, val } = parseOdds(oddsStr);
    const diff = Number(resultValue) - baseGoal;

    if (diff > 0) return 1.0;
    if (diff < 0) return -1.0;

    // Exact line: Myanmar partial line / draw rule.
    if (sign === '=') return 0.0;
    if (sign === '+') return Math.max(0, Math.min(1, val / 100));
    if (sign === '-') return -Math.max(0, Math.min(1, val / 100));
    return 0.0;
}

function formatOutcomeStatus(factor) {
    const rounded = Math.round(Number(factor) * 100) / 100;
    if (rounded >= 1) return 'Won';
    if (rounded <= -1) return 'Lost';
    if (rounded === 0) return 'Draw';
    const pct = Math.round(Math.abs(rounded) * 100);
    return rounded > 0 ? `Won (${pct}%)` : `Lost (${pct}%)`;
}

function calculateBetOutcome(betType, choice, oddsStr, homeScore, awayScore, matchName, amount, bodyFavoredSide = 'home') {
    const home = Number(homeScore);
    const away = Number(awayScore);
    const betAmount = Number(amount) || 0;
    const totalGoals = home + away;
    const goalDiff = home - away;
    const type = String(betType || '').toLowerCase();
    const selected = String(choice || '').trim();
    const teams = String(matchName || '').split(/\s+vs\s+/i).map(x => x.trim());
    const actualHomeTeam = teams[0] || '';
    const actualAwayTeam = teams[1] || '';
    const favoredSide = String(bodyFavoredSide || 'home').toLowerCase() === 'away' ? 'away' : 'home';
    const favoredTeam = favoredSide === 'away' ? actualAwayTeam : actualHomeTeam;

    let factor;
    if (type.includes('goal') || type.includes('ဂိုးပေါင်း')) {
        const overFactor = factorForLine(totalGoals, oddsStr);
        const isOver = /over|ပေါ်/i.test(selected);
        factor = isOver ? overFactor : -overFactor;
    } else if (type.includes('body') || type.includes('ဘော်ဒီ')) {
        // Body odds are based on the selected favored/price team, not the football home team.
        // For an away-favored match, reverse the score difference so the favored team is the reference side.
        const favoredGoalDiff = favoredSide === 'away' ? (away - home) : goalDiff;
        const bodyFactor = factorForLine(favoredGoalDiff, oddsStr);
        const isFavored = selected === favoredTeam;
        factor = isFavored ? bodyFactor : -bodyFactor;
    } else {
        factor = -1;
    }

    factor = Math.max(-1, Math.min(1, Number(factor) || 0));
    const status = formatOutcomeStatus(factor);

    // Commission is only on positive winnings/profit, not on the original stake.
    const grossProfit = factor > 0 ? betAmount * factor : 0;
    const commission = grossProfit * COMMISSION_RATE;
    const netProfit = grossProfit - commission;
    const payout = factor > 0
        ? betAmount + Math.floor(netProfit)
        : factor === 0
            ? betAmount
            : Math.floor(betAmount * (1 + factor));

    return {
        status,
        winFactor: factor,
        grossProfit,
        commission,
        netProfit,
        returnAmount: payout
    };
}

// ================= SECURITY HELPERS ================= //
function tokenFromRequest(req) {
    const auth = String(req.headers.authorization || '');
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function createSession(userId, callback) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, userId, expiresAt], err => {
        if (err) return callback(err);
        callback(null, token, expiresAt);
    });
}

function getAuthUser(req, callback) {
    const token = tokenFromRequest(req);
    if (!token) return callback(null, null);
    db.get(`SELECT s.token, s.expires_at, u.id, u.username, u.balance, u.role, u.status
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token = ?`, [token], (err, row) => {
        if (err || !row) return callback(err, null);
        if (new Date(row.expires_at).getTime() <= Date.now()) {
            db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
            return callback(null, null);
        }
        if (String(row.status).toLowerCase() !== 'active') return callback(null, null);
        db.run(`UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token = ?`, [token]);
        callback(null, row);
    });
}

function requireAuth(req, res, next) {
    getAuthUser(req, (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'Authentication service error' });
        if (!user) return res.status(401).json({ success: false, message: 'Login required', code: 'AUTH_REQUIRED' });
        req.authUser = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.authUser.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin access required' });
        next();
    });
}

function requireUser(req, res, next) {
    requireAuth(req, res, () => {
        if (req.authUser.role !== 'user') return res.status(403).json({ success: false, message: 'Bettor access required' });
        next();
    });
}

function invalidateUserSessions(userId) {
    db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

// Remove expired sessions periodically.
setInterval(() => db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [new Date().toISOString()]), 30 * 60 * 1000).unref();

// ================= WEBSITE NOTICE APIs ================= //
// Public read: bettor panel uses this for the hero marquee.
app.get('/api/notice', (req, res) => {
    db.all(`SELECT key, value, updated_at FROM site_settings WHERE key IN ('bettor_notice','bettor_notice_enabled')`, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, message:'Notice load failed' });
        const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
        res.json({ success:true, notice: map.bettor_notice || '', enabled: map.bettor_notice_enabled !== '0', updated_at: (rows || []).find(r => r.key === 'bettor_notice')?.updated_at || null });
    });
});

app.post('/api/admin/notice', requireAdmin, (req, res) => {
    const notice = String(req.body.notice || '').trim().slice(0, 500);
    const enabled = req.body.enabled === false || String(req.body.enabled) === '0' ? '0' : '1';
    db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('bettor_notice',?,CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, [notice], (e) => {
        if (e) return res.status(500).json({success:false,message:e.message});
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('bettor_notice_enabled',?,CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, [enabled], (e2) => {
            if (e2) return res.status(500).json({success:false,message:e2.message});
            res.json({success:true, notice, enabled: enabled === '1'});
        });
    });
});

// ================= BETTOR RULES & REGULATIONS APIs ================= //
app.get('/api/rules', (req, res) => {
    db.all(`SELECT key, value, updated_at FROM site_settings WHERE key IN ('bettor_rules','bettor_rules_enabled')`, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, message:'Rules load failed' });
        const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
        res.json({ success:true, rules: map.bettor_rules || '', enabled: map.bettor_rules_enabled !== '0', updated_at: (rows || []).find(r => r.key === 'bettor_rules')?.updated_at || null });
    });
});

function computeRulesVersion(rules, updatedAt) {
    return crypto.createHash('sha256').update(`${String(updatedAt || '')}\n${String(rules || '')}`).digest('hex');
}

function getCurrentRules(callback) {
    db.all(`SELECT key, value, updated_at FROM site_settings WHERE key IN ('bettor_rules','bettor_rules_enabled')`, [], (err, rows) => {
        if (err) return callback(err);
        const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
        const ruleRow = (rows || []).find(r => r.key === 'bettor_rules');
        const rules = String(map.bettor_rules || '');
        const enabled = map.bettor_rules_enabled !== '0' && !!rules.trim();
        const version = computeRulesVersion(rules, ruleRow?.updated_at || '');
        callback(null, { rules, enabled, version, updated_at: ruleRow?.updated_at || null });
    });
}

// Authenticated Bettor gate: rules are served together with the current version and acceptance state.
app.get('/api/user/rules-status', requireUser, (req, res) => {
    getCurrentRules((err, current) => {
        if (err) return res.status(500).json({ success:false, message:'Could not load current rules.' });
        if (!current.enabled) return res.json({ success:true, enabled:false, rules:current.rules, version:current.version, accepted:true });
        db.get(`SELECT 1 AS accepted FROM user_rule_acceptances WHERE user_id=? AND rules_version=?`,
            [req.authUser.id, current.version], (e, row) => {
                if (e) return res.status(500).json({ success:false, message:'Could not verify rules acceptance.' });
                res.json({ success:true, enabled:true, rules:current.rules, version:current.version, updated_at:current.updated_at, accepted:!!row });
            });
    });
});

app.post('/api/user/accept-rules', requireUser, (req, res) => {
    const requestedVersion = String(req.body.version || '');
    getCurrentRules((err, current) => {
        if (err) return res.status(500).json({ success:false, message:'Could not verify rules.' });
        if (!current.enabled) return res.json({ success:true, accepted:true, version:current.version });
        if (!requestedVersion || requestedVersion !== current.version) {
            return res.status(409).json({ success:false, code:'RULES_UPDATED', message:'Rules have changed. Please review the latest rules.' });
        }
        db.run(`INSERT OR IGNORE INTO user_rule_acceptances(user_id,rules_version,accepted_at) VALUES(?,?,CURRENT_TIMESTAMP)`,
            [req.authUser.id, current.version], (e) => {
                if (e) return res.status(500).json({ success:false, message:'Could not save rules acceptance.' });
                res.json({ success:true, accepted:true, version:current.version });
            });
    });
});

// Public ticker endpoint: only explicitly published scores are returned.
app.get('/api/final-scores', requireUser, (req, res) => {
    db.all(`SELECT m.id, m.custom_match_id, m.match_name, m.league, m.match_time,
                   m.home_score, m.away_score, m.status, p.published_at
            FROM matches m JOIN final_score_publications p ON p.match_db_id=m.id
            WHERE p.published=1 AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
              AND LOWER(COALESCE(m.status,'')) IN ('finished','settled')
            ORDER BY COALESCE(p.published_at, p.updated_at) DESC, m.match_time DESC LIMIT 12`, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, message:'Could not load published final scores.' });
        res.json({ success:true, data:rows || [] });
    });
});

// Admin score list: score entry and ticker publication are intentionally separate from settlement.
app.get('/api/admin/final-scores', requireAdmin, (req, res) => {
    db.all(`SELECT m.*, COALESCE(p.published,0) AS marquee_published,
                   p.updated_at AS marquee_updated_at, p.published_at AS marquee_published_at
            FROM matches m LEFT JOIN final_score_publications p ON p.match_db_id=m.id
            ORDER BY m.match_time DESC, m.id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, message:'Could not load final score manager.' });
        res.json({ success:true, data:rows || [] });
    });
});

// Read-only score preview: computes projected outcomes without updating bets, balances or settlement status.
app.post('/api/admin/matches/:id/score-preview', requireAdmin, (req, res) => {
    const matchDbId = Number(req.params.id);
    const hs = Number(req.body.home_score), as = Number(req.body.away_score);
    if (!Number.isInteger(matchDbId) || matchDbId <= 0 || !Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0 || hs > 99 || as > 99) {
        return res.status(400).json({ success:false, message:'Enter whole-number scores from 0 to 99.' });
    }
    db.get('SELECT * FROM matches WHERE id=?', [matchDbId], (matchErr, match) => {
        if (matchErr) return res.status(500).json({success:false,message:'Could not load match.'});
        if (!match) return res.status(404).json({success:false,message:'Match not found.'});
        db.all(`SELECT username, match_name, bet_type, choice, amount, odds_rate, status, parlay_group_id
                FROM bets WHERE (match_db_id=? OR (match_db_id IS NULL AND CAST(match_id AS TEXT)=CAST(? AS TEXT)))`,
            [matchDbId, match.custom_match_id], (betsErr, bets) => {
                if (betsErr) return res.status(500).json({success:false,message:'Could not load bets for preview.'});
                const pending = (bets || []).filter(b => String(b.status || 'Pending').toLowerCase() === 'pending');
                const singles = pending.filter(b => !b.parlay_group_id);
                const markets = { home:0, away:0, over:0, under:0 };
                const markers = {};
                let projectedAdminPL = 0, stakeTotal = 0;
                for (const bet of singles) {
                    const type = String(bet.bet_type || '').toLowerCase();
                    const choice = String(bet.choice || '');
                    const amount = Number(bet.amount) || 0;
                    const isGoal = type.includes('goal') || type.includes('gp') || type.includes('ဂိုးပေါင်း');
                    let key;
                    if (isGoal) key = /over|ပေါ်/i.test(choice) ? 'over' : 'under';
                    else key = choice === String((match.match_name || '').split(/\s+vs\s+/i)[0] || '') ? 'home' : 'away';
                    markets[key] += amount;
                    stakeTotal += amount;
                    const outcome = calculateBetOutcome(bet.bet_type, bet.choice, bet.odds_rate, hs, as,
                        bet.match_name || match.match_name, amount, match.body_favored_side || 'home');
                    projectedAdminPL += amount - Number(outcome.returnAmount || 0);
                    const marker = bet.username || 'Unknown';
                    if (!markers[marker]) markers[marker] = { marker, home:0, away:0, over:0, under:0, projectedPL:0, stake:0 };
                    markers[marker][key] += amount;
                    markers[marker].projectedPL += amount - Number(outcome.returnAmount || 0);
                    markers[marker].stake += amount;
                }
                res.json({success:true, preview_only:true, settlement_performed:false,
                    match:{id:match.id, match_id:match.custom_match_id, match_name:match.match_name},
                    score:{home:hs, away:as}, markets, stake_total:stakeTotal,
                    projected_admin_pl:Math.floor(projectedAdminPL), marker_breakdown:Object.values(markers),
                    pending_single_bets:singles.length, excluded_parlay_bets:pending.length-singles.length,
                    note:'Preview only. No tickets, balances, statuses or settlement records were changed.'});
            });
    });
});

app.post('/api/admin/final-scores/:id/score', requireAdmin, (req, res) => {
    const matchDbId = Number(req.params.id);
    const hs = Number(req.body.home_score), as = Number(req.body.away_score);
    if (!Number.isInteger(matchDbId) || matchDbId <= 0 || !Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0 || hs > 99 || as > 99) {
        return res.status(400).json({ success:false, message:'Enter valid whole-number scores from 0 to 99.' });
    }
    db.get(`SELECT * FROM matches WHERE id=?`, [matchDbId], (err, match) => {
        if (err) return res.status(500).json({ success:false, message:err.message });
        if (!match) return res.status(404).json({ success:false, message:'Match not found.' });
        const status = String(match.status || '').toLowerCase();
        if (['settled','cancelled','postponed'].includes(status)) {
            return res.status(409).json({ success:false, message:'Scores cannot be edited here for a settled, cancelled or postponed match.' });
        }
        const changed = match.home_score === null || match.home_score === undefined || match.away_score === null || match.away_score === undefined || Number(match.home_score) !== hs || Number(match.away_score) !== as;
        db.run(`UPDATE matches SET home_score=?, away_score=?, status='Finished' WHERE id=?`, [hs, as, matchDbId], function(updateErr) {
            if (updateErr) return res.status(500).json({ success:false, message:updateErr.message });
            // If an already-published score is corrected, unpublish it until Admin republishes the corrected score.
            const continueResponse = () => {
                writeSecurityAudit({ username:req.authUser?.username || 'admin', role:'admin', action:'SAVE_FINAL_SCORE', module:'Final Score Manager', target:String(match.custom_match_id || match.id), details:`Score saved: ${hs}-${as}; settlement not run`, severity:'INFO' }, ()=>{});
                res.json({ success:true, home_score:hs, away_score:as, settlement_performed:false,
                    message: changed ? 'Final score saved. No settlement was performed. Review and publish the score when ready.' : 'Final score saved. No settlement was performed.' });
            };
            if (changed) {
                db.run(`UPDATE final_score_publications SET published=0, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE match_db_id=? AND published=1`,
                    [req.authUser?.username || 'admin', matchDbId], (publicationErr) => {
                        if (publicationErr) return res.status(500).json({ success:false, message:'Score saved, but marquee publication could not be reset. Please hide the score and verify it before publishing again.' });
                        continueResponse();
                    });
            } else continueResponse();
        });
    });
});

app.patch('/api/admin/final-scores/:id/publish', requireAdmin, (req, res) => {
    const matchDbId = Number(req.params.id);
    const published = req.body.published === true || String(req.body.published) === '1' ? 1 : 0;
    if (!Number.isInteger(matchDbId) || matchDbId <= 0) return res.status(400).json({ success:false, message:'Invalid match.' });
    db.get(`SELECT * FROM matches WHERE id=?`, [matchDbId], (err, match) => {
        if (err) return res.status(500).json({ success:false, message:err.message });
        if (!match) return res.status(404).json({ success:false, message:'Match not found.' });
        if (published && (match.home_score === null || match.home_score === undefined || match.away_score === null || match.away_score === undefined || !['finished','settled'].includes(String(match.status||'').toLowerCase()))) {
            return res.status(400).json({ success:false, message:'Save a valid final score first before publishing.' });
        }
        db.run(`INSERT INTO final_score_publications(match_db_id,published,updated_by,updated_at,published_at)
                VALUES(?,?,?,CURRENT_TIMESTAMP,${published ? 'CURRENT_TIMESTAMP' : 'NULL'})
                ON CONFLICT(match_db_id) DO UPDATE SET published=excluded.published, updated_by=excluded.updated_by,
                    updated_at=CURRENT_TIMESTAMP, published_at=${published ? 'CURRENT_TIMESTAMP' : 'final_score_publications.published_at'}`,
            [matchDbId, published, req.authUser?.username || 'admin'], function(saveErr) {
                if (saveErr) return res.status(500).json({ success:false, message:saveErr.message });
                writeSecurityAudit({ username:req.authUser?.username || 'admin', role:'admin', action:published ? 'PUBLISH_FINAL_SCORE' : 'HIDE_FINAL_SCORE', module:'Final Score Manager', target:String(match.custom_match_id || match.id), details:`Final score ${published ? 'published to' : 'hidden from'} Bettor marquee`, severity:'INFO' }, ()=>{});
                res.json({ success:true, published:!!published, message:published ? 'Final score published to Bettor Panel.' : 'Final score hidden from Bettor Panel.' });
            });
    });
});

app.post('/api/admin/rules', requireAdmin, (req, res) => {
    const rules = String(req.body.rules || '').trim().slice(0, 10000);
    const enabled = req.body.enabled === false || String(req.body.enabled) === '0' ? '0' : '1';
    db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('bettor_rules',?,CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, [rules], (e) => {
        if (e) return res.status(500).json({success:false,message:e.message});
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('bettor_rules_enabled',?,CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, [enabled], (e2) => {
            if (e2) return res.status(500).json({success:false,message:e2.message});
            const username = req.authUser?.username || 'admin';
            writeSecurityAudit({username,role:'admin',action:'UPDATE_RULES',module:'Rules',target:'Bettor Rules',details:`Rules ${enabled === '1' ? 'enabled' : 'disabled'}`,severity:'INFO'}, ()=>{});
            res.json({success:true, rules, enabled: enabled === '1'});
        });
    });
});

// ================= AUTH APIs ================= //
app.post('/api/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username နှင့် Password ထည့်သွင်းပါ။' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!row) return res.status(401).json({ success: false, message: 'Invalid username or password' });
        if (String(row.status || 'Active').toLowerCase() !== 'active') return res.status(403).json({ success: false, message: 'Account is inactive' });
        if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
            return res.status(423).json({ success: false, message: 'Too many failed attempts. Please try again later.' });
        }

        bcrypt.compare(password, row.password, (compareErr, match) => {
            if (compareErr) return res.status(500).json({ success: false, message: compareErr.message });
            if (!match) {
                const attempts = Number(row.failed_login_attempts || 0) + 1;
                if (attempts >= MAX_LOGIN_ATTEMPTS) {
                    const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
                    db.run(`UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?`, [lockedUntil, row.id]);
                    return res.status(423).json({ success: false, message: 'Too many failed attempts. Account temporarily locked for 15 minutes.' });
                }
                db.run(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`, [attempts, row.id]);
                return res.status(401).json({ success: false, message: 'Invalid username or password' });
            }

            db.run(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
            createSession(row.id, (sessionErr, token, expiresAt) => {
                if (sessionErr) return res.status(500).json({ success: false, message: sessionErr.message });
                const userInfo = { id: row.id, username: row.username, balance: row.balance, role: row.role, status: row.status || 'Active', expires_at: expiresAt };
                if (String(row.role||'').toLowerCase() === 'admin') writeSecurityAudit({username:row.username,role:row.role,action:'LOGIN_SUCCESS',module:'auth',target:row.username,details:'Successful admin login',severity:'INFO',device:auditDevice(req),ip_address:auditIp(req)});
                res.json({ success: true, token, user: userInfo });
            });
        });
    });
});

app.post('/api/logout', requireAuth, (req, res) => {
    const token = tokenFromRequest(req);
    db.run(`DELETE FROM sessions WHERE token = ?`, [token], () => {
        writeSecurityAudit({username:req.authUser.username,role:req.authUser.role,action:'LOGOUT',module:'auth',target:req.authUser.username,details:'User logout',severity:'INFO',device:auditDevice(req),ip_address:auditIp(req)});
        res.json({ success: true });
    });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ success: true, user: { id: req.authUser.id, username: req.authUser.username, balance: req.authUser.balance, role: req.authUser.role, status: req.authUser.status } });
});

// Phase-1 API guard: every business endpoint below login requires a valid session.
app.use('/api', (req, res, next) => {
    const pathName = req.path;
    if (pathName === '/login' || pathName === '/logout' || pathName === '/me') return next();
    if (pathName.startsWith('/admin/') || pathName === '/users' || pathName.startsWith('/users/')) {
        return requireAdmin(req, res, next);
    }
    if (pathName.startsWith('/user/')) return requireUser(req, res, next);
    if (pathName === '/bets' || pathName.startsWith('/bets/')) {
        if (req.method === 'GET') return requireAuth(req, res, next);
        return requireAdmin(req, res, next);
    }
    if (pathName === '/matches' || pathName.startsWith('/matches/')) {
        if (req.method === 'GET') return requireAuth(req, res, next);
        return requireAdmin(req, res, next);
    }
    return requireAuth(req, res, next);
});

// Automatically audit successful mutating API calls made by authenticated admins.
// Sensitive request bodies are never stored; only a short endpoint summary is kept.
app.use('/api', (req,res,next)=>{
    res.on('finish',()=>{
        if (!req.authUser || String(req.authUser.role||'').toLowerCase() !== 'admin') return;
        if (!['POST','PUT','PATCH','DELETE'].includes(String(req.method||'').toUpperCase())) return;
        if (req.path === '/login' || req.path === '/logout') return;
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        const parts=String(req.path||'').split('/').filter(Boolean);
        const module=parts[0]||'api';
        const action=`${req.method} ${req.path}`.slice(0,180);
        let target='';
        const id=parts.find((x,i)=> i>0 && (/^\d+$/.test(x) || x.length>12));
        if(id) target=id;
        let details='';
        const safeKeys=['status','type','minutes','match_id','transaction_id','choice'];
        if(req.body && typeof req.body==='object'){
            const picked={};
            safeKeys.forEach(k=>{ if(req.body[k]!==undefined && req.body[k]!==null) picked[k]=String(req.body[k]).slice(0,120); });
            details=Object.keys(picked).length?JSON.stringify(picked):'';
        }
        writeSecurityAudit({username:req.authUser.username,role:req.authUser.role,action,module,target,details,severity:(req.method==='DELETE'?'WARNING':'INFO'),device:auditDevice(req),ip_address:auditIp(req)});
    });
    next();
});


app.get('/api/user/balance', requireUser, (req, res) => {
    const username = req.authUser.username;
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: row.balance });
    });
});

// ================= USER MANAGEMENT APIs ================= //
app.get(['/api/users', '/api/admin/users'], requireAdmin, (req, res) => {
    db.all(`SELECT id, username, balance, role, status, last_login_at, failed_login_attempts, locked_until FROM users WHERE role = 'user' ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.post(['/api/users', '/api/admin/create-user'], requireAdmin, (req, res) => {
    const { username, password, balance, initial_balance } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username နှင့် Password လိုအပ်ပါသည်။' });
    }
    const initialBal = balance !== undefined ? Number(balance) : (Number(initial_balance) || 0);

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(`INSERT INTO users (username, password, balance, role, status) VALUES (?, ?, ?, 'user', 'Active')`, 
        [username, hashedPassword, initialBal], function(err) {
        if (err) return res.status(400).json({ success: false, message: 'Username ဖြင့် အကောင့်ရှိပြီးသားဖြစ်ပါသည် သို့မဟုတ် အချက်အလက်မှားယွင်းနေပါသည်။' });
        const userId = this.lastID;
        if (initialBal > 0) addAdminLedger({entry_type:'Marker Opening Balance',username,amount:initialBal,direction:'OUT',reference_type:'User',reference_id:userId,reason:'Initial marker balance',processed_by:req.authUser.username});
        res.json({ success: true, message: 'User account created successfully', userId });
    });
});

app.post(['/api/users/add-balance', '/api/admin/update-balance'], requireAdmin, (req, res) => {
    const username = String(req.body.username || '').trim();
    const amt = Number(req.body.amount);
    const reason = String(req.body.reason || '').trim();
    if (!username || !Number.isFinite(amt) || amt === 0 || !reason) return res.status(400).json({ success: false, message: 'Marker, amount and reason are required.' });
    db.get(`SELECT id, balance FROM users WHERE username = ? AND role='user'`, [username], (e, user) => {
        if (e) return res.status(500).json({success:false,error:e.message});
        if (!user) return res.status(404).json({success:false,message:'Marker not found'});
        const next = Number(user.balance||0) + amt;
        if (next < 0) return res.status(400).json({success:false,message:'Marker balance cannot be negative.'});
        db.serialize(()=>{
            db.run('BEGIN TRANSACTION');
            db.run(`UPDATE users SET balance=? WHERE id=?`, [next,user.id], function(ue){
                if(ue){db.run('ROLLBACK');return res.status(500).json({success:false,error:ue.message});}
                db.run(`INSERT INTO balance_adjustments(username,amount,reason,processed_by) VALUES(?,?,?,?)`,[username,amt,reason,req.authUser.username]);
                const procMeta = transactionProcessMeta(req, false);
                db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,processed_by,process_by_who,process_by_where,processed_at,created_at) VALUES(?, 'Adjustment','Admin',?,'Completed',?,?,?,?,CURRENT_TIMESTAMP)`,[username,Math.abs(amt),procMeta.processedBy,procMeta.who,procMeta.where,new Date().toISOString()]);
                const direction = amt > 0 ? 'OUT' : 'IN';
                db.run(`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by,balance_after) VALUES('Balance Adjustment',?,?,?,?,?,?,?,?)`,[username,Math.abs(amt),direction,'User',String(user.id),reason,req.authUser.username,next],(le)=>{
                    if(le){db.run('ROLLBACK');return res.status(500).json({success:false,error:le.message});}
                    db.run('COMMIT',ce=>res.json({success:!ce,message:ce?'Adjustment failed':'Balance adjusted',balance:next}));
                });
            });
        });
    });
});

// ================= USER PROFILE / ADMIN USER EDIT APIs ================= //
app.post('/api/user/change-password', requireUser, (req, res) => {
    const username = req.authUser.username;
    const { current_password, new_password } = req.body;
    if (!username || !current_password || !new_password) {
        return res.status(400).json({ success: false, message: 'လက်ရှိ Password နှင့် Password အသစ် ဖြည့်ပါ။' });
    }
    if (String(new_password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password အသစ်သည် အနည်းဆုံး 6 လုံးရှိရပါမည်။' });
    }

    db.get(`SELECT id, password, role FROM users WHERE username = ?`, [username], (err, user) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!user || user.role !== 'user') {
            return res.status(404).json({ success: false, message: 'User account မတွေ့ပါ။' });
        }

        bcrypt.compare(current_password, user.password, (compareErr, ok) => {
            if (compareErr) return res.status(500).json({ success: false, error: compareErr.message });
            if (!ok) return res.status(400).json({ success: false, message: 'လက်ရှိ Password မှားနေပါသည်။' });

            const hashed = bcrypt.hashSync(new_password, 10);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                invalidateUserSessions(user.id);
                res.json({ success: true, message: 'Password ပြောင်းပြီးပါပြီ။ Login ပြန်ဝင်ပါ။', relogin_required: true });
            });
        });
    });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ success:false, message:'Current and new password are required' });
    if (String(new_password).length < 8) return res.status(400).json({ success:false, message:'Admin password must be at least 8 characters' });
    db.get(`SELECT id, password FROM users WHERE id = ? AND role = 'admin'`, [req.authUser.id], (err, user) => {
        if (err) return res.status(500).json({success:false,message:err.message});
        if (!user) return res.status(404).json({success:false,message:'Admin account not found'});
        bcrypt.compare(current_password, user.password, (e, ok) => {
            if (e) return res.status(500).json({success:false,message:e.message});
            if (!ok) return res.status(400).json({success:false,message:'Current password is incorrect'});
            const hashed = bcrypt.hashSync(new_password, 12);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({success:false,message:updateErr.message});
                invalidateUserSessions(user.id);
                res.json({success:true,message:'Admin password changed. Please login again.',relogin_required:true});
            });
        });
    });
});

// Admin: edit username / balance / optional password. Username changes are
// propagated to historical bet and transaction records so the account history
// remains attached to the edited user.
app.put(['/api/users/:id', '/api/admin/users/:id'], requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    const { username, password, balance } = req.body;
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ success: false, message: 'User ID မမှန်ကန်ပါ။' });
    }
    const newUsername = String(username || '').trim();
    if (!newUsername) return res.status(400).json({ success: false, message: 'Username ဖြည့်ပါ။' });

    db.get(`SELECT id, username, role FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!user || user.role !== 'user') return res.status(404).json({ success: false, message: 'User မတွေ့ပါ။' });

        const nextBalance = balance === undefined || balance === '' ? null : Number(balance);
        if (nextBalance !== null && (!Number.isFinite(nextBalance) || nextBalance < 0)) {
            return res.status(400).json({ success: false, message: 'Balance မမှန်ကန်ပါ။' });
        }

        db.get(`SELECT id FROM users WHERE username = ? AND id <> ?`, [newUsername, userId], (dupErr, duplicate) => {
            if (dupErr) return res.status(500).json({ success: false, error: dupErr.message });
            if (duplicate) return res.status(400).json({ success: false, message: 'ဒီ Username ဖြင့် အကောင့်ရှိပြီးသားပါ။' });

            const oldUsername = user.username;
            const passwordClause = password && String(password).trim()
                ? `, password = ?`
                : '';
            const params = [newUsername];
            if (nextBalance !== null) {
                params.push(nextBalance);
            }
            if (passwordClause) params.push(bcrypt.hashSync(String(password).trim(), 10));
            params.push(userId);

            let sql = `UPDATE users SET username = ?`;
            if (nextBalance !== null) sql += `, balance = ?`;
            sql += passwordClause + ` WHERE id = ?`;

            db.run(sql, params, function(updateErr) {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });

                if (passwordClause) invalidateUserSessions(userId);
                if (oldUsername !== newUsername) {
                    db.run(`UPDATE bets SET username = ? WHERE username = ?`, [newUsername, oldUsername]);
                    db.run(`UPDATE transactions SET username = ? WHERE username = ?`, [newUsername, oldUsername]);
                }
                res.json({ success: true, message: 'User information updated successfully' });
            });
        });
    });
});

// Admin: permanently remove a bettor account and its betting/transaction data.
// The admin account itself can never be deleted through this endpoint.
app.delete(['/api/users/:id', '/api/admin/users/:id'], requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ success: false, message: 'User ID မမှန်ကန်ပါ။' });
    }

    db.get(`SELECT id, username, role FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!user) return res.status(404).json({ success: false, message: 'User မတွေ့ပါ။' });
        if (user.role === 'admin') return res.status(403).json({ success: false, message: 'Admin account ကို ဖျက်၍မရပါ။' });

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run(`DELETE FROM bets WHERE username = ?`, [user.username], (betErr) => {
                if (betErr) { db.run('ROLLBACK'); return res.status(500).json({ success: false, error: betErr.message }); }
                db.run(`DELETE FROM transactions WHERE username = ?`, [user.username], (txErr) => {
                    if (txErr) { db.run('ROLLBACK'); return res.status(500).json({ success: false, error: txErr.message }); }
                    db.run(`DELETE FROM users WHERE id = ?`, [userId], (deleteErr) => {
                        if (deleteErr) { db.run('ROLLBACK'); return res.status(500).json({ success: false, error: deleteErr.message }); }
                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) return res.status(500).json({ success: false, error: commitErr.message });
                            res.json({ success: true, message: `User ${user.username} deleted successfully` });
                        });
                    });
                });
            });
        });
    });
});

// Admin: activate/deactivate bettor account. Deactivation immediately invalidates sessions.
app.post('/api/users/:id/reset-password', requireAdmin, (req,res)=>{ const pw=String(req.body.password||''); if(pw.length<6)return res.status(400).json({success:false,message:'Password must be at least 6 characters'}); const hash=bcrypt.hashSync(pw,10); db.run(`UPDATE users SET password=? WHERE id=? AND role='user'`,[hash,req.params.id],function(e){if(e)return res.status(500).json({success:false,error:e.message});if(!this.changes)return res.status(404).json({success:false,message:'User not found'});db.run(`DELETE FROM sessions WHERE user_id=?`,[req.params.id]);res.json({success:true});});});

app.patch(['/api/users/:id/status', '/api/admin/users/:id/status'], requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    const status = String(req.body.status || '').trim();
    if (!['Active', 'Suspend', 'Inactive'].includes(status)) return res.status(400).json({ success: false, message: 'Status must be Active, Suspend or Inactive' });
    db.get(`SELECT id, role FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!user || user.role !== 'user') return res.status(404).json({ success: false, message: 'User မတွေ့ပါ။' });
        db.run(`UPDATE users SET status = ? WHERE id = ?`, [status, userId], function(e) {
            if (e) return res.status(500).json({ success: false, message: e.message });
            if (status === 'Inactive') invalidateUserSessions(userId);
            res.json({ success: true, status });
        });
    });
});

function getGlobalLockMinutes(callback) {
    db.get(`SELECT value FROM site_settings WHERE key='global_lock_minutes'`, [], (err,row)=>{
        const n=Number(row?.value); callback(err, Number.isFinite(n) && [2,5,10,15].includes(n) ? n : BET_LOCK_MINUTES);
    });
}

app.get('/api/time', requireAuth, (req,res)=>res.json({success:true,server_now_ms:Date.now(),server_now_iso:new Date().toISOString(),timezone:YGN_TIMEZONE}));

// ================= GENERALIZED BET LIMIT RULES ================= //
app.get('/api/admin/bet-limits', requireAdmin, (req, res) => {
    db.all(`SELECT l.*, CASE WHEN l.user_id=0 THEN 'All Markers' ELSE u.username END AS username,
                   CASE WHEN l.match_db_id=0 THEN 'All Matches' ELSE m.custom_match_id END AS custom_match_id,
                   CASE WHEN l.match_db_id=0 THEN 'All Matches' ELSE m.match_name END AS match_name,
                   CASE WHEN l.user_id=0 AND l.match_db_id=0 THEN 'all' WHEN l.user_id=0 THEN 'all-markers' WHEN l.match_db_id=0 THEN 'all-matches' ELSE 'specific' END AS scope_type
            FROM bet_limit_rules l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN matches m ON m.id=l.match_db_id
            ORDER BY l.updated_at DESC, l.id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, message:'Could not load bet limits.', error:err.message });
        res.json({ success:true, data:rows || [] });
    });
});

app.post('/api/admin/bet-limits', requireAdmin, (req, res) => {
    const rawUser = String(req.body.user_id ?? '');
    const rawMatch = String(req.body.match_db_id ?? '');
    const userId = rawUser === 'all' || rawUser === '0' ? 0 : Number(rawUser);
    const matchDbId = rawMatch === 'all' || rawMatch === '0' ? 0 : Number(rawMatch);
    const fields = ['body_home_limit','body_away_limit','gp_over_limit','gp_under_limit'];
    const values = fields.map(k => Number(req.body[k] ?? 0));
    if (!Number.isInteger(userId) || userId < 0 || !Number.isInteger(matchDbId) || matchDbId < 0 || values.some(v => !Number.isFinite(v) || v < 0))
        return res.status(400).json({ success:false, message:'Choose valid marker/match scopes and enter non-negative limits (0 = unlimited).' });
    const checkUser = cb => userId === 0 ? cb(null, true) : db.get(`SELECT id FROM users WHERE id=? AND role='user'`, [userId], (e,r)=>cb(e,!!r));
    const checkMatch = cb => matchDbId === 0 ? cb(null, true) : db.get(`SELECT id FROM matches WHERE id=?`, [matchDbId], (e,r)=>cb(e,!!r));
    checkUser((userErr, userOk) => {
        if (userErr) return res.status(500).json({success:false,error:userErr.message});
        if (!userOk) return res.status(404).json({success:false,message:'Marker account not found.'});
        checkMatch((matchErr, matchOk) => {
            if (matchErr) return res.status(500).json({success:false,error:matchErr.message});
            if (!matchOk) return res.status(404).json({success:false,message:'Match not found.'});
            db.run(`INSERT INTO bet_limit_rules (user_id,match_db_id,body_home_limit,body_away_limit,gp_over_limit,gp_under_limit,updated_by,updated_at)
                    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id,match_db_id) DO UPDATE SET body_home_limit=excluded.body_home_limit,body_away_limit=excluded.body_away_limit,
                    gp_over_limit=excluded.gp_over_limit,gp_under_limit=excluded.gp_under_limit,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
                [userId,matchDbId,...values,req.authUser.username], function(err) {
                    if (err) return res.status(500).json({success:false,message:'Could not save bet limits.',error:err.message});
                    res.json({success:true,message:'Bet limits saved.'});
                });
        });
    });
});

app.delete('/api/admin/bet-limits', requireAdmin, (req, res) => {
    const userRaw=String(req.query.user_id ?? ''), matchRaw=String(req.query.match_db_id ?? '');
    const userId=userRaw==='all'||userRaw==='0'?0:Number(userRaw), matchDbId=matchRaw==='all'||matchRaw==='0'?0:Number(matchRaw);
    if (!Number.isInteger(userId) || userId < 0 || !Number.isInteger(matchDbId) || matchDbId < 0)
        return res.status(400).json({success:false,message:'Invalid marker or match scope.'});
    db.run(`DELETE FROM bet_limit_rules WHERE user_id=? AND match_db_id=?`,[userId,matchDbId],function(err){
        if(err) return res.status(500).json({success:false,error:err.message});
        res.json({success:true,message:this.changes?'Bet limit rule removed.':'No saved rule was found.'});
    });
});

// ================= MATCH MANAGEMENT APIs ================= //
app.get(['/api/matches', '/api/admin/matches'], requireAuth, (req, res) => {
    checkAndCloseExpiredMatches(() => {
        db.all(`SELECT m.*,
        (SELECT CAST(value AS INTEGER) FROM site_settings WHERE key='global_lock_minutes') AS global_lock_minutes,
        (SELECT value FROM site_settings WHERE key='late_bet_cap_enabled') AS late_bet_cap_enabled,
        (SELECT CAST(value AS INTEGER) FROM site_settings WHERE key='late_bet_cap_window_minutes') AS late_bet_cap_window_minutes,
        (SELECT CAST(value AS REAL) FROM site_settings WHERE key='late_bet_cap_amount') AS late_bet_cap_amount
        FROM matches m`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const sorted = (rows || []).sort((a, b) => {
                const aid = String(a.custom_match_id ?? a.id ?? '');
                const bid = String(b.custom_match_id ?? b.id ?? '');
                const an = aid.match(/(\d+)/);
                const bn = bid.match(/(\d+)/);
                if (an && bn && Number(an[1]) !== Number(bn[1])) return Number(an[1]) - Number(bn[1]);
                if (aid !== bid) return aid.localeCompare(bid, undefined, { numeric: true, sensitivity: 'base' });
                return parseMatchTime(a.match_time) - parseMatchTime(b.match_time);
            });
            res.json({ success: true, server_now_ms: Date.now(), server_now_iso: new Date().toISOString(), timezone: YGN_TIMEZONE, data: sorted.map(decorateMatch) });
        });
    });
});

app.post(['/api/matches', '/api/admin/add-match'], requireAdmin, (req, res) => {
    const { league, custom_match_id, match_name, team_a, team_b, body_odds, goal_odds, match_time, lock_minutes, lock_mode } = req.body;
    const bodyFavoredSide = String(req.body.body_favored_side || 'home').toLowerCase() === 'away' ? 'away' : 'home';
    
    const finalMatchName = match_name || `${team_a} vs ${team_b}`;
    const mId = custom_match_id || ('M-' + Date.now());
    const requestedLock = Number(lock_minutes);
    const lockMode = String(lock_mode || '').toLowerCase() === 'override' && [2,5,10,15].includes(requestedLock) ? 'override' : 'global';
    const lockValue = lockMode === 'override' ? requestedLock : null;

    if (!custom_match_id || !String(league || '').trim() || !String(finalMatchName || '').trim() || !String(match_time || '').trim() || !String(body_odds || '').trim() || !String(goal_odds || '').trim()) {
        return res.status(400).json({ success: false, message: 'Match ID, League, Teams, Kickoff, Body Odds နှင့် GP Odds အားလုံး ဖြည့်ပေးပါ။' });
    }
    if (String(team_a || '').trim().toLowerCase() === String(team_b || '').trim().toLowerCase() && team_a && team_b) {
        return res.status(400).json({ success: false, message: 'Home Team နှင့် Away Team တူလို့မရပါ။' });
    }
    db.get(`SELECT id FROM matches WHERE LOWER(CAST(custom_match_id AS TEXT)) = LOWER(?)`, [String(custom_match_id).trim()], (checkErr, existing) => {
      if (checkErr) return res.status(500).json({ success: false, error: checkErr.message });
      if (existing) return res.status(409).json({ success: false, message: `Match ID ${String(custom_match_id).trim()} ရှိပြီးသားဖြစ်ပါတယ်။ အခြား Match ID သုံးပါ။` });
      db.run(`INSERT INTO matches (league, custom_match_id, match_name, body_odds, body_favored_side, goal_odds, match_time, status, lock_mode, lock_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)`,
        [String(league).trim(), String(custom_match_id).trim(), String(finalMatchName).trim(), body_odds, bodyFavoredSide, goal_odds, match_time, lockMode, lockValue], function(err) {
          if (err) {
            if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ success: false, message: `Match ID ${String(custom_match_id).trim()} ရှိပြီးသားဖြစ်ပါတယ်။` });
            return res.status(500).json({ success: false, error: err.message });
          }
          res.json({ success: true, message: 'Match added successfully', matchId: this.lastID });
        });
    });
});

app.patch('/api/matches/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    db.run(`UPDATE matches SET status = ? WHERE id = ? OR custom_match_id = ?`, [status, req.params.id, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match status updated successfully' });
    });
});

app.patch('/api/matches/:id/odds', requireAdmin, (req, res) => {
    const matchId = req.params.id;
    const { body_odds, goal_odds } = req.body;
    
    const query = `UPDATE matches SET body_odds = ?, goal_odds = ? WHERE id = ? OR custom_match_id = ?`;
    
    db.get(`SELECT * FROM matches WHERE id = ? OR custom_match_id = ?`, [matchId, matchId], (findErr, oldMatch) => {
      if (findErr || !oldMatch) return res.status(404).json({success:false,message:'Match not found'});
      db.run(query, [body_odds, goal_odds, matchId, matchId], function(err) {
        if (err) {
            console.error('Odds update error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: 'Match not found' });
        }

        db.run(`INSERT INTO odds_history(match_db_id,body_odds,goal_odds,changed_by) VALUES(?,?,?,?)`, [oldMatch.id, body_odds, goal_odds, req.authUser.username]);
        res.json({ success: true, message: 'ပွဲစဉ်ကြေးများကို အောင်မြင်စွာ ပြင်ဆင်ပြီးပါပြီ။' });
      });
    });
});

app.delete(['/api/matches/:id', '/api/admin/delete-match'], requireAdmin, (req, res) => {
    const matchId = req.params.id || req.body.match_id;
    db.run(`DELETE FROM matches WHERE id = ? OR custom_match_id = ?`, [matchId, matchId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match deleted successfully' });
    });
});

// Match management extensions
app.patch('/api/admin/matches/:id', requireAdmin, (req,res)=>{
  const {league,match_name,match_time,body_odds,goal_odds,status,lock_minutes,lock_mode}=req.body;
  const rawFavored=String(req.body.body_favored_side || '').trim().toLowerCase();
  const body_favored_side = ['home','away'].includes(rawFavored) ? rawFavored : 'home';
  const lm=[2,5,10,15].includes(Number(lock_minutes))?Number(lock_minutes):null;
  const mode=String(lock_mode||'global').toLowerCase()==='override' && lm!==null ? 'override' : 'global';
  const vals=[league,match_name,match_time,body_odds,goal_odds,status,mode,mode==='override'?lm:null,body_favored_side, req.params.id, req.params.id];
  db.run(`UPDATE matches SET league=?,match_name=?,match_time=?,body_odds=?,goal_odds=?,status=?,lock_mode=?,lock_minutes=?,body_favored_side=? WHERE id=? OR custom_match_id=?`,vals,function(e){
    if(e)return res.status(500).json({success:false,error:e.message}); res.json({success:true,changes:this.changes,body_favored_side});
  });
});
app.post('/api/admin/matches/:id/lock', requireAdmin, (req,res)=>{
  const raw = String(req.body.lock_minutes ?? '').trim();
  if (raw === 'global' || raw === '') {
    return db.run(`UPDATE matches SET lock_mode='global', lock_minutes=NULL WHERE id=? OR custom_match_id=?`,[req.params.id,req.params.id],function(e){
      if(e)return res.status(500).json({success:false,error:e.message});
      res.json({success:true,lock_mode:'global',lock_minutes:null});
    });
  }
  const lm=Number(raw); if(![2,5,10,15].includes(lm)) return res.status(400).json({success:false,message:'Lock must be 2, 5, 10 or 15 minutes'});
  db.run(`UPDATE matches SET lock_mode='override', lock_minutes=? WHERE id=? OR custom_match_id=?`,[lm,req.params.id,req.params.id],function(e){if(e)return res.status(500).json({success:false,error:e.message});res.json({success:true,lock_mode:'override',lock_minutes:lm});});
});
app.get('/api/admin/settings/marker-balance-thresholds', requireAdmin, (req,res)=>{
    db.all(`SELECT key,value FROM site_settings WHERE key IN ('marker_low_balance_threshold','marker_critical_balance_threshold')`, [], (e,rows)=>{
        if(e)return res.status(500).json({success:false,error:e.message});
        const cfg=Object.fromEntries((rows||[]).map(r=>[r.key,Number(r.value)]));
        res.json({success:true,low_balance_threshold:Number.isFinite(cfg.marker_low_balance_threshold)?cfg.marker_low_balance_threshold:100000,critical_balance_threshold:Number.isFinite(cfg.marker_critical_balance_threshold)?cfg.marker_critical_balance_threshold:25000});
    });
});
app.post('/api/admin/settings/marker-balance-thresholds', requireAdmin, (req,res)=>{
    const low=Number(req.body.low_balance_threshold), critical=Number(req.body.critical_balance_threshold);
    if(!Number.isFinite(low)||!Number.isFinite(critical)||low<0||critical<0||critical>=low||low>1000000000000||critical>1000000000000){
        return res.status(400).json({success:false,message:'Low balance must be greater than Critical balance; both values must be non-negative.'});
    }
    db.serialize(()=>{
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('marker_low_balance_threshold',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[String(low)]);
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('marker_critical_balance_threshold',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[String(critical)],e=>{
            if(e)return res.status(500).json({success:false,error:e.message});
            res.json({success:true,low_balance_threshold:low,critical_balance_threshold:critical});
        });
    });
});
app.get('/api/admin/settings/lock', requireAdmin,(req,res)=>getGlobalLockMinutes((e,n)=>res.json({success:!e,minutes:n})));
app.post('/api/admin/settings/lock', requireAdmin,(req,res)=>{const n=Number(req.body.minutes);if(![2,5,10,15].includes(n))return res.status(400).json({success:false,message:'Invalid lock minutes'});db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('global_lock_minutes',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[String(n)],e=>{if(e)return res.status(500).json({success:false,error:e.message});res.json({success:true,minutes:n});});});
app.get('/api/admin/settings/late-bet-cap', requireAdmin, (req,res)=>{
    db.all(`SELECT key,value FROM site_settings WHERE key IN ('late_bet_cap_enabled','late_bet_cap_window_minutes','late_bet_cap_amount')`, [], (e,rows)=>{
        if(e)return res.status(500).json({success:false,error:e.message});
        const cfg=resolveLateBetCapSettingsSync(rows);
        res.json({success:true,...cfg});
    });
});
app.post('/api/admin/settings/late-bet-cap', requireAdmin, (req,res)=>{
    const enabled = req.body.enabled ? '1' : '0';
    const windowMinutes = 5;
    const amount = Number(req.body.amount);
    if(!Number.isFinite(amount) || amount < 0) return res.status(400).json({success:false,message:'Invalid late betting amount'});
    if(enabled==='1' && amount<=0) return res.status(400).json({success:false,message:'Late betting amount must be greater than 0 when enabled'});
    db.serialize(()=>{
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('late_bet_cap_enabled',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[enabled]);
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('late_bet_cap_window_minutes',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[String(windowMinutes)]);
        db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES('late_bet_cap_amount',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[String(amount)],e=>{
            if(e)return res.status(500).json({success:false,error:e.message});
            res.json({success:true,enabled:enabled==='1',window_minutes:windowMinutes,amount});
        });
    });
});
app.get('/api/admin/odds-history/:id',requireAdmin,(req,res)=>db.all(`SELECT * FROM odds_history WHERE match_db_id=? ORDER BY id DESC`,[req.params.id],(e,r)=>{if(e)return res.status(500).json({success:false,error:e.message});res.json({success:true,data:r||[]});}));

// ================= MATCH SETTLEMENT API (WITH TRANSACTION SAFETY) ================= //
app.post(['/api/matches/save-result', '/api/admin/update-result'], requireAdmin, (req, res) => {
    const { match_id, home_score, away_score } = req.body;

    db.get(`SELECT * FROM matches WHERE id = ? OR custom_match_id = ?`, [match_id, match_id], (err, match) => {
        if (err || !match) return res.status(404).json({ success: false, message: 'Match not found' });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`UPDATE matches SET home_score = ?, away_score = ?, status = 'Finished' WHERE id = ?`, 
                [home_score, away_score, match.id], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ success: false, error: err.message });
                }

                db.all(`SELECT * FROM bets WHERE match_db_id = ? AND status = 'Pending'`, [match.id], (err, bets) => {
                    if (err) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ success: false, error: err.message });
                    }

                    if (!bets || bets.length === 0) {
                        db.run(`COMMIT`);
                        return res.json({ success: true, message: 'Match result saved! No pending bets to settle.' });
                    }

                    let completedCount = 0;
                    let hasError = false;
                    let pendingDbOps = 0;
                    let responseSent = false;

                    const maybeFinishSettlement = () => {
                        if (responseSent || completedCount !== bets.length || pendingDbOps !== 0) return;
                        responseSent = true;
                        if (hasError) {
                            db.run(`ROLLBACK`);
                            return res.status(500).json({ success: false, message: 'Error during settlement.' });
                        }
                        db.run(`COMMIT`, (commitErr) => {
                            if (commitErr) return res.status(500).json({ success: false, error: commitErr.message });
                            return res.json({ success: true, message: 'Match result saved and all bets settled successfully!' });
                        });
                    };

                    bets.forEach(bet => {
                        const odds = bet.odds_rate; // immutable odds snapshot from placement
                        const outcome = calculateBetOutcome(
                            bet.bet_type,
                            bet.choice,
                            odds,
                            home_score,
                            away_score,
                            match.match_name,
                            bet.amount,
                            match.body_favored_side || 'home'
                        );

                        pendingDbOps++;
                        db.run(`UPDATE bets SET status = ?, result_factor = ?, gross_profit = ?, commission = ?, net_profit = ?, payout = ?, settled_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [outcome.status, outcome.winFactor, outcome.grossProfit, outcome.commission, outcome.netProfit, outcome.returnAmount, bet.id], (err) => {
                            if (err) hasError = true;
                            pendingDbOps--;

                            if (!err && outcome.returnAmount > 0) {
                                pendingDbOps += 2;
                                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [outcome.returnAmount, bet.username], (balanceErr) => {
                                    if (balanceErr) hasError = true;
                                    pendingDbOps--;
                                    maybeFinishSettlement();
                                });
                                db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, processed_by, process_by_who, process_by_where, processed_at, created_at) VALUES (?, 'Payout', 'Wallet', ?, 'Completed', 'System', 'System', 'Server', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [bet.username, outcome.returnAmount], (txErr) => {
                                    if (txErr) hasError = true;
                                    pendingDbOps--;
                                    maybeFinishSettlement();
                                });
                            }

                            completedCount++;
                            maybeFinishSettlement();
                        });
                    });
                });
            });
        });
    });
});

// ================= SETTLEMENT CENTER ================= //
function buildSettlementPreview(match, bets, home_score, away_score){
  return (bets||[]).map(b=>{
    // Use the bet-time match snapshot for the body team comparison. Never
    // recalculate an old ticket from a later-edited match name.
    const snapshotMatchName = String(b.match_name || match.match_name || '');
    const o=calculateBetOutcome(
      b.bet_type,
      b.choice,
      b.odds_rate,
      home_score,
      away_score,
      snapshotMatchName,
      b.amount,
      b.body_favored_side || match.body_favored_side || 'home'
    );
    return {
      id:b.id,
      username:b.username,
      ticket_no:b.ticket_no,
      match_id:b.match_id,
      match_name:snapshotMatchName,
      bet_type:b.bet_type,
      choice:b.choice,
      amount:Number(b.amount||0),
      odds_rate:b.odds_rate,
      status:b.status,
      outcome:o
    };
  });
}

function settlementSummary(rows){
  const stake=(rows||[]).reduce((a,b)=>a+Number(b.amount||0),0);
  const payout=(rows||[]).reduce((a,b)=>a+Number(b.outcome?.returnAmount||0),0);
  const grossProfit=(rows||[]).reduce((a,b)=>a+Number(b.outcome?.grossProfit||0),0);
  const commission=(rows||[]).reduce((a,b)=>a+Number(b.outcome?.commission||0),0);
  const netProfit=(rows||[]).reduce((a,b)=>a+Number(b.outcome?.netProfit||0),0);
  const won=(rows||[]).filter(b=>Number(b.outcome?.winFactor||0)>0).length;
  const lost=(rows||[]).filter(b=>Number(b.outcome?.winFactor||0)<0).length;
  const draw=(rows||[]).filter(b=>Number(b.outcome?.winFactor||0)===0).length;
  return {
    bets:(rows||[]).length,
    stake,payout,
    admin_pl:stake-payout,
    gross_profit:grossProfit,
    commission,
    net_profit:netProfit,
    won,lost,draw
  };
}

app.post('/api/admin/settlement/preview', requireAdmin,(req,res)=>{
  const {match_id,home_score,away_score}=req.body;
  const hs=Number(home_score), as=Number(away_score);
  if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return res.status(400).json({success:false,message:'Valid final score is required'});
  db.get(`SELECT * FROM matches WHERE id=? OR custom_match_id=?`,[match_id,match_id],(e,m)=>{
    if(e)return res.status(500).json({success:false,error:e.message});
    if(!m)return res.status(404).json({success:false,message:'Match not found'});
    if(['cancelled','postponed','settled'].includes(String(m.status||'').trim().toLowerCase()))return res.status(409).json({success:false,message:`Settlement is not available for ${m.status}.`});
    db.all(`SELECT * FROM bets WHERE match_db_id=? AND status='Pending'`,[m.id],(be,bets)=>{
      if(be)return res.status(500).json({success:false,error:be.message});
      const rows=buildSettlementPreview(m,bets||[],hs,as);
      const stake=rows.reduce((a,b)=>a+Number(b.amount||0),0);
      const payout=rows.reduce((a,b)=>a+Number(b.outcome?.returnAmount||0),0);
      const won=rows.filter(b=>Number(b.outcome?.winFactor||0)>0).length;
      const lost=rows.filter(b=>Number(b.outcome?.winFactor||0)<0).length;
      const draw=rows.length-won-lost;
      res.json({success:true,match:m,data:rows,summary:{bets:rows.length,stake,payout,admin_pl:stake-payout,won,lost,draw}});
    });
  });
});

app.post('/api/admin/settlement/confirm', requireAdmin, (req,res)=>{
  const {match_id,home_score,away_score}=req.body;
  const hs=Number(home_score), as=Number(away_score);
  if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0){
    return res.status(400).json({success:false,message:'Valid final score is required'});
  }

  db.get(`SELECT * FROM matches WHERE id=? OR custom_match_id=?`,[match_id,match_id],(e,m)=>{
    if(e)return res.status(500).json({success:false,error:e.message});
    if(!m)return res.status(404).json({success:false,message:'Match not found'});
    const currentStatus=String(m.status||'').trim().toLowerCase();
    if(['cancelled','postponed','settled'].includes(currentStatus)){
      return res.status(409).json({success:false,message:`Settlement is not available for ${m.status}.`});
    }

    db.serialize(()=>{
      let finished=false;
      const rollbackAndFail=(status,msg)=>{
        if(finished)return;
        finished=true;
        db.run('ROLLBACK',()=>res.status(status).json({success:false,message:msg}));
      };
      const commit=(summary)=>{
        if(finished)return;
        db.run('COMMIT',ce=>{
          if(ce)return rollbackAndFail(500,ce.message);
          finished=true;
          return res.json({success:true,summary});
        });
      };

      db.run('BEGIN IMMEDIATE', beginErr=>{
        if(beginErr)return res.status(500).json({success:false,error:beginErr.message});
        db.all(`SELECT * FROM bets WHERE match_db_id=? AND status='Pending' ORDER BY id ASC`,[m.id],(be,bets)=>{
          if(be)return rollbackAndFail(500,be.message);
          const rows=buildSettlementPreview(m,bets||[],hs,as);
          const summary={
            bets:rows.length,
            stake:rows.reduce((a,b)=>a+Number(b.amount||0),0),
            payout:rows.reduce((a,b)=>a+Number(b.outcome?.returnAmount||0),0)
          };
          summary.admin_pl=summary.stake-summary.payout;

          let index=0;
          const processNext=()=>{
            if(finished)return;
            if(index>=rows.length){
              db.run(`UPDATE matches SET home_score=?,away_score=?,status='Settled' WHERE id=?`,[hs,as,m.id],(me)=>{
                if(me)return rollbackAndFail(500,me.message);
                commit(summary);
              });
              return;
            }
            const x=rows[index++], o=x.outcome||{};
            db.run(`UPDATE bets SET status=?,result_factor=?,gross_profit=?,commission=?,net_profit=?,payout=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='Pending'`,
              [o.status,o.winFactor,o.grossProfit,o.commission,o.netProfit,o.returnAmount,x.id],function(ue){
                if(ue)return rollbackAndFail(500,ue.message);
                if(this.changes!==1)return rollbackAndFail(409,'One or more bets are no longer pending. Please preview again.');
                const payout=Number(o.returnAmount||0);
                if(payout<=0)return processNext();
                db.run(`UPDATE users SET balance=balance+? WHERE username=?`,[payout,x.username],function(ue2){
                  if(ue2)return rollbackAndFail(500,ue2.message);
                  if(this.changes!==1)return rollbackAndFail(409,`Marker account not found: ${x.username}`);
                  db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,processed_by,process_by_who,process_by_where,processed_at,created_at) VALUES(?, 'Payout','Wallet',?,'Completed','System','System','Server',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[x.username,payout],(te)=>{
                    if(te)return rollbackAndFail(500,te.message);
                    addAdminLedger({entry_type:'Payout',username:x.username,amount:payout,direction:'OUT',reference_type:'Bet',reference_id:x.id,reason:`Settlement payout for ${m.custom_match_id||m.id}`,processed_by:req.authUser.username},(le)=>{
                      if(le)return rollbackAndFail(500,le.message);
                      processNext();
                    });
                  });
                });
              });
          };
          processNext();
        });
      });
    });
  });
});

// ================= BETTING APIs (WITH SAFEGUARDS & TRANSACTION SAFETY) ================= //
app.get(['/api/bets', '/api/admin/bets'], requireAuth, (req, res) => {
    const username = req.authUser.role === 'user' ? req.authUser.username : req.query.username;
    let query = `SELECT * FROM bets`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.get('/api/user/bets', requireUser, (req, res) => {
    const username = req.authUser.username;
    let query = `SELECT * FROM bets`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.delete('/api/bets/:id', requireAdmin, (req, res) => {
    db.run(`DELETE FROM bets WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Bet record deleted successfully' });
    });
});

// Resolve a bet to the exact cap lane: actual Home/Away team or GP Over/Under.
function getBetLimitLane(bet, match) {
    const isBody = /body|ဘော်ဒီ/i.test(String(bet.bet_type || ''));
    if (isBody) {
        const teams = String(match?.match_name || '').split(/\s+vs\s+/i).map(x => x.trim());
        if (String(bet.choice) === String(teams[0] || '')) return { field:'body_home_limit', label:'Body Home', side:'home' };
        if (String(bet.choice) === String(teams[1] || '')) return { field:'body_away_limit', label:'Body Away', side:'away' };
        return null;
    }
    if (/^over$/i.test(String(bet.choice || ''))) return { field:'gp_over_limit', label:'GP Over', side:'over' };
    if (/^under$/i.test(String(bet.choice || ''))) return { field:'gp_under_limit', label:'GP Under', side:'under' };
    return null;
}

// Called after BEGIN IMMEDIATE so concurrent place-bet attempts are checked against current usage.
function checkBettorMatchLimits(userId, username, incomingBets, matchMap, callback) {
    const dbMatchIds = [...new Set(incomingBets.map(b => {
        const m = matchMap.get(String(b.match_id)); return m ? Number(m.id) : 0;
    }).filter(n => n > 0))];
    if (!dbMatchIds.length) return callback(null, null);
    const marks = dbMatchIds.map(() => '?').join(',');
    db.all(`SELECT * FROM bet_limit_rules WHERE (user_id IN (0,?) AND match_db_id IN (0,${marks}))`, [userId, ...dbMatchIds], (limitErr, limitRows) => {
        if (limitErr) return callback(limitErr);
        db.all(`SELECT match_db_id, bet_type, choice, amount FROM bets WHERE username=? AND match_db_id IN (${marks})`, [username, ...dbMatchIds], (usedErr, existingBets) => {
            if (usedErr) return callback(usedErr);
            const limitsByMatch = new Map();
            for (const matchId of dbMatchIds) {
                const applicable = (limitRows || []).filter(r => Number(r.match_db_id) === matchId || Number(r.match_db_id) === 0)
                    .sort((a,b) => ((Number(b.user_id)===userId?2:0)+(Number(b.match_db_id)===matchId?1:0))-((Number(a.user_id)===userId?2:0)+(Number(a.match_db_id)===matchId?1:0)));
                // Specific marker+match > marker-wide > all-markers+match > global.
                const exact = (limitRows || []).filter(r => Number(r.user_id)===userId && Number(r.match_db_id)===matchId)[0];
                const markerWide = (limitRows || []).filter(r => Number(r.user_id)===userId && Number(r.match_db_id)===0)[0];
                const allMarkerMatch = (limitRows || []).filter(r => Number(r.user_id)===0 && Number(r.match_db_id)===matchId)[0];
                const global = (limitRows || []).filter(r => Number(r.user_id)===0 && Number(r.match_db_id)===0)[0];
                limitsByMatch.set(String(matchId), exact || markerWide || allMarkerMatch || global || null);
            }
            const matchByDbId = new Map();
            for (const b of incomingBets) {
                const m = matchMap.get(String(b.match_id));
                if (m) matchByDbId.set(String(m.id), m);
            }
            const usedByLane = new Map();
            for (const oldBet of (existingBets || [])) {
                const match = matchByDbId.get(String(oldBet.match_db_id));
                if (!match) continue;
                const lane = getBetLimitLane(oldBet, match);
                if (!lane) continue;
                const key = `${match.id}|${lane.field}`;
                usedByLane.set(key, (usedByLane.get(key) || 0) + Math.max(0, Number(oldBet.amount) || 0));
            }
            // Include earlier legs in this request so duplicate selections cannot bypass a cap.
            for (const bet of incomingBets) {
                const match = matchMap.get(String(bet.match_id));
                if (!match) continue;
                const lane = getBetLimitLane(bet, match);
                if (!lane) continue;
                const key = `${match.id}|${lane.field}`;
                const limitRow = limitsByMatch.get(String(match.id));
                const limit = Math.max(0, Number(limitRow?.[lane.field]) || 0); // 0 = unlimited
                const used = Math.max(0, Number(usedByLane.get(key)) || 0);
                if (limit > 0 && used + bet.amount > limit) {
                    return callback(null, {
                        limit_type:lane.field, limit_label:lane.label, limit, used,
                        remaining:Math.max(0, limit-used), requested:Number(bet.amount)||0,
                        match_id:String(match.custom_match_id || match.id), match_db_id:Number(match.id),
                        match_name:String(match.match_name || ''), bet_type:String(bet.bet_type || ''), choice:String(bet.choice || '')
                    });
                }
                usedByLane.set(key, used + bet.amount);
            }
            callback(null, null);
        });
    });
}

app.post('/api/user/place-bet', requireUser, (req, res) => {
    const username = req.authUser.username;
    const userId = Number(req.authUser.id);
    const { bets, is_parlay, total_amount } = req.body;

    let incomingBets = Array.isArray(bets) ? bets : null;
    if (!incomingBets && req.body.match_id) {
        incomingBets = [{
            match_id:req.body.match_id, match_name:req.body.match_name, bet_type:req.body.bet_type,
            choice:req.body.choice, odds_rate:req.body.odds_rate, amount:req.body.amount
        }];
    }
    if (!username || !incomingBets || incomingBets.length === 0) {
        return res.status(400).json({ success:false, message:'No bets were provided.' });
    }

    const cleanBets = incomingBets.map(b => ({
        match_id:String(b.match_id || '').trim(),
        bet_type:String(b.bet_type || '').trim(),
        choice:String(b.choice || '').trim(),
        odds_rate:String(b.odds_rate ?? '').trim(),
        amount:Number(b.amount)
    }));
    if (cleanBets.some(b => !b.match_id || !b.bet_type || !b.choice || !Number.isFinite(b.amount) || b.amount <= 0)) {
        return res.status(400).json({ success:false, message:'Bet details are invalid.' });
    }

    const totalDeduction = is_parlay ? Number(total_amount) : cleanBets.reduce((sum,b) => sum+b.amount, 0);
    if (!Number.isFinite(totalDeduction) || totalDeduction <= 0) {
        return res.status(400).json({ success:false, message:'Total stake is invalid.' });
    }

    const ids = [...new Set(cleanBets.map(b => b.match_id))];
    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT m.*,
            (SELECT CAST(value AS INTEGER) FROM site_settings WHERE key='global_lock_minutes') AS global_lock_minutes,
            (SELECT value FROM site_settings WHERE key='late_bet_cap_enabled') AS late_bet_cap_enabled,
            (SELECT CAST(value AS INTEGER) FROM site_settings WHERE key='late_bet_cap_window_minutes') AS late_bet_cap_window_minutes,
            (SELECT CAST(value AS REAL) FROM site_settings WHERE key='late_bet_cap_amount') AS late_bet_cap_amount
            FROM matches m WHERE m.id IN (${placeholders}) OR m.custom_match_id IN (${placeholders})`, [...ids,...ids], (matchErr, rows) => {
        if (matchErr) return res.status(500).json({ success:false, error:matchErr.message });
        const matchMap = new Map();
        (rows || []).forEach(m => { matchMap.set(String(m.id),m); matchMap.set(String(m.custom_match_id),m); });

        for (const b of cleanBets) {
            const match = matchMap.get(String(b.match_id));
            if (!match) return res.status(400).json({ success:false, message:`Match ${b.match_id} was not found.` });
            if (String(match.status).toLowerCase() !== 'open') return res.status(400).json({ success:false, message:`${match.match_name} is closed for betting.` });
            const kickoffMs = parseMatchTime(match.match_time);
            if (!kickoffMs) return res.status(400).json({ success:false, message:'Match kickoff time is invalid.' });
            const lockMinutes = resolveMatchLockMinutes(match);
            const nowMs = Date.now();
            const hardLockAt = kickoffMs - lockMinutes*60*1000;
            if (nowMs >= hardLockAt) return res.status(400).json({ success:false, code:'BETTING_CLOSED_EARLY', message:`Betting is closed ${lockMinutes} minutes before kickoff.` });

            const lateEnabled = String(match.late_bet_cap_enabled || '0') === '1';
            const lateCap = Number(match.late_bet_cap_amount);
            const lateWindowEffective = lateEnabled ? 5 : 0;
            const lateCapAt = hardLockAt - lateWindowEffective*60*1000;
            if (lateEnabled && lateWindowEffective > 0 && Number.isFinite(lateCap) && lateCap > 0 && nowMs >= lateCapAt && nowMs < hardLockAt) {
                const requestedStake = is_parlay ? totalDeduction : b.amount;
                if (Number(requestedStake) > lateCap) return res.status(400).json({
                    success:false, code:'LATE_BET_CAP_EXCEEDED', late_bet_cap:lateCap,
                    late_bet_window_minutes:lateWindowEffective,
                    message:`During the final ${lateWindowEffective} minutes before betting closes, each stake must not exceed ${lateCap.toLocaleString()}.`
                });
            }

            const isBody = /body|ဘော်ဒီ/i.test(b.bet_type);
            const realOdds = isBody ? match.body_odds : match.goal_odds;
            if (!realOdds) return res.status(400).json({ success:false, message:'Odds are not available for this match.' });
            // Do not silently accept a changed price after the bettor opened the slip.
            if (b.odds_rate && String(b.odds_rate).trim() !== String(realOdds).trim()) {
                return res.status(409).json({ success:false, code:'ODDS_CHANGED', message:'Odds changed. Please reopen the bet slip and confirm the current odds.' });
            }
            const teams = String(match.match_name || '').split(/\s+vs\s+/i).map(x => x.trim());
            if (isBody) {
                if (b.choice !== teams[0] && b.choice !== teams[1]) return res.status(400).json({ success:false, message:'Invalid team selection.' });
            } else if (!/^(over|under)$/i.test(b.choice)) {
                return res.status(400).json({ success:false, message:'Invalid goal-total selection.' });
            }
        }

        db.get(`SELECT balance, status FROM users WHERE id=? AND username=?`, [userId,username], (userErr, user) => {
            if (userErr) return res.status(500).json({ success:false, error:userErr.message });
            if (!user) return res.status(400).json({ success:false, message:'Bettor account not found. Please login again.' });
            if (String(user.status || 'Active') !== 'Active') return res.status(403).json({ success:false, message:`Account status is ${user.status || 'Inactive'} — betting is disabled.` });
            if (Number(user.balance) < totalDeduction) return res.status(400).json({ success:false, message:'Insufficient balance.' });

            db.serialize(() => {
                db.run('BEGIN IMMEDIATE', (beginErr) => {
                    if (beginErr) return res.status(500).json({ success:false, message:'Could not start bet transaction.', error:beginErr.message });
                    checkBettorMatchLimits(userId, username, cleanBets, matchMap, (limitErr, blocked) => {
                        if (limitErr) {
                            return db.run('ROLLBACK', () => res.status(500).json({ success:false, message:'Could not check bet limits.', error:limitErr.message }));
                        }
                        if (blocked) {
                            return db.run('ROLLBACK', () => res.status(409).json({
                                success:false, code:'BET_LIMIT_REACHED',
                                message:`${blocked.limit_label} limit reached for this match. Please contact Admin to request a higher limit.`,
                                limit:blocked.limit, used:blocked.used, remaining:blocked.remaining,
                                requested:blocked.requested, limit_type:blocked.limit_type, limit_label:blocked.limit_label,
                                match_id:blocked.match_id, match_db_id:blocked.match_db_id, match_name:blocked.match_name,
                                bet_type:blocked.bet_type, choice:blocked.choice
                            }));
                        }
                        db.run(`UPDATE users SET balance=balance-? WHERE id=? AND balance>=?`, [totalDeduction,userId,totalDeduction], function(updateErr) {
                            if (updateErr || this.changes !== 1) {
                                return db.run('ROLLBACK', () => res.status(400).json({ success:false, message:'Insufficient balance or account balance changed. Please try again.' }));
                            }
                            const ticketNo = 'TK-' + Date.now() + '-' + Math.floor(Math.random()*1000);
                            const parlayGroupId = is_parlay ? ticketNo : null;
                            let completed = 0;
                            let hasError = false;
                            cleanBets.forEach((b) => {
                                const match = matchMap.get(String(b.match_id));
                                const isBody = /body|ဘော်ဒီ/i.test(b.bet_type);
                                const realOdds = isBody ? match.body_odds : match.goal_odds;
                                const stakeForRow = is_parlay ? (completed === 0 ? totalDeduction : 0) : b.amount;
                                db.run(`INSERT INTO bets (username,match_id,match_db_id,ticket_no,match_name,bet_type,choice,amount,odds_rate,body_favored_side,status,parlay_group_id)
                                        VALUES (?,?,?,?,?,?,?,?,?,?,'Pending',?)`,
                                    [username,match.custom_match_id||match.id,match.id,ticketNo,match.match_name,b.bet_type,b.choice,stakeForRow,realOdds,
                                     isBody ? (match.body_favored_side||'home') : null,parlayGroupId], (insertErr) => {
                                    if (insertErr) hasError = true;
                                    completed++;
                                    if (completed !== cleanBets.length) return;
                                    if (hasError) return db.run('ROLLBACK', () => res.status(500).json({ success:false, message:'Failed to save bet ticket.' }));
                                    db.run(`INSERT INTO transactions (username,type,payment_method,amount,status,processed_by,process_by_who,process_by_where,processed_at,created_at)
                                            VALUES (?,?,'Wallet',?,'Completed','System','System','Server',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
                                        [username,is_parlay?'Parlay Bet':(cleanBets.length>1?'Combined Bet':'Bet Placed'),totalDeduction], (txErr) => {
                                        if (txErr) return db.run('ROLLBACK', () => res.status(500).json({ success:false, message:'Could not save the transaction record.' }));
                                        addAdminLedger({entry_type:'Bet Stake',username,amount:totalDeduction,direction:'IN',reference_type:'Ticket',reference_id:ticketNo,
                                            reason:is_parlay?'Parlay stake':(cleanBets.length>1?'Combined stake':'Bet stake'),processed_by:'System'}, (ledgerErr) => {
                                            if (ledgerErr) return db.run('ROLLBACK', () => res.status(500).json({ success:false, message:'Could not save the ledger record.' }));
                                            db.run('COMMIT', (commitErr) => {
                                                if (commitErr) return res.status(500).json({ success:false, message:'Could not complete the bet transaction.', error:commitErr.message });
                                                res.json({ success:true, message:'Bet successfully placed.', ticket_no:ticketNo, total_deduction:totalDeduction, bet_count:cleanBets.length });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Bettor explicitly asks Admin to review a reached side limit. Merely hitting the limit sends no alert.
app.post('/api/user/bet-limit-request', requireUser, (req, res) => {
    const matchId = String(req.body.match_id || '').trim();
    const limitType = String(req.body.limit_type || '').trim();
    const allowed = {
        body_home_limit:'Body Home', body_away_limit:'Body Away',
        gp_over_limit:'GP Over', gp_under_limit:'GP Under'
    };
    if (!matchId || !allowed[limitType]) return res.status(400).json({ success:false, message:'Invalid limit request.' });
    db.get(`SELECT id,custom_match_id,match_name FROM matches WHERE CAST(id AS TEXT)=? OR CAST(custom_match_id AS TEXT)=?`, [matchId,matchId], (matchErr, match) => {
        if (matchErr) return res.status(500).json({ success:false, error:matchErr.message });
        if (!match) return res.status(404).json({ success:false, message:'Match not found.' });
        const username = req.authUser.username;
        const message = `${username} requests a higher ${allowed[limitType]} limit. Match ${match.custom_match_id || match.id}: ${match.match_name}. Current cap: ${Number(req.body.limit)||0}; used: ${Number(req.body.used)||0}; additional stake attempted: ${Number(req.body.requested)||0}.`;
        db.run(`INSERT INTO admin_notifications (kind,title,message,reference_type,reference_id,is_read,created_at)
                VALUES ('bet_limit_request','Bet Limit Increase Request',?,'BetLimit',?,0,CURRENT_TIMESTAMP)`,
            [message, `${username}:${match.id}:${limitType}`], function(err) {
                if (err) return res.status(500).json({ success:false, message:'Could not notify Admin.', error:err.message });
                res.json({ success:true, message:'Request sent to Admin. Please wait for approval.' });
            });
    });
});

// ================= DEPOSIT, WITHDRAW & ADMIN APPROVAL APIs ================= //
app.post('/api/user/deposit', requireUser, (req, res) => {
    const username = req.authUser.username;
    const amt = Number(req.body.amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'Enter a valid amount.' });
    const ref = `DEP-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    db.run(`INSERT INTO transactions (username, type, payment_method, amount, transaction_id, status, created_at) VALUES (?, 'Deposit', 'Wallet', ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
        [username, amt, ref], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const txId=this.lastID;
        db.run(`INSERT INTO admin_notifications(kind,title,message,reference_type,reference_id) VALUES('transaction','New Deposit Request',?,?,?)`,
            [`${username} requested a deposit of ${amt.toLocaleString()}`, 'Transaction', String(txId)], () => {
                res.json({ success: true, message: 'Deposit request submitted successfully', transaction_id: txId });
            });
    });
});

app.post('/api/user/withdraw', requireUser, (req, res) => {
    const username = req.authUser.username;
    const amt = Number(req.body.amount);
    if (req.body.agent_confirmation !== true) {
        return res.status(400).json({ success: false, message: 'Please confirm the agent-contact message before submitting a withdrawal request.' });
    }
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'Enter a valid amount.' });
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: 'User not found' });
        if (Number(user.balance||0) < amt) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        const ref = `WDL-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);
            db.run(`UPDATE users SET balance = balance - ? WHERE username = ? AND balance >= ?`, [amt, username, amt], function(ue) {
                if (ue || this.changes !== 1) { db.run(`ROLLBACK`); return res.status(400).json({ success:false, message:ue?.message||'Unable to reserve withdrawal amount' }); }
                db.run(`INSERT INTO transactions (username, type, payment_method, amount, transaction_id, status, created_at) VALUES (?, 'Withdraw', 'Wallet', ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
                    [username, amt, ref], function(te) {
                    if (te) { db.run(`ROLLBACK`); return res.status(500).json({ success:false, error:te.message }); }
                    const txId=this.lastID;
                    db.run(`INSERT INTO admin_notifications(kind,title,message,reference_type,reference_id) VALUES('transaction','New Withdrawal Request',?,?,?)`,
                        [`${username} requested a withdrawal of ${amt.toLocaleString()}`, 'Transaction', String(txId)], function(ne) {
                        if (ne) { db.run(`ROLLBACK`); return res.status(500).json({success:false,error:ne.message}); }
                        db.run(`COMMIT`, ce => {
                            if (ce) return res.status(500).json({success:false,error:ce.message});
                            res.json({success:true,message:'Withdraw request submitted successfully',transaction_id:txId});
                        });
                    });
                });
            });
        });
    });
});


// Transaction audit: determine the device that processed an action.
// This is based on the request User-Agent and is intended for normal audit visibility,
// not as a security proof (User-Agent strings can be spoofed).
function detectProcessDevice(req) {
    const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
    if (!ua) return 'Unknown';
    if (/ipad|tablet|playbook|silk|kindle/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) {
        return 'Tablet';
    }
    if (/iphone|ipod|android.*mobile|windows phone|mobile/.test(ua)) {
        return 'Phone';
    }
    return 'Desktop';
}

function transactionProcessMeta(req, isSystem=false) {
    if (isSystem) {
        return { who: 'System', where: 'Server', processedBy: 'System' };
    }
    const who = (req && req.authUser && req.authUser.username) ? 'Admin' : 'System';
    return { who, where: detectProcessDevice(req), processedBy: req?.authUser?.username || who };
}

function auditDevice(req) {
    const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
    if (!ua) return 'Unknown';
    if (/ipad|tablet|playbook|silk|kindle/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) return 'Tablet';
    if (/iphone|ipod|android.*mobile|windows phone|mobile/.test(ua)) return 'Phone';
    return 'Desktop';
}

function auditIp(req) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || String(req?.socket?.remoteAddress || 'Unknown');
}

function writeSecurityAudit(entry, callback=()=>{}) {
    const e=entry||{};
    db.run(`INSERT INTO security_audit(created_at,username,role,action,module,target,details,severity,device,ip_address)
            VALUES(CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?)`,[
        e.username||'', e.role||'', e.action||'UNKNOWN', e.module||'', e.target||'', e.details||'', e.severity||'INFO', e.device||'', e.ip_address||''
    ], callback);
}

function addAdminLedger(entry, callback=()=>{}) {
    const e = entry || {};
    const amount = Math.abs(Number(e.amount || 0));
    const direction = e.direction === 'OUT' ? 'OUT' : 'IN';
    if (!Number.isFinite(amount) || amount <= 0) return callback(new Error('Ledger amount must be greater than zero'));
    db.run(`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by,balance_after)
            VALUES(?,?,?,?,?,?,?,?,
              COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END) FROM admin_ledger),0)
              + CASE WHEN ? = 'IN' THEN ? ELSE -? END
            )`,
        [String(e.entry_type||'Ledger'), e.username||null, amount, direction, e.reference_type||null, e.reference_id==null?null:String(e.reference_id), e.reason||null, e.processed_by||null, direction, amount, amount], callback);
}

// Admin notification center
app.get('/api/admin/notifications', requireAdmin, (req,res)=>{
    db.all(`SELECT id,kind,title,message,reference_type,reference_id,is_read,created_at FROM admin_notifications ORDER BY id DESC LIMIT 50`,[],(e,rows)=>{
        if(e)return res.status(500).json({success:false,error:e.message});
        const unread=(rows||[]).filter(x=>Number(x.is_read)===0).length;
        res.json({success:true,unread,data:rows||[]});
    });
});
app.post('/api/admin/notifications/:id/read', requireAdmin, (req,res)=>{
    db.run(`UPDATE admin_notifications SET is_read=1 WHERE id=?`,[req.params.id],function(e){
        if(e)return res.status(500).json({success:false,error:e.message});
        res.json({success:true});
    });
});
app.post('/api/admin/notifications/read-all', requireAdmin, (req,res)=>{
    db.run(`UPDATE admin_notifications SET is_read=1 WHERE is_read=0`,[],function(e){
        if(e)return res.status(500).json({success:false,error:e.message});
        res.json({success:true});
    });
});

// Admin: list all deposit/withdraw/payout transactions for the Transactions tab.
// Keep the query server-side so the admin table does not depend on the bettor's
// username or browser state.
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
    db.all(`SELECT id, username, type, payment_method, account_name, phone, amount, transaction_id, status, processed_by, process_by_who, process_by_where, processed_at, created_at
            FROM transactions
            ORDER BY id DESC`, [], (err, rows) => {
        if (err) {
            console.error('Admin transactions load failed:', err.message);
            return res.status(500).json({ success: false, error: err.message, data: [] });
        }
        res.json({ success: true, data: rows || [] });
    });
});

app.get('/api/user/transactions', requireUser, (req, res) => {
    const username = req.authUser.username;
    let query = `SELECT * FROM transactions`;
    let params = [];
    if (username) {
        query += ` WHERE username = ?`;
        params.push(username);
    }
    query += ` ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

// Admin Transaction Action API (Approve / Reject) with Transaction Safety
app.post('/api/admin/transactions/action', requireAdmin, (req, res) => {
    const { transaction_id, status } = req.body;
    const normalizedStatus = status === 'Approved' ? 'Approved' : (status === 'Rejected' ? 'Rejected' : null);
    if (!transaction_id || !normalizedStatus) {
        return res.status(400).json({ success: false, message: 'Invalid transaction action' });
    }

    db.get(`SELECT * FROM transactions WHERE id = ?`, [transaction_id], (getErr, tx) => {
        if (getErr || !tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
        if (tx.status !== 'Pending') {
            return res.status(409).json({ success: false, message: `Transaction is already ${tx.status}` });
        }

        const amt = Number(tx.amount);
        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            const procMeta = transactionProcessMeta(req, false);
            db.run(`UPDATE transactions SET status = ?, processed_by = ?, process_by_who = ?, process_by_where = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'Pending'`, [normalizedStatus, procMeta.processedBy, procMeta.who, procMeta.where, transaction_id], function(err) {
            if (err) {
                db.run(`ROLLBACK`);
                return res.status(500).json({ success: false, error: err.message });
            }
            if (this.changes !== 1) {
                db.run('ROLLBACK');
                return res.status(409).json({ success: false, message: 'Transaction is no longer pending.' });
            }

            if (normalizedStatus === 'Approved' && tx.type === 'Deposit') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, tx.username]);
            }

            if (normalizedStatus === 'Rejected' && tx.type === 'Withdraw') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, tx.username]);
            }

            const cashFlow = normalizedStatus === 'Approved' ? (tx.type === 'Deposit' ? 'IN' : 'OUT') : null;
            const finishTransaction = () => db.run(`COMMIT`, ce => {
                if (ce) return res.status(500).json({success:false,error:ce.message});
                res.json({ success: true, message: `ငွေစာရင်း တောင်းဆိုမှုမှာ ${normalizedStatus} ဖြစ်သွားပါပြီ။` });
            });
            if (cashFlow) {
                addAdminLedger({entry_type: tx.type === 'Deposit' ? 'Deposit Approved' : 'Withdrawal Approved',username:tx.username,amount:amt,direction:cashFlow,reference_type:'Transaction',reference_id:transaction_id,reason:`${normalizedStatus} via ${tx.payment_method||'Wallet'} ${tx.account_name||''} ${tx.phone||''}`.trim(),processed_by:req.authUser.username}, (le)=>{
                    if(le){db.run('ROLLBACK');return res.status(500).json({success:false,error:le.message});}
                    finishTransaction();
                });
            } else {
                finishTransaction();
            }
            });
        });
    });
});

// Admin Dashboard / Bettor Management / Ledger / Risk layout
// ================= ADMIN REPORT CENTER =================
function reportYgnUtcBounds(dateStr, endOfDay=false){
    const m=String(dateStr||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m)return null;
    const [_,y,mo,d]=m.map(Number);
    const ms=Date.UTC(y,mo-1,d,endOfDay?23:0,endOfDay?59:0,endOfDay?59:0)-MYANMAR_OFFSET_MS;
    const dt=new Date(ms);
    const pad=n=>String(n).padStart(2,'0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}
function reportYgnToday(){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:YGN_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).split('-');
    return parts.join('-');
}
app.get('/api/admin/reports', requireAdmin, (req,res)=>{
    const today=reportYgnToday();
    const from=String(req.query.from||today).trim()||today;
    const to=String(req.query.to||from).trim()||from;
    const marker=String(req.query.marker||'').trim();
    const match=String(req.query.match||'').trim();
    const type=String(req.query.type||'summary').trim().toLowerCase();
    const start=reportYgnUtcBounds(from,false), end=reportYgnUtcBounds(to,true);
    if(!start||!end)return res.status(400).json({success:false,message:'Valid From/To dates are required.'});
    const betWhere=[`b.created_at BETWEEN ? AND ?`], betParams=[start,end];
    if(marker){betWhere.push(`b.username=?`);betParams.push(marker);}
    if(match){betWhere.push(`(CAST(b.match_db_id AS TEXT)=? OR CAST(b.match_id AS TEXT)=? OR CAST(m.id AS TEXT)=?)`);betParams.push(match,match,match);}
    const bw=betWhere.join(' AND ');
    const txWhere=[`t.created_at BETWEEN ? AND ?`], txParams=[start,end];
    if(marker){txWhere.push(`t.username=?`);txParams.push(marker);}
    const tw=txWhere.join(' AND ');
    db.get(`SELECT COUNT(*) total_bets,COALESCE(SUM(b.amount),0) total_stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.amount ELSE 0 END),0) settled_stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.payout ELSE 0 END),0) total_payout FROM bets b LEFT JOIN matches m ON m.id=b.match_db_id WHERE ${bw}`,...betParams,(e,summary)=>{
        if(e)return res.status(500).json({success:false,error:e.message});
        const s={total_bets:Number(summary?.total_bets||0),total_stake:Number(summary?.total_stake||0),settled_stake:Number(summary?.settled_stake||0),total_payout:Number(summary?.total_payout||0)};
        s.admin_net_pl=s.settled_stake-s.total_payout;
        db.get(`SELECT COUNT(*) tx_count,COALESCE(SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END),0) tx_approved,COALESCE(SUM(CASE WHEN status='Rejected' THEN 1 ELSE 0 END),0) tx_rejected,COALESCE(SUM(CASE WHEN status='Pending' THEN 1 ELSE 0 END),0) tx_pending,COALESCE(SUM(CASE WHEN status='Approved' THEN amount ELSE 0 END),0) tx_amount FROM transactions t WHERE ${tw}`,...txParams,(te,txs)=>{
            if(te)return res.status(500).json({success:false,error:te.message});
            Object.assign(s,{tx_count:Number(txs?.tx_count||0),tx_approved:Number(txs?.tx_approved||0),tx_rejected:Number(txs?.tx_rejected||0),tx_pending:Number(txs?.tx_pending||0),tx_amount:Number(txs?.tx_amount||0)});
            const finish=(tables)=>res.json({success:true,from,to,timezone:YGN_TIMEZONE,type,summary:s,tables});
            if(type==='marker'){
                const sql=`SELECT COALESCE(b.username,'') marker,COUNT(*) bets,COALESCE(SUM(b.amount),0) stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.amount ELSE 0 END),0) settled_stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.payout ELSE 0 END),0) payout,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.amount-b.payout ELSE 0 END),0) admin_pl FROM bets b LEFT JOIN matches m ON m.id=b.match_db_id WHERE ${bw} GROUP BY b.username ORDER BY stake DESC`;
                return db.all(sql,betParams,(x,rows)=>finish({marker:{headers:['Marker','Bets','Stake','Settled Stake','Payout','Admin Net P/L'],rows:(rows||[]).map(r=>[r.marker,Number(r.bets||0).toLocaleString(),Number(r.stake||0).toLocaleString(),Number(r.settled_stake||0).toLocaleString(),Number(r.payout||0).toLocaleString(),Number(r.admin_pl||0).toLocaleString()])}}));
            }
            if(type==='match'){
                const sql=`SELECT COALESCE(m.custom_match_id,b.match_id) match_id,COALESCE(m.match_name,b.match_name,'') match_name,COUNT(*) bets,COALESCE(SUM(b.amount),0) stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.amount ELSE 0 END),0) settled_stake,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.payout ELSE 0 END),0) payout,COALESCE(SUM(CASE WHEN b.status<>'Pending' THEN b.amount-b.payout ELSE 0 END),0) admin_pl FROM bets b LEFT JOIN matches m ON m.id=b.match_db_id WHERE ${bw} GROUP BY b.match_db_id,COALESCE(m.custom_match_id,b.match_id),COALESCE(m.match_name,b.match_name) ORDER BY stake DESC`;
                return db.all(sql,betParams,(x,rows)=>finish({match:{headers:['Match ID','Match','Bets','Stake','Settled Stake','Payout','Admin Net P/L'],rows:(rows||[]).map(r=>[r.match_id,r.match_name,Number(r.bets||0).toLocaleString(),Number(r.stake||0).toLocaleString(),Number(r.settled_stake||0).toLocaleString(),Number(r.payout||0).toLocaleString(),Number(r.admin_pl||0).toLocaleString()])}}));
            }
            if(type==='transactions'){
                const sql=`SELECT t.username marker,t.type,t.status,COUNT(*) count,COALESCE(SUM(t.amount),0) amount FROM transactions t WHERE ${tw} GROUP BY t.username,t.type,t.status ORDER BY amount DESC`;
                return db.all(sql,txParams,(x,rows)=>finish({transactions:{headers:['Marker','Type','Status','Count','Amount'],rows:(rows||[]).map(r=>[r.marker,r.type,r.status,Number(r.count||0).toLocaleString(),Number(r.amount||0).toLocaleString()])}}));
            }
            return finish({summary:{headers:['Metric','Value'],rows:[['Total Bets',s.total_bets.toLocaleString()],['Total Stake',s.total_stake.toLocaleString()],['Settled Stake',s.settled_stake.toLocaleString()],['Total Payout',s.total_payout.toLocaleString()],['Admin Net P/L',s.admin_net_pl.toLocaleString()],['Pending Stake',(s.total_stake-s.settled_stake).toLocaleString()]]}});
        });
    });
});

app.get('/api/admin/dashboard',requireAdmin,(req,res)=>{
 const now=new Date(); const y=now.getFullYear(),mo=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
 const start=`${y}-${mo}-${d} 00:00:00`, end=`${y}-${mo}-${d} 23:59:59`;
 db.get(`SELECT COALESCE(SUM(amount),0) stake,COALESCE(SUM(payout),0) payout FROM bets WHERE created_at BETWEEN ? AND ?`,[start,end],(e,r)=>{
  db.get(`SELECT COUNT(*) c FROM matches WHERE status='Open'`,[],(e2,m)=>res.json({success:!e&&!e2,date:`${y}-${mo}-${d}`,timezone:YGN_TIMEZONE,total_stake:Number(r?.stake||0),total_payout:Number(r?.payout||0),net_pl:Number(r?.stake||0)-Number(r?.payout||0),open_matches:Number(m?.c||0)}));
 });
});
app.post('/api/admin/users/:id/balance-adjust',requireAdmin,(req,res)=>{
    const amt=Number(req.body.amount), reason=String(req.body.reason||'').trim();
    if(!Number.isFinite(amt)||amt===0||!reason)return res.status(400).json({success:false,message:'Amount and reason are required'});
    db.get(`SELECT id, username, balance FROM users WHERE id=? AND role='user'`,[req.params.id],(e,u)=>{
        if(e)return res.status(500).json({success:false,error:e.message});
        if(!u)return res.status(404).json({success:false,message:'User not found'});
        const next=Number(u.balance||0)+amt;
        if(next<0)return res.status(400).json({success:false,message:'Marker balance cannot be negative.'});
        db.serialize(()=>{
            db.run('BEGIN IMMEDIATE');
            db.run(`UPDATE users SET balance=balance+? WHERE id=?`,[amt,u.id],function(ue){
                if(ue||this.changes!==1){db.run('ROLLBACK');return res.status(500).json({success:false,error:ue?.message||'Balance update failed'});}
                db.run(`INSERT INTO balance_adjustments(username,amount,reason,processed_by) VALUES(?,?,?,?)`,[u.username,amt,reason,req.authUser.username],function(be){
                    if(be){db.run('ROLLBACK');return res.status(500).json({success:false,error:be.message});}
                    const procMeta=transactionProcessMeta(req,false);
                    db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,processed_by,process_by_who,process_by_where,processed_at,created_at) VALUES(?, 'Adjustment','Admin',?,'Completed',?,?,?,?,CURRENT_TIMESTAMP)`,[u.username,Math.abs(amt),procMeta.processedBy,procMeta.who,procMeta.where,new Date().toISOString()],function(te){
                        if(te){db.run('ROLLBACK');return res.status(500).json({success:false,error:te.message});}
                        const direction=amt>0?'OUT':'IN';
                        addAdminLedger({entry_type:'Balance Adjustment',username:u.username,amount:Math.abs(amt),direction,reference_type:'User',reference_id:String(u.id),reason,processed_by:req.authUser.username},(le)=>{
                            if(le){db.run('ROLLBACK');return res.status(500).json({success:false,error:le.message});}
                            db.run('COMMIT',ce=>res.json({success:!ce,message:ce?'Adjustment failed':'Balance adjusted',balance:next}));
                        });
                    });
                });
            });
        });
    });
});
app.get('/api/admin/users/:id/bets',requireAdmin,(req,res)=>db.get(`SELECT username FROM users WHERE id=?`,[req.params.id],(e,u)=>{if(e||!u)return res.status(404).json({success:false});db.all(`SELECT * FROM bets WHERE username=? ORDER BY id DESC`,[u.username],(e2,r)=>res.json({success:!e2,data:r||[]}));}));
app.get('/api/admin/users/:id/transactions',requireAdmin,(req,res)=>db.get(`SELECT username FROM users WHERE id=?`,[req.params.id],(e,u)=>{if(e||!u)return res.status(404).json({success:false});db.all(`SELECT * FROM transactions WHERE username=? ORDER BY id DESC`,[u.username],(e2,r)=>res.json({success:!e2,data:r||[]}));}));
app.get('/api/admin/ledger',requireAdmin,(req,res)=>{
    const marker=String(req.query.marker||'').trim();
    const type=String(req.query.type||'').trim();
    const direction=String(req.query.direction||'').trim().toUpperCase();
    const q=String(req.query.q||'').trim().toLowerCase();
    let sql=`SELECT * FROM admin_ledger`;
    const where=[], params=[];
    if(marker){where.push(`username=?`);params.push(marker);}
    if(type){where.push(`entry_type=?`);params.push(type);}
    if(direction==='IN'||direction==='OUT'){where.push(`direction=?`);params.push(direction);}
    if(q){where.push(`LOWER(COALESCE(entry_type,'')||' '||COALESCE(username,'')||' '||COALESCE(reference_type,'')||' '||COALESCE(reference_id,'')||' '||COALESCE(reason,'')) LIKE ?`);params.push(`%${q}%`);}
    if(where.length)sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY id ASC LIMIT 5000`;
    db.all(sql,params,(e,r)=>{
        if(e)return res.status(500).json({success:false,error:e.message,data:[]});
        let running=0,totalIn=0,totalOut=0;
        const chronological=(r||[]).map(x=>{
            const amt=Math.abs(Number(x.amount||0));
            if(x.direction==='IN'){running+=amt;totalIn+=amt;}else{running-=amt;totalOut+=amt;}
            return {...x,running_balance:running,balance_after:running};
        });
        const rows=chronological.slice().reverse();
        res.json({success:true,data:rows,summary:{balance:running,total_in:totalIn,total_out:totalOut,entries:chronological.length}});
    });
});
// Admin Security Audit Log
app.get('/api/admin/audit-log', requireAdmin, (req,res)=>{
    const limit=Math.min(Math.max(Number(req.query.limit)||200,20),1000);
    const q=String(req.query.q||'').trim();
    const action=String(req.query.action||'').trim();
    const user=String(req.query.user||'').trim();
    const device=String(req.query.device||'').trim();
    const severity=String(req.query.severity||'').trim().toUpperCase();
    const from=String(req.query.from||'').trim();
    const to=String(req.query.to||'').trim();
    const where=[]; const params=[];
    if(q){where.push('(username LIKE ? OR action LIKE ? OR module LIKE ? OR target LIKE ? OR details LIKE ?)');const x=`%${q}%`;params.push(x,x,x,x,x);}
    if(action){where.push('action=?');params.push(action);}
    if(user){where.push('username=?');params.push(user);}
    if(device){where.push('device=?');params.push(device);}
    if(['INFO','WARNING','CRITICAL'].includes(severity)){where.push('severity=?');params.push(severity);}
    if(/^\d{4}-\d{2}-\d{2}$/.test(from)){where.push("date(datetime(created_at,'+6 hours','+30 minutes')) >= date(?)");params.push(from);}
    if(/^\d{4}-\d{2}-\d{2}$/.test(to)){where.push("date(datetime(created_at,'+6 hours','+30 minutes')) <= date(?)");params.push(to);}
    const sql=`SELECT id,created_at,username,role,action,module,target,details,severity,device,ip_address FROM security_audit ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    db.all(sql,params,(e,rows)=>{
        if(e)return res.status(500).json({success:false,error:e.message,data:[]});
        db.all(`SELECT DISTINCT action FROM security_audit WHERE action<>'' ORDER BY action ASC`,[],(ae,actions)=>{
            db.all(`SELECT DISTINCT username FROM security_audit WHERE username<>'' ORDER BY username ASC`,[],(ue,users)=>{
                res.json({success:true,data:rows||[],filters:{actions:(actions||[]).map(x=>x.action),users:(users||[]).map(x=>x.username),devices:['Desktop','Tablet','Phone','Server','Unknown'],severities:['INFO','WARNING','CRITICAL']}});
            });
        });
    });
});

app.get('/api/admin/risk-summary', requireAdmin, (req, res) => {
    const sql = `
        SELECT m.id, m.custom_match_id, m.match_name, m.match_time, m.status,
               m.body_favored_side,
               COALESCE(SUM(CASE WHEN (b.status IS NULL OR b.status='Pending') THEN b.amount ELSE 0 END),0) AS total_pool
        FROM matches m
        LEFT JOIN bets b ON b.match_db_id = m.id
        GROUP BY m.id
        ORDER BY CAST(COALESCE(m.custom_match_id,m.id) AS INTEGER), m.match_time`;
    db.all(sql, [], (e, rows) => {
        if (e) return res.status(500).json({success:false,error:e.message});
        res.json({success:true,data:(rows||[]).map(x=>({
            ...x,
            total_pool:Number(x.total_pool||0)
        }))});
    });
});

app.get('/api/admin/risk/match/:id', requireAdmin, (req, res) => {
    const key = req.params.id;
    // The admin selector sends the internal database ID. Resolve by that ID only;
    // matching custom_match_id in the same query can select the wrong match when IDs overlap.
    db.get(`SELECT * FROM matches WHERE id=?`, [key], (matchErr, match) => {
        if (matchErr) return res.status(500).json({success:false,error:matchErr.message});
        if (!match) return res.status(404).json({success:false,message:'Match not found'});

        db.all(`SELECT id, username, match_id, match_name, bet_type, choice, amount, odds_rate, status, created_at
                FROM bets
                WHERE match_db_id=? AND (status IS NULL OR status='Pending')
                ORDER BY username ASC, id ASC`, [match.id], (betErr, bets) => {
            if (betErr) return res.status(500).json({success:false,error:betErr.message});

            const teams = String(match.match_name||'').split(/\s+vs\s+/i).map(x=>x.trim());
            const actualHome = teams[0] || 'Home';
            const actualAway = teams[1] || 'Away';
            const favored = String(match.body_favored_side||'home').toLowerCase()==='away' ? actualAway : actualHome;
            const opposite = favored === actualHome ? actualAway : actualHome;

            const byMarker = new Map();
            for (const b of (bets||[])) {
                const username = String(b.username||'-');
                if (!byMarker.has(username)) byMarker.set(username,{marker:username,match_id:match.custom_match_id||match.id,home_bet:0,away_bet:0,goal_over:0,goal_under:0,total_pool:0,bet_count:0});
                const row=byMarker.get(username);
                const amount=Number(b.amount||0);
                row.total_pool += amount;
                row.bet_count += 1;
                const isBody=/body|ဘော်ဒီ/i.test(String(b.bet_type||''));
                const choice=String(b.choice||'').trim();
                if(isBody){
                    if(choice===favored) row.home_bet += amount;
                    else if(choice===opposite) row.away_bet += amount;
                } else if(/^over/i.test(choice) || /ပေါ်/.test(choice)) {
                    row.goal_over += amount;
                } else if(/^under/i.test(choice) || /အောက်/.test(choice)) {
                    row.goal_under += amount;
                }
            }

            const rows=[...byMarker.values()];
            const matchTotal=rows.reduce((sum,r)=>sum+r.total_pool,0);
            rows.forEach(r=>{
                const share=matchTotal>0?r.total_pool/matchTotal:0;
                r.visual_alert = share >= 0.50 ? 'CRITICAL' : share >= 0.30 ? 'HIGH' : 'NORMAL';
                r.visual_share=share;
            });

            const total={
                home_bet:rows.reduce((n,r)=>n+r.home_bet,0),
                away_bet:rows.reduce((n,r)=>n+r.away_bet,0),
                goal_over:rows.reduce((n,r)=>n+r.goal_over,0),
                goal_under:rows.reduce((n,r)=>n+r.goal_under,0),
                total_pool:matchTotal
            };
            total.home_layout=Math.max(total.home_bet-total.away_bet,0);
            total.away_layout=Math.max(total.away_bet-total.home_bet,0);
            total.over_layout=Math.max(total.goal_over-total.goal_under,0);
            total.under_layout=Math.max(total.goal_under-total.goal_over,0);
            total.total_layout=total.home_layout+total.away_layout+total.over_layout+total.under_layout;

            res.json({success:true,match:{id:match.id,custom_match_id:match.custom_match_id,match_name:match.match_name,match_time:match.match_time,status:match.status,body_favored_side:match.body_favored_side,home_team:actualHome,away_team:actualAway,favored_team:favored},data:rows,total,layout_copy:{
                home:{label:favored,amount:total.home_layout},
                away:{label:opposite,amount:total.away_layout},
                over:{label:`${favored} (O)`,amount:total.over_layout},
                under:{label:`${favored} (Un)`,amount:total.under_layout}
            }});
        });
    });
});

app.post('/api/admin/risk/layout-confirm', requireAdmin, (req,res)=>{
    const key=req.body.match_id;
    if(!key) return res.status(400).json({success:false,message:'Match ID is required'});
    // match_id is the internal database ID submitted by the risk modal.
    db.get(`SELECT * FROM matches WHERE id=?`,[key],(me,match)=>{
        if(me)return res.status(500).json({success:false,error:me.message});
        if(!match)return res.status(404).json({success:false,message:'Match not found'});
        db.all(`SELECT bet_type,choice,amount,status FROM bets WHERE match_db_id=? AND (status IS NULL OR status='Pending')`,[match.id],(be,bets)=>{
            if(be)return res.status(500).json({success:false,error:be.message});
            const teams=String(match.match_name||'').split(/\s+vs\s+/i).map(x=>x.trim());
            const actualHome=teams[0]||'Home', actualAway=teams[1]||'Away';
            const favored=String(match.body_favored_side||'home').toLowerCase()==='away'?actualAway:actualHome;
            const opposite=favored===actualHome?actualAway:actualHome;
            let home=0,away=0,over=0,under=0;
            (bets||[]).forEach(b=>{const amt=Number(b.amount||0),choice=String(b.choice||'').trim(),isBody=/body|ဘော်ဒီ/i.test(String(b.bet_type||''));if(isBody){if(choice===favored)home+=amt;else if(choice===opposite)away+=amt;}else if(/^over/i.test(choice)||/ပေါ်/.test(choice))over+=amt;else if(/^under/i.test(choice)||/အောက်/.test(choice))under+=amt;});
            const homeL=Math.max(home-away,0),awayL=Math.max(away-home,0),overL=Math.max(over-under,0),underL=Math.max(under-over,0),totalL=homeL+awayL+overL+underL;
            db.serialize(()=>{
                db.run('BEGIN TRANSACTION');
                db.run(`INSERT INTO risk_layouts(match_db_id,match_id,home_layout,away_layout,over_layout,under_layout,total_layout,status,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,[match.id,String(match.custom_match_id||match.id),homeL,awayL,overL,underL,totalL,'Confirmed',req.authUser.username],function(layoutErr){
                    if(layoutErr){db.run('ROLLBACK');return res.status(500).json({success:false,error:layoutErr.message});}
                    const layoutId=this.lastID;
                    addAdminLedger({entry_type:'Risk Layout',username:null,amount:totalL,direction:'OUT',reference_type:'Risk Layout',reference_id:String(layoutId),reason:`Layout confirmed for Match ${match.custom_match_id||match.id}`,processed_by:req.authUser.username},(ledgerErr)=>{
                        if(ledgerErr){db.run('ROLLBACK');return res.status(500).json({success:false,error:ledgerErr.message});}
                        db.run('COMMIT',commitErr=>{if(commitErr)return res.status(500).json({success:false,error:commitErr.message});res.json({success:true,layout_id:layoutId,amount:totalL,message:'Layout confirmed and added to Admin Ledger.'});});
                    });
                });
            });
        });
    });
});

// ================= RISK MANAGEMENT API ================= //
app.post('/api/admin/forward-risk', requireAdmin, (req, res) => {
    const { match_id, choice, amount } = req.body;
    if (!match_id || !choice || !amount) {
        return res.status(400).json({ success: false, message: 'အချက်အလက်များ ပြည့်စုံစွာ ဖြည့်ပါ' });
    }

    db.run(`INSERT INTO risk_forwards (match_id, choice, amount) VALUES (?, ?, ?)`, [match_id, choice, amount], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Risk transferred successfully', forwardId: this.lastID });
    });
});

// Static Fallback Routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});


// ================= ADMIN SETTINGS ================= //
const ADMIN_SETTING_DEFAULTS = {
    global_lock_minutes: '15',
    late_bet_cap_enabled: '0',
    late_bet_cap_window_minutes: '5',
    late_bet_cap_amount: '0',
    default_commission_percent: '5',
    minimum_bet_amount: '0',
    maximum_bet_amount: '0',
    maintenance_mode: '0',
    bettor_rules: 'Please read the rules before placing a bet.\nBets cannot be cancelled after confirmation.\nBetting is available only before the closing time.',
    bettor_rules_enabled: '1'
};

function ensureAdminSettings(callback) {
    const keys = Object.entries(ADMIN_SETTING_DEFAULTS);
    let i = 0;
    const next = () => {
        if (i >= keys.length) return callback && callback();
        const [key, value] = keys[i++];
        db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES(?,?)`, [key, value], (err) => {
            if (err) return callback && callback(err);
            next();
        });
    };
    next();
}

app.get('/api/admin/settings', requireAdmin, (req, res) => {
    ensureAdminSettings((seedErr) => {
        if (seedErr) return res.status(500).json({success:false,error:seedErr.message});
        db.all(`SELECT key,value,updated_at FROM site_settings ORDER BY key`, [], (err, rows) => {
            if (err) return res.status(500).json({success:false,error:err.message});
            const data = {...ADMIN_SETTING_DEFAULTS};
            (rows || []).forEach(r => { data[r.key] = r.value; });
            res.json({success:true,data,timeZone:YGN_TIMEZONE});
        });
    });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    ensureAdminSettings((seedErr) => {
        if (seedErr) return res.status(500).json({success:false,error:seedErr.message});
        const body = req.body || {};
        const clean = {};
        const lock = Number(body.global_lock_minutes);
        if ([2,5,10,15].includes(lock)) clean.global_lock_minutes = String(lock);
        if (body.late_bet_cap_enabled !== undefined) clean.late_bet_cap_enabled = String(body.late_bet_cap_enabled) === '1' || body.late_bet_cap_enabled === true ? '1' : '0';
        clean.late_bet_cap_window_minutes = '5';
        const lateAmt = Number(body.late_bet_cap_amount);
        if (Number.isFinite(lateAmt) && lateAmt >= 0) clean.late_bet_cap_amount = String(lateAmt);
        const commission = Number(body.default_commission_percent);
        if (Number.isFinite(commission) && commission >= 0 && commission <= 100) clean.default_commission_percent = String(commission);
        const minBet = Number(body.minimum_bet_amount);
        if (Number.isFinite(minBet) && minBet >= 0) clean.minimum_bet_amount = String(minBet);
        const maxBet = Number(body.maximum_bet_amount);
        if (Number.isFinite(maxBet) && maxBet >= 0) clean.maximum_bet_amount = String(maxBet);
        if (body.maintenance_mode !== undefined) clean.maintenance_mode = String(body.maintenance_mode) === '1' || body.maintenance_mode === true ? '1' : '0';
        const entries = Object.entries(clean);
        if (!entries.length) return res.status(400).json({success:false,message:'No valid settings supplied'});
        let idx = 0;
        const writeNext = () => {
            if (idx >= entries.length) {
                res.json({success:true,data:clean});
                return;
            }
            const [key,value] = entries[idx++];
            db.run(`INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`, [key,value], (err) => {
                if (err) return res.status(500).json({success:false,error:err.message});
                writeNext();
            });
        };
        writeNext();
    });
});

// ================= ADMIN BACKUP / RESTORE ================= //
const BACKUP_DIR = path.join(__dirname, 'backups');
function ensureBackupDir() { try { fs.mkdirSync(BACKUP_DIR, {recursive:true}); } catch (_) {} }
function safeBackupName(name) {
    const base = path.basename(String(name || ''));
    return /^[A-Za-z0-9._-]+\.db$/.test(base) ? base : null;
}
function checkpointDatabase(callback) {
    db.run(`PRAGMA wal_checkpoint(TRUNCATE)`, (err) => callback && callback(err));
}
function createDatabaseBackup(callback) {
    ensureBackupDir();
    checkpointDatabase((cpErr) => {
        if (cpErr) return callback(cpErr);
        const stamp = new Intl.DateTimeFormat('en-CA', {timeZone:YGN_TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(new Date()).replace(/[^0-9]/g,'');
        const name = `betting_${stamp}.db`;
        const dest = path.join(BACKUP_DIR, name);
        fs.copyFile('./betting.db', dest, (err) => callback(err, name, dest));
    });
}

app.get('/api/admin/backups', requireAdmin, (req,res) => {
    ensureBackupDir();
    fs.readdir(BACKUP_DIR, (err, files) => {
        if (err) return res.status(500).json({success:false,error:err.message});
        const rows = files.filter(f=>/^betting_[A-Za-z0-9._-]+\.db$/.test(f)).map(name=>{
            const st = fs.statSync(path.join(BACKUP_DIR,name));
            return {name,size:st.size,created_at:st.birthtime.toISOString()};
        }).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        res.json({success:true,data:rows});
    });
});

app.post('/api/admin/backups', requireAdmin, (req,res) => {
    createDatabaseBackup((err,name) => {
        if (err) return res.status(500).json({success:false,error:err.message});
        writeSecurityAudit({username:req.authUser.username,role:req.authUser.role,action:'DATABASE_BACKUP',module:'backup',target:name,details:'Manual database backup created',severity:'INFO',device:auditDevice(req),ip_address:auditIp(req)});
        res.json({success:true,name});
    });
});

app.get('/api/admin/backups/:name/download', requireAdmin, (req,res) => {
    const name = safeBackupName(req.params.name);
    if (!name) return res.status(400).json({success:false,message:'Invalid backup name'});
    const file = path.join(BACKUP_DIR,name);
    if (!fs.existsSync(file)) return res.status(404).json({success:false,message:'Backup not found'});
    res.download(file,name);
});

app.post('/api/admin/backups/:name/restore', requireAdmin, (req,res) => {
    const name = safeBackupName(req.params.name);
    if (!name) return res.status(400).json({success:false,message:'Invalid backup name'});
    const source = path.join(BACKUP_DIR,name);
    if (!fs.existsSync(source)) return res.status(404).json({success:false,message:'Backup not found'});
    createDatabaseBackup((backupErr, emergencyName) => {
        if (backupErr) return res.status(500).json({success:false,error:`Emergency backup failed: ${backupErr.message}`});
        checkpointDatabase((cpErr) => {
            if (cpErr) return res.status(500).json({success:false,error:cpErr.message});
            db.close((closeErr) => {
                if (closeErr) return res.status(500).json({success:false,error:closeErr.message});
                fs.copyFile(source, './betting.db', (copyErr) => {
                    db.open((openErr) => {
                        if (openErr) return res.status(500).json({success:false,error:openErr.message});
                        db.run('PRAGMA journal_mode = WAL;');
                        db.run('PRAGMA foreign_keys = ON;');
                        if (copyErr) return res.status(500).json({success:false,error:copyErr.message});
                        writeSecurityAudit({username:req.authUser.username,role:req.authUser.role,action:'DATABASE_RESTORE',module:'backup',target:name,details:`Restored database. Emergency backup: ${emergencyName}`,severity:'CRITICAL',device:auditDevice(req),ip_address:auditIp(req)});
                        res.json({success:true,restored:name,emergency_backup:emergencyName});
                    });
                });
            });
        });
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Start — wait until all required SQLite columns exist.
// Older databases may have been created before newer columns such as bets.status
// were introduced. Starting Express before those ALTER TABLE migrations finish
// causes intermittent `SQLITE_ERROR: no such column: status` errors.
function ensureColumn(table, column, definition) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, [], (err, columns) => {
            if (err) return reject(err);
            if ((columns || []).some(c => c.name === column)) return resolve();
            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (e) => {
                if (e && !String(e.message || '').includes('duplicate column name')) return reject(e);
                resolve();
            });
        });
    });
}

async function ensureRequiredSchema() {
    // The CREATE TABLE statements above are queued first. This read acts as a
    // barrier before we begin the compatibility migrations for old databases.
    await new Promise((resolve, reject) => {
        db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='bets'`, [], (err, row) => {
            if (err) reject(err);
            else if (row) resolve();
            else reject(new Error('bets table was not initialized'));
        });
    });

    // Compatibility migration for older databases created before Website
    // Notice / Global Lock settings were introduced.
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS security_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            username TEXT DEFAULT '',
            role TEXT DEFAULT '',
            action TEXT NOT NULL,
            module TEXT DEFAULT '',
            target TEXT DEFAULT '',
            details TEXT DEFAULT '',
            severity TEXT DEFAULT 'INFO',
            device TEXT DEFAULT '',
            ip_address TEXT DEFAULT ''
        )`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE INDEX IF NOT EXISTS idx_security_audit_created_at ON security_audit(created_at)` , e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE INDEX IF NOT EXISTS idx_security_audit_action ON security_audit(action)` , e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE INDEX IF NOT EXISTS idx_security_audit_username ON security_audit(username)` , e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS admin_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            reference_type TEXT DEFAULT '',
            reference_id TEXT DEFAULT '',
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS site_settings (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('global_lock_minutes','15')`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('bettor_notice','Admin Notice: Welcome to our betting service.')`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`INSERT OR IGNORE INTO site_settings(key,value) VALUES('bettor_notice_enabled','1')`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS user_rule_acceptances (
            user_id INTEGER NOT NULL,
            rules_version TEXT NOT NULL,
            accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(user_id, rules_version)
        )`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS final_score_publications (
            match_db_id INTEGER PRIMARY KEY,
            published INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            published_at DATETIME
        )`, e => e ? reject(e) : resolve());
    });

    const required = [
        ['users', 'status', `TEXT DEFAULT 'Active'`],
        ['users', 'failed_login_attempts', 'INTEGER DEFAULT 0'],
        ['users', 'locked_until', 'DATETIME'],
        ['users', 'last_login_at', 'DATETIME'],
        ['matches', 'status', `TEXT DEFAULT 'Open'`],
        ['matches', 'home_score', 'INTEGER'],
        ['matches', 'away_score', 'INTEGER'],
        ['matches', 'lock_minutes', 'INTEGER'],
        ['matches', 'lock_mode', `TEXT DEFAULT 'global'`],
        ['matches', 'suspend_reason', 'TEXT'],
        ['matches', 'body_favored_side', `TEXT DEFAULT 'home'`],
        ['bets', 'match_db_id', 'INTEGER'],
        ['bets', 'ticket_no', 'TEXT'],
        ['bets', 'odds_rate', 'TEXT'],
        ['bets', 'body_favored_side', 'TEXT'],
        ['bets', 'status', `TEXT DEFAULT 'Pending'`],
        ['bets', 'parlay_group_id', 'TEXT DEFAULT NULL'],
        ['bets', 'result_factor', 'REAL DEFAULT 0'],
        ['bets', 'gross_profit', 'REAL DEFAULT 0'],
        ['bets', 'commission', 'REAL DEFAULT 0'],
        ['bets', 'net_profit', 'REAL DEFAULT 0'],
        ['bets', 'payout', 'REAL DEFAULT 0'],
        ['bets', 'settled_at', 'DATETIME'],
        ['transactions', 'status', `TEXT DEFAULT 'Pending'`],
        ['transactions', 'processed_by', 'TEXT'],
        ['transactions', 'process_by_who', 'TEXT'],
        ['transactions', 'process_by_where', 'TEXT'],
        ['transactions', 'processed_at', 'DATETIME'],
    ];

    for (const [table, column, definition] of required) {
        await ensureColumn(table, column, definition);
    }

    await new Promise((resolve, reject) => {
        db.run(`UPDATE users SET status='Active' WHERE status IS NULL OR status=''`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE bets SET status='Pending' WHERE status IS NULL OR status=''`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE transactions SET status='Pending' WHERE status IS NULL OR status=''`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE transactions
                SET process_by_who=COALESCE(NULLIF(process_by_who,''),'System'),
                    process_by_where=COALESCE(NULLIF(process_by_where,''),'Server'),
                    processed_at=COALESCE(processed_at, created_at),
                    processed_by=COALESCE(NULLIF(processed_by,''),'System')
                WHERE status='Completed'
                  AND type IN ('Bet Placed','Parlay Bet','Payout','Refund')
                  AND (process_by_who IS NULL OR process_by_who='' OR process_by_where IS NULL OR process_by_where='' OR processed_at IS NULL)`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE transactions
                SET process_by_who=COALESCE(NULLIF(process_by_who,''),'Admin'),
                    process_by_where=COALESCE(NULLIF(process_by_where,''),'Unknown'),
                    processed_at=COALESCE(processed_at, created_at),
                    processed_by=COALESCE(NULLIF(processed_by,''),'Admin')
                WHERE status IN ('Approved','Rejected')
                  AND (process_by_who IS NULL OR process_by_who='' OR process_by_where IS NULL OR process_by_where='' OR processed_at IS NULL)`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE matches SET lock_mode='global' WHERE lock_mode IS NULL OR TRIM(lock_mode)=''`, e => e ? reject(e) : resolve());
    });
    await new Promise((resolve, reject) => {
        db.run(`UPDATE matches SET body_favored_side='home' WHERE body_favored_side IS NULL OR TRIM(body_favored_side)=''`, e => e ? reject(e) : resolve());
    });

    // Auto-fix: reopen matches whose kickoff is still in the future.
    await new Promise((resolve) => {
        const nowMs = Date.now();
        db.all(`SELECT id, match_time FROM matches WHERE status = 'Closed'`, [], (err, rows) => {
            if (err || !rows || rows.length === 0) return resolve();
            const reopenIds = rows.filter(row => {
                const t = parseMatchTime(row.match_time);
                return t === 0 || t > nowMs;
            }).map(row => row.id);
            if (!reopenIds.length) return resolve();
            const placeholders = reopenIds.map(() => '?').join(',');
            db.run(`UPDATE matches SET status='Open' WHERE id IN (${placeholders})`, reopenIds, () => resolve());
        });
    });
}

ensureRequiredSchema()
    .then(() => {
        console.log('Database schema ready.');
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Admin Panel: http://localhost:${PORT}/admin`);
        });
    })
    .catch((err) => {
        console.error('Database schema initialization failed:', err);
        process.exit(1);
    });
