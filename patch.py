from pathlib import Path
p=Path('/mnt/data/phase_marker/server.js')
s=p.read_text()
# Add ledger balance_after column in schema
s=s.replace("        processed_by TEXT,\n        created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n    )`);\n    db.run(`CREATE TABLE IF NOT EXISTS balance_adjustments", "        processed_by TEXT,\n        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n        balance_after REAL DEFAULT 0\n    )`);\n    db.run(`CREATE TABLE IF NOT EXISTS balance_adjustments",1)
# Actually the replacement may target admin_ledger first occurrence; ensure migration later.
needle="    db.all(`PRAGMA table_info(matches)`, [], (e, cols) => {"
insert="""    db.all(`PRAGMA table_info(admin_ledger)`, [], (e, cols) => {
        if (!e && cols && !cols.some(c=>c.name==='balance_after')) db.run(`ALTER TABLE admin_ledger ADD COLUMN balance_after REAL DEFAULT 0`);
    });
    db.all(`PRAGMA table_info(transactions)`, [], (e, cols) => {
        if (!e && cols && !cols.some(c=>c.name==='processed_by')) db.run(`ALTER TABLE transactions ADD COLUMN processed_by TEXT`);
    });
"""
s=s.replace(needle,insert+needle,1)
# Insert helper before admin transaction routes
helper="""
function addAdminLedger(entry, callback=()=>{}) {
    const e = entry || {};
    const amount = Math.abs(Number(e.amount || 0));
    const direction = e.direction === 'OUT' ? 'OUT' : 'IN';
    db.run(`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by,balance_after)
            VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END) FROM admin_ledger),0))`,
        [String(e.entry_type||'Ledger'), e.username||null, amount, direction, e.reference_type||null, e.reference_id==null?null:String(e.reference_id), e.reason||null, e.processed_by||null], callback);
}

"""
s=s.replace("// Admin: list all deposit/withdraw/payout transactions for the Transactions tab.",helper+"// Admin: list all deposit/withdraw/payout transactions for the Transactions tab.",1)
# Fix balance adjustment direction
old="`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by) VALUES('Balance Adjustment',?,?,?,?,?,?,?)`,[u.username,Math.abs(amt),amt>0?'IN':'OUT','User',String(req.params.id),reason,req.authUser.username]"
new="`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by) VALUES('Balance Adjustment',?,?,?,?,?,?,?)`,[u.username,Math.abs(amt),amt>0?'OUT':'IN','User',String(req.params.id),reason,req.authUser.username]"
s=s.replace(old,new)
# Replace add-balance route with reason + ledger + transaction record
start=s.index("app.post(['/api/users/add-balance', '/api/admin/update-balance']")
end=s.index("// ================= USER PROFILE / ADMIN USER EDIT APIs ================= //", start)
newroute="""app.post(['/api/users/add-balance', '/api/admin/update-balance'], requireAdmin, (req, res) => {
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
                db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,processed_by,created_at) VALUES(?, 'Adjustment','Admin',?,'Completed',?,CURRENT_TIMESTAMP)`,[username,Math.abs(amt),req.authUser.username]);
                const direction = amt > 0 ? 'OUT' : 'IN';
                db.run(`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by,balance_after) VALUES('Balance Adjustment',?,?,?,?,?,?,?,?)`,[username,Math.abs(amt),direction,'User',String(user.id),reason,req.authUser.username,next],(le)=>{
                    if(le){db.run('ROLLBACK');return res.status(500).json({success:false,error:le.message});}
                    db.run('COMMIT',ce=>res.json({success:!ce,message:ce?'Adjustment failed':'Balance adjusted',balance:next}));
                });
            });
        });
    });
});

"""
s=s[:start]+newroute+s[end:]
# Add ledger after create marker. replace response line
old="res.json({ success: true, message: 'User account created successfully', userId: this.lastID });"
new="""const userId = this.lastID;
        if (initialBal > 0) addAdminLedger({entry_type:'Marker Opening Balance',username,amount:initialBal,direction:'OUT',reference_type:'User',reference_id:userId,reason:'Initial marker balance',processed_by:req.authUser.username});
        res.json({ success: true, message: 'User account created successfully', userId });"""
