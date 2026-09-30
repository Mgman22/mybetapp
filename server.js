const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');

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

function getBetLockTimeMs(matchTime) {
    const kickoff = parseMatchTime(matchTime);
    return kickoff > 0 ? kickoff - BET_LOCK_MINUTES * 60 * 1000 : 0;
}

function isBettingLocked(match) {
    if (!match) return true;
    if (String(match.status || '').toLowerCase() !== 'open') return true;
    const lockAt = getBetLockTimeMs(match.match_time);
    return lockAt > 0 && Date.now() >= lockAt;
}

function decorateMatch(match) {
    const kickoffMs = parseMatchTime(match.match_time);
    const lockAtMs = getBetLockTimeMs(match.match_time);
    const locked = isBettingLocked(match);
    return {
        ...match,
        kickoff_at_ms: kickoffMs || null,
        betting_lock_at_ms: lockAtMs || null,
        betting_open: !locked,
        betting_lock_minutes: BET_LOCK_MINUTES
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
        role TEXT DEFAULT 'user'
    )`);

    // 2. Matches Table
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        league TEXT DEFAULT 'ENGLISH PREMIER LEAGUE',
        custom_match_id TEXT UNIQUE,
        match_name TEXT,
        body_odds TEXT,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Risk Forwards Table
    db.run(`CREATE TABLE IF NOT EXISTS risk_forwards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        choice TEXT,
        amount REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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

    // Auto-fix: ပွဲချိန်မရောက်သေးသော ပွဲများကို Status: Open သို့ ပြန်ပြောင်းပေးခြင်း
    const nowMs = Date.now();
    db.all(`SELECT id, match_time FROM matches WHERE status = 'Closed'`, [], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            const reopenIds = rows.filter(row => {
                const matchTimeMs = parseMatchTime(row.match_time);
                return matchTimeMs === 0 || matchTimeMs > nowMs;
            }).map(row => row.id);

            if (reopenIds.length > 0) {
                const placeholders = reopenIds.map(() => '?').join(',');
                db.run(`UPDATE matches SET status = 'Open' WHERE id IN (${placeholders})`, reopenIds);
            }
        }
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

function calculateBetOutcome(betType, choice, oddsStr, homeScore, awayScore, matchName, amount) {
    const home = Number(homeScore);
    const away = Number(awayScore);
    const betAmount = Number(amount) || 0;
    const totalGoals = home + away;
    const goalDiff = home - away;
    const type = String(betType || '').toLowerCase();
    const selected = String(choice || '').trim();
    const teams = String(matchName || '').split(/\s+vs\s+/i);
    const homeTeam = teams[0] ? teams[0].trim() : '';

    let factor;
    if (type.includes('goal') || type.includes('ဂိုးပေါင်း')) {
        const overFactor = factorForLine(totalGoals, oddsStr);
        const isOver = /over|ပေါ်/i.test(selected);
        factor = isOver ? overFactor : -overFactor;
    } else if (type.includes('body') || type.includes('ဘော်ဒီ')) {
        const bodyFactor = factorForLine(goalDiff, oddsStr);
        const isHome = selected === homeTeam;
        factor = isHome ? bodyFactor : -bodyFactor;
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

// ================= AUTH APIs ================= //
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username နှင့် Password ထည့်သွင်းပါ။' });
    }

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ success: false, message: 'Invalid username or password' });

        bcrypt.compare(password, row.password, (err, match) => {
            if (err || !match) {
                return res.status(400).json({ success: false, message: 'Invalid username or password' });
            }
            const { password: _, ...userInfo } = row;
            res.json({ success: true, user: userInfo });
        });
    });
});

app.get('/api/user/balance', (req, res) => {
    const { username } = req.query;
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: row.balance });
    });
});

// ================= USER MANAGEMENT APIs ================= //
app.get(['/api/users', '/api/admin/users'], (req, res) => {
    db.all(`SELECT id, username, balance, role FROM users WHERE role = 'user' ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.post(['/api/users', '/api/admin/create-user'], (req, res) => {
    const { username, password, balance, initial_balance } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username နှင့် Password လိုအပ်ပါသည်။' });
    }
    const initialBal = balance !== undefined ? Number(balance) : (Number(initial_balance) || 0);

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(`INSERT INTO users (username, password, balance, role) VALUES (?, ?, ?, 'user')`, 
        [username, hashedPassword, initialBal], function(err) {
        if (err) return res.status(400).json({ success: false, message: 'Username ဖြင့် အကောင့်ရှိပြီးသားဖြစ်ပါသည် သို့မဟုတ် အချက်အလက်မှားယွင်းနေပါသည်။' });
        res.json({ success: true, message: 'User account created successfully', userId: this.lastID });
    });
});

app.post(['/api/users/add-balance', '/api/admin/update-balance'], (req, res) => {
    const { username, amount } = req.body;
    const amt = Number(amount);
    if (isNaN(amt)) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });

    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Balance updated successfully' });
    });
});

// ================= USER PROFILE / ADMIN USER EDIT APIs ================= //
app.post('/api/user/change-password', (req, res) => {
    const { username, current_password, new_password } = req.body;
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
                res.json({ success: true, message: 'Password ပြောင်းပြီးပါပြီ။' });
            });
        });
    });
});

// Admin: edit username / balance / optional password. Username changes are
// propagated to historical bet and transaction records so the account history
// remains attached to the edited user.
app.put(['/api/users/:id', '/api/admin/users/:id'], (req, res) => {
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
app.delete(['/api/users/:id', '/api/admin/users/:id'], (req, res) => {
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

// ================= MATCH MANAGEMENT APIs ================= //
app.get(['/api/matches', '/api/admin/matches'], (req, res) => {
    checkAndCloseExpiredMatches(() => {
        db.all(`SELECT * FROM matches`, [], (err, rows) => {
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
            res.json({ success: true, data: sorted.map(decorateMatch) });
        });
    });
});

app.post(['/api/matches', '/api/admin/add-match'], (req, res) => {
    const { league, custom_match_id, match_name, team_a, team_b, body_odds, goal_odds, match_time } = req.body;
    
    const finalMatchName = match_name || `${team_a} vs ${team_b}`;
    const mId = custom_match_id || ('M-' + Date.now());

    if (!finalMatchName || !match_time) {
        return res.status(400).json({ success: false, message: 'ကျေးဇူးပြု၍ လိုအပ်သောအချက်အလက်များ ပြည့်စုံစွာဖြည့်ပါ' });
    }

    db.run(`INSERT INTO matches (league, custom_match_id, match_name, body_odds, goal_odds, match_time, status) VALUES (?, ?, ?, ?, ?, ?, 'Open')`, 
        [league || 'ENGLISH PREMIER LEAGUE', mId, finalMatchName, body_odds, goal_odds, match_time], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Match added successfully', matchId: this.lastID });
    });
});

app.patch('/api/matches/:id/status', (req, res) => {
    const { status } = req.body;
    db.run(`UPDATE matches SET status = ? WHERE id = ? OR custom_match_id = ?`, [status, req.params.id, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match status updated successfully' });
    });
});

app.patch('/api/matches/:id/odds', (req, res) => {
    const matchId = req.params.id;
    const { body_odds, goal_odds } = req.body;
    
    const query = `UPDATE matches SET body_odds = ?, goal_odds = ? WHERE id = ? OR custom_match_id = ?`;
    
    db.run(query, [body_odds, goal_odds, matchId, matchId], function(err) {
        if (err) {
            console.error('Odds update error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: 'Match not found' });
        }

        res.json({ success: true, message: 'ပွဲစဉ်ကြေးများကို အောင်မြင်စွာ ပြင်ဆင်ပြီးပါပြီ။' });
    });
});

app.delete(['/api/matches/:id', '/api/admin/delete-match'], (req, res) => {
    const matchId = req.params.id || req.body.match_id;
    db.run(`DELETE FROM matches WHERE id = ? OR custom_match_id = ?`, [matchId, matchId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Match deleted successfully' });
    });
});

// ================= MATCH SETTLEMENT API (WITH TRANSACTION SAFETY) ================= //
app.post(['/api/matches/save-result', '/api/admin/update-result'], (req, res) => {
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

                db.all(`SELECT * FROM bets WHERE (match_id = ? OR match_id = ?) AND status = 'Pending'`, [match.custom_match_id, match.id], (err, bets) => {
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
                        const odds = (bet.bet_type.toLowerCase().includes('body') || bet.bet_type.includes('ဘော်ဒီ')) ? match.body_odds : match.goal_odds;
                        const outcome = calculateBetOutcome(
                            bet.bet_type,
                            bet.choice,
                            odds,
                            home_score,
                            away_score,
                            match.match_name,
                            bet.amount
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
                                db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, 'Payout', 'Wallet', ?, 'Success', CURRENT_TIMESTAMP)`, [bet.username, outcome.returnAmount], (txErr) => {
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

// ================= BETTING APIs (WITH SAFEGUARDS & TRANSACTION SAFETY) ================= //
app.get(['/api/bets', '/api/admin/bets'], (req, res) => {
    const { username } = req.query;
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

app.get('/api/user/bets', (req, res) => {
    const { username } = req.query;
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

app.delete('/api/bets/:id', (req, res) => {
    db.run(`DELETE FROM bets WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Bet record deleted successfully' });
    });
});

app.post('/api/user/place-bet', (req, res) => {
    const { username, bets, is_parlay, total_amount } = req.body;

    let incomingBets = Array.isArray(bets) ? bets : null;
    if (!incomingBets && req.body.match_id) {
        incomingBets = [{
            match_id: req.body.match_id,
            match_name: req.body.match_name,
            bet_type: req.body.bet_type,
            choice: req.body.choice,
            odds_rate: req.body.odds_rate,
            amount: req.body.amount
        }];
    }

    if (!username || !incomingBets || incomingBets.length === 0) {
        return res.status(400).json({ success: false, message: 'လောင်းမည့်ပွဲစဉ်များ မရှိပါ။' });
    }

    const cleanBets = incomingBets.map(b => ({
        match_id: String(b.match_id || '').trim(),
        bet_type: String(b.bet_type || '').trim(),
        choice: String(b.choice || '').trim(),
        amount: Number(b.amount)
    }));

    if (cleanBets.some(b => !b.match_id || !b.bet_type || !b.choice || !Number.isFinite(b.amount) || b.amount <= 0)) {
        return res.status(400).json({ success: false, message: 'Bet အချက်အလက် မမှန်ကန်ပါ။' });
    }

    const totalDeduction = is_parlay
        ? Number(total_amount)
        : cleanBets.reduce((sum, b) => sum + b.amount, 0);

    if (!Number.isFinite(totalDeduction) || totalDeduction <= 0) {
        return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });
    }

    // Never trust client-supplied match name / odds / time. Load the real match
    // record and enforce the 15-minute cut-off on the server.
    const ids = [...new Set(cleanBets.map(b => b.match_id))];
    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT * FROM matches WHERE id IN (${placeholders}) OR custom_match_id IN (${placeholders})`, [...ids, ...ids], (matchErr, rows) => {
        if (matchErr) return res.status(500).json({ success: false, error: matchErr.message });

        const matchMap = new Map();
        (rows || []).forEach(m => {
            matchMap.set(String(m.id), m);
            matchMap.set(String(m.custom_match_id), m);
        });

        for (const b of cleanBets) {
            const match = matchMap.get(String(b.match_id));
            if (!match) {
                return res.status(400).json({ success: false, message: `ပွဲစဉ် ${b.match_id} ကို ရှာမတွေ့ပါ။` });
            }
            if (String(match.status).toLowerCase() !== 'open') {
                return res.status(400).json({ success: false, message: `${match.match_name} ပွဲတွင် လောင်း၍မရတော့ပါ။` });
            }
            const kickoffMs = parseMatchTime(match.match_time);
            if (!kickoffMs) {
                return res.status(400).json({ success: false, message: 'ပွဲချိန် မမှန်ကန်ပါ။' });
            }
            if (Date.now() >= kickoffMs - BET_LOCK_MINUTES * 60 * 1000) {
                return res.status(400).json({
                    success: false,
                    code: 'BETTING_CLOSED_EARLY',
                    message: `ပွဲစမည့်အချိန်မတိုင်မီ ${BET_LOCK_MINUTES} မိနစ်အလိုမှ လောင်းကြေးပိတ်ထားပါသည်။`
                });
            }

            const isBody = /body|ဘော်ဒီ/i.test(b.bet_type);
            const realOdds = isBody ? match.body_odds : match.goal_odds;
            if (!realOdds) {
                return res.status(400).json({ success: false, message: 'ဒီပွဲအတွက် ကြေးမရှိပါ။' });
            }

            // Basic choice validation against the actual match.
            const teams = String(match.match_name || '').split(/\s+vs\s+/i).map(x => x.trim());
            if (isBody) {
                if (b.choice !== teams[0] && b.choice !== teams[1]) {
                    return res.status(400).json({ success: false, message: 'ရွေးချယ်ထားသော အသင်း မမှန်ကန်ပါ။' });
                }
            } else if (!/^(over|under|ပေါ်|အောက်)/i.test(b.choice)) {
                return res.status(400).json({ success: false, message: 'ဂိုးပေါင်းရွေးချယ်မှု မမှန်ကန်ပါ။' });
            }
        }

        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!user) return res.status(400).json({ success: false, message: 'အသုံးပြုသူ အကောင့်ကို ရှာမတွေ့ပါ။ ကျေးဇူးပြု၍ Login ပြန်ဝင်ပါ။' });
            if (Number(user.balance) < totalDeduction) return res.status(400).json({ success: false, message: 'လက်ကျန်ငွေ မလုံလောက်ပါ။' });

            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                db.run(`UPDATE users SET balance = balance - ? WHERE username = ? AND balance >= ?`, [totalDeduction, username, totalDeduction], function(updateErr) {
                    if (updateErr || this.changes !== 1) {
                        db.run('ROLLBACK');
                        return res.status(400).json({ success: false, message: 'လက်ကျန်ငွေ မလုံလောက်ပါ သို့မဟုတ် ငွေစာရင်းပြောင်းလဲသွားပါသည်။' });
                    }

                    const parlayGroupId = is_parlay ? 'PARLAY-' + Date.now() : null;
                    let completed = 0;
                    let hasError = false;

                    cleanBets.forEach((b) => {
                        const match = matchMap.get(String(b.match_id));
                        const isBody = /body|ဘော်ဒီ/i.test(b.bet_type);
                        const realOdds = isBody ? match.body_odds : match.goal_odds;
                        const stakeForRow = is_parlay ? (completed === 0 ? totalDeduction : 0) : b.amount;

                        db.run(`INSERT INTO bets (username, match_id, match_name, bet_type, choice, amount, odds_rate, status, parlay_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
                            [username, match.custom_match_id || match.id, match.match_name, b.bet_type, b.choice, stakeForRow, realOdds, parlayGroupId], (insertErr) => {
                                if (insertErr) hasError = true;
                                completed++;

                                if (completed === cleanBets.length) {
                                    if (hasError) {
                                        db.run('ROLLBACK');
                                        return res.status(500).json({ success: false, message: 'Failed to place bet.' });
                                    }

                                    db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, ?, 'Wallet', ?, 'Completed', CURRENT_TIMESTAMP)`,
                                        [username, is_parlay ? 'Parlay Bet' : 'Bet Placed', totalDeduction], (txErr) => {
                                        if (txErr) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ success: false, message: 'Transaction record မသိမ်းနိုင်ပါ။' });
                                        }
                                        db.run('COMMIT', (commitErr) => {
                                            if (commitErr) return res.status(500).json({ success: false, error: commitErr.message });
                                            res.json({ success: true, message: 'Successfully placed bet(s)' });
                                        });
                                    });
                                }
                            });
                    });
                });
            });
        });
    });
});