s=s.replace(old,new,1)
# Add ledger after bet transaction insertion, before commit. Locate exact block
old="""                                    db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, ?, 'Wallet', ?, 'Completed', CURRENT_TIMESTAMP)`,
                                        [username, is_parlay ? 'Parlay Bet' : 'Bet Placed', totalDeduction], (txErr) => {
                                        if (txErr) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ success: false, message: 'Transaction record မသိမ်းနိုင်ပါ။' });
                                        }
                                        db.run('COMMIT', (commitErr) => {"""
new="""                                    db.run(`INSERT INTO transactions (username, type, payment_method, amount, status, created_at) VALUES (?, ?, 'Wallet', ?, 'Completed', CURRENT_TIMESTAMP)`,
                                        [username, is_parlay ? 'Parlay Bet' : 'Bet Placed', totalDeduction], function(txErr) {
                                        if (txErr) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ success: false, message: 'Transaction record မသိမ်းနိုင်ပါ။' });
                                        }
                                        addAdminLedger({entry_type:'Bet Stake',username,amount:totalDeduction,direction:'IN',reference_type:'Ticket',reference_id:ticketNo,reason:is_parlay?'Parlay stake':'Bet stake',processed_by:'System'}, (le)=>{
                                            if(le){ db.run('ROLLBACK'); return res.status(500).json({success:false,message:'Ledger record မသိမ်းနိုင်ပါ။'}); }
                                        db.run('COMMIT', (commitErr) => {"""
s=s.replace(old,new,1)
# Close added callback: after response line, need extra }); before existing closures. exact snippet
s=s.replace("""                                            res.json({ success: true, message: 'Successfully placed bet(s)' });
                                        });
                                    }
""","""                                            res.json({ success: true, message: 'Successfully placed bet(s)' });
                                        });
                                        });
                                    }
""",1)
# Settlement payout ledger inside for loop after transaction insert; replace one-line sequence
old="""if(Number(y.outcome.returnAmount)>0){db.run(`UPDATE users SET balance=balance+? WHERE username=?`,[y.outcome.returnAmount,y.username]);db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,created_at) VALUES(?, 'Payout','Wallet',?,'Completed',CURRENT_TIMESTAMP)`,[y.username,y.outcome.returnAmount]);}"""
new="""if(Number(y.outcome.returnAmount)>0){db.run(`UPDATE users SET balance=balance+? WHERE username=?`,[y.outcome.returnAmount,y.username]);db.run(`INSERT INTO transactions(username,type,payment_method,amount,status,created_at) VALUES(?, 'Payout','Wallet',?,'Completed',CURRENT_TIMESTAMP)`,[y.username,y.outcome.returnAmount]);addAdminLedger({entry_type:'Payout',username:y.username,amount:y.outcome.returnAmount,direction:'OUT',reference_type:'Bet',reference_id:y.id,reason:`Settlement payout for ${m.custom_match_id||m.id}`,processed_by:req.authUser.username});}"""
s=s.replace(old,new,1)
# Ledger API compute running balance and date; replace route
old="app.get('/api/admin/ledger',requireAdmin,(req,res)=>db.all(`SELECT * FROM admin_ledger ORDER BY id DESC LIMIT 500`,[],(e,r)=>res.json({success:!e,data:r||[]})));"
new="""app.get('/api/admin/ledger',requireAdmin,(req,res)=>db.all(`SELECT * FROM admin_ledger ORDER BY id ASC LIMIT 2000`,[],(e,r)=>{
    if(e)return res.status(500).json({success:false,error:e.message,data:[]});
    let running=0; const rows=(r||[]).map(x=>{running += x.direction==='IN'?Number(x.amount||0):-Number(x.amount||0); return {...x,running_balance:running};}).reverse();
    res.json({success:true,data:rows,summary:{balance:running,total_in:(r||[]).filter(x=>x.direction==='IN').reduce((a,x)=>a+Number(x.amount||0),0),total_out:(r||[]).filter(x=>x.direction==='OUT').reduce((a,x)=>a+Number(x.amount||0),0)}});
}));"""
s=s.replace(old,new,1)
# Remove MMK in server-generated risk copy text
s=s.replace(".toLocaleString()} MMK`", ".toLocaleString()}`")
p.write_text(s)