// ================= DEPOSIT, WITHDRAW & ADMIN APPROVAL APIs ================= //
app.post('/api/user/deposit', (req, res) => {
    const { username, payment_method, amount, transaction_id } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });

    db.run(`INSERT INTO transactions (username, type, payment_method, amount, transaction_id, status, created_at) VALUES (?, 'Deposit', ?, ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
        [username, payment_method, amt, transaction_id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Deposit request submitted successfully' });
    });
});

app.post('/api/user/withdraw', (req, res) => {
    const { username, payment_method, account_name, phone, amount } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ success: false, message: 'ငွေပမာဏ မမှန်ကန်ပါ။' });
    
    db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: 'User not found' });
        if (user.balance < amt) return res.status(400).json({ success: false, message: 'Insufficient balance' });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);

            db.run(`UPDATE users SET balance = balance - ? WHERE username = ?`, [amt, username], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ success: false, error: err.message });
                }

                db.run(`INSERT INTO transactions (username, type, payment_method, account_name, phone, amount, status, created_at) VALUES (?, 'Withdraw', ?, ?, ?, ?, 'Pending', CURRENT_TIMESTAMP)`,
                    [username, payment_method, account_name, phone, amt], function(err) {
                    if (err) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ success: false, error: err.message });
                    }
                    db.run(`COMMIT`);
                    res.json({ success: true, message: 'Withdraw request submitted successfully' });
                });
            });
        });
    });
});

app.get('/api/user/transactions', (req, res) => {
    const { username } = req.query;
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
app.post('/api/admin/transactions/action', (req, res) => {
    const { transaction_id, status, username, amount, type } = req.body; 
    const amt = Number(amount);

    db.serialize(() => {
        db.run(`BEGIN TRANSACTION`);

        db.run(`UPDATE transactions SET status = ? WHERE id = ?`, [status, transaction_id], function(err) {
            if (err) {
                db.run(`ROLLBACK`);
                return res.status(500).json({ success: false, error: err.message });
            }

            if (status === 'Approved' && type === 'Deposit') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username]);
            }
            
            if (status === 'Rejected' && type === 'Withdraw') {
                db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amt, username]);
            }

            db.run(`COMMIT`);
            res.json({ success: true, message: `ငွေစာရင်း တောင်းဆိုမှုမှာ ${status} ဖြစ်သွားပါပြီ။` });
        });
    });
});

// ================= RISK MANAGEMENT API ================= //
app.get('/api/admin/risk-summary', (req, res) => {
    const sql = `
        SELECT m.id, m.custom_match_id, m.match_name, m.match_time, m.status,
               COUNT(DISTINCT b.username) AS bettor_count,
               COALESCE(SUM(b.amount),0) AS total_pool,
               COALESCE(SUM(CASE WHEN b.choice = TRIM(substr(m.match_name,1,instr(m.match_name,' vs ')-1)) THEN b.amount ELSE 0 END),0) AS home_amount,
               COALESCE(SUM(CASE WHEN b.choice = TRIM(substr(m.match_name,instr(m.match_name,' vs ')+4)) THEN b.amount ELSE 0 END),0) AS away_amount,
               COALESCE(SUM(CASE WHEN lower(b.choice) LIKE 'over%' THEN b.amount ELSE 0 END),0) AS over_amount,
               COALESCE(SUM(CASE WHEN lower(b.choice) LIKE 'under%' THEN b.amount ELSE 0 END),0) AS under_amount
        FROM matches m LEFT JOIN bets b ON CAST(b.match_id AS TEXT)=CAST(COALESCE(m.custom_match_id,m.id) AS TEXT) OR CAST(b.match_id AS TEXT)=CAST(m.id AS TEXT)
        GROUP BY m.id ORDER BY CAST(COALESCE(m.custom_match_id,m.id) AS INTEGER), m.match_time`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ success:false, error:err.message });
        res.json({ success:true, data: rows.map(r => ({...r, max_side_risk: Math.max(Number(r.home_amount)||0,Number(r.away_amount)||0,Number(r.over_amount)||0,Number(r.under_amount)||0)})) });
    });
});


app.post('/api/admin/forward-risk', (req, res) => {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Start
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin`);
});