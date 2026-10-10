from pathlib import Path
import re

root=Path('/mnt/data/risk_work')
server=root/'server.js'
admin=root/'public/admin.html'

s=server.read_text(encoding='utf-8')
a=admin.read_text(encoding='utf-8')

# 1) Add risk_layouts table after risk_forwards table if absent.
needle="""    db.run(`CREATE TABLE IF NOT EXISTS odds_history ("""
insert="""    db.run(`CREATE TABLE IF NOT EXISTS risk_layouts (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        match_db_id INTEGER NOT NULL,\n        match_id TEXT NOT NULL,\n        home_layout REAL DEFAULT 0,\n        away_layout REAL DEFAULT 0,\n        over_layout REAL DEFAULT 0,\n        under_layout REAL DEFAULT 0,\n        total_layout REAL DEFAULT 0,\n        status TEXT DEFAULT 'Confirmed',\n        confirmed_by TEXT,\n        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n        confirmed_at DATETIME\n    )`);\n\n"""+needle
if 'CREATE TABLE IF NOT EXISTS risk_layouts' not in s:
    s=s.replace(needle, insert, 1)

# 2) Replace old risk-summary and add detailed risk endpoint + confirm layout endpoint.
start=s.index("app.get('/api/admin/risk-summary'")
end=s.index("// ================= RISK MANAGEMENT API ================= //", start)
new_routes=r'''app.get('/api/admin/risk-summary', requireAdmin, (req, res) => {
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
    db.get(`SELECT * FROM matches WHERE id=? OR custom_match_id=?`, [key,key], (matchErr, match) => {
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
    db.get(`SELECT * FROM matches WHERE id=? OR custom_match_id=?`,[key,key],(me,match)=>{
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
                    db.run(`INSERT INTO admin_ledger(entry_type,username,amount,direction,reference_type,reference_id,reason,processed_by) VALUES(?,?,?,?,?,?,?,?)`,['Risk Layout',null,totalL,'OUT','Risk Layout',String(layoutId),`Layout confirmed for Match ${match.custom_match_id||match.id}`,req.authUser.username],function(ledgerErr){
                        if(ledgerErr){db.run('ROLLBACK');return res.status(500).json({success:false,error:ledgerErr.message});}
                        db.run('COMMIT',commitErr=>{if(commitErr)return res.status(500).json({success:false,error:commitErr.message});res.json({success:true,layout_id:layoutId,amount:totalL,message:'Layout confirmed and added to Admin Ledger.'});});
                    });
                });
            });
        });
    });
});

'''
s=s[:start]+new_routes+s[end:]

# 3) Replace Risk page HTML block.
rs=a.index('<!-- PAGE 6: RISK MANAGEMENT -->')
re=a.index('<!-- PAGE: ADMIN LEDGER -->', rs)
risk_html=r'''<!-- PAGE 6: RISK MANAGEMENT -->
            <div id="page-risk" class="space-y-6 hidden">
                <div class="bg-white rounded-xl shadow-sm p-5 border">
                    <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
                        <div>
                            <h3 class="font-bold text-lg text-rose-600">Risk Management</h3>
                            <p class="text-sm text-gray-500 mt-1">ပွဲစဉ်ရွေးပြီး Marker အလိုက် risk / layout ကို popup ထဲမှာ ကြည့်ပါ။</p>
                        </div>
                        <button onclick="loadRiskData()" class="bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-semibold">Refresh</button>
                    </div>
                    <div class="mt-5 max-w-2xl">
                        <label class="block text-sm font-semibold text-slate-600 mb-1.5">Select Match</label>
                        <select id="risk-match-select" onchange="openRiskPopup(this.value)" class="w-full h-11 px-3 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-100">
                            <option value="">Choose a match...</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- RISK DETAIL POPUP -->
            <div id="risk-detail-modal" class="fixed inset-0 bg-slate-950/70 backdrop-blur-[2px] hidden z-[80] p-3 md:p-6 items-center justify-center">
                <div class="bg-white w-full max-w-7xl max-h-[94vh] rounded-2xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col">
                    <div class="px-5 py-4 border-b bg-slate-50 flex items-center justify-between gap-4">
                        <div>
                            <div class="text-[11px] font-bold uppercase tracking-wider text-rose-500">Risk Management</div>
                            <h3 id="risk-modal-title" class="text-lg md:text-xl font-extrabold text-slate-900 mt-0.5">Match</h3>
                            <div id="risk-modal-meta" class="text-xs text-slate-500 mt-1">—</div>
                        </div>
                        <button onclick="closeRiskPopup()" class="w-9 h-9 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-900 text-lg font-bold">×</button>
                    </div>
                    <div class="p-4 md:p-5 overflow-auto">
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                            <div class="rounded-xl border bg-white p-4"><div class="text-[11px] font-bold uppercase text-slate-400">Total Pool</div><div id="risk-sum-pool" class="text-xl font-extrabold mt-1 text-slate-900">0</div></div>
                            <div class="rounded-xl border bg-white p-4"><div class="text-[11px] font-bold uppercase text-slate-400">Worst Net</div><div id="risk-sum-worst" class="text-xl font-extrabold mt-1 text-rose-600">0</div></div>
                            <div class="rounded-xl border bg-white p-4"><div class="text-[11px] font-bold uppercase text-slate-400">Risk Level</div><div id="risk-sum-level" class="text-xl font-extrabold mt-1">NORMAL</div></div>
                            <div class="rounded-xl border bg-white p-4"><div class="text-[11px] font-bold uppercase text-slate-400">Layout</div><div id="risk-sum-layout" class="text-xl font-extrabold mt-1 text-rose-600">0</div></div>
                        </div>

                        <div class="overflow-x-auto border rounded-xl">
                            <table class="w-full border-collapse text-sm min-w-[930px]">
                                <thead>
                                    <tr class="bg-slate-50 text-slate-600">
                                        <th class="border-b p-3 text-left">Marker</th>
                                        <th class="border-b p-3 text-center">Match ID</th>
                                        <th class="border-b p-3 text-right">Home Bet</th>
                                        <th class="border-b p-3 text-right">Away Bet</th>
                                        <th class="border-b p-3 text-right">G(O)</th>
                                        <th class="border-b p-3 text-right">G(Un)</th>
                                        <th class="border-b p-3 text-right">Total Pool Amt</th>
                                        <th class="border-b p-3 text-center">Visual Alert</th>
                                    </tr>
                                </thead>
                                <tbody id="risk-detail-list"></tbody>
                                <tfoot>
                                    <tr class="bg-slate-100 font-extrabold text-slate-900">
                                        <td class="p-3" colspan="2">TOTAL</td>
                                        <td id="risk-total-home" class="p-3 text-right">0</td>
                                        <td id="risk-total-away" class="p-3 text-right">0</td>
                                        <td id="risk-total-over" class="p-3 text-right">0</td>
                                        <td id="risk-total-under" class="p-3 text-right">0</td>
                                        <td id="risk-total-pool" class="p-3 text-right">0</td>
                                        <td></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>

                        <div class="mt-5 rounded-xl border border-rose-100 bg-rose-50/60 p-4">
                            <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                <div><div class="text-[11px] font-bold uppercase tracking-wider text-rose-500">Layout</div><div class="text-sm text-slate-600 mt-1">အကုန်ချေပြီးနောက် ကျန်တဲ့ net amount ကို ပြထားပါတယ်။</div></div>
                                <div id="risk-layout-total" class="text-2xl font-extrabold text-rose-700">0</div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                                <div class="bg-white border rounded-lg p-3 flex items-center justify-between gap-3"><div><div class="text-xs text-slate-500">Home Layout</div><div id="risk-layout-home" class="font-bold text-slate-900 mt-1">0</div></div><button onclick="copyRiskLayout('home')" class="px-3 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold">Copy</button></div>
                                <div class="bg-white border rounded-lg p-3 flex items-center justify-between gap-3"><div><div class="text-xs text-slate-500">Away Layout</div><div id="risk-layout-away" class="font-bold text-slate-900 mt-1">0</div></div><button onclick="copyRiskLayout('away')" class="px-3 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold">Copy</button></div>
                                <div class="bg-white border rounded-lg p-3 flex items-center justify-between gap-3"><div><div class="text-xs text-slate-500">Goal Over Layout</div><div id="risk-layout-over" class="font-bold text-slate-900 mt-1">0</div></div><button onclick="copyRiskLayout('over')" class="px-3 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold">Copy</button></div>
                                <div class="bg-white border rounded-lg p-3 flex items-center justify-between gap-3"><div><div class="text-xs text-slate-500">Goal Under Layout</div><div id="risk-layout-under" class="font-bold text-slate-900 mt-1">0</div></div><button onclick="copyRiskLayout('under')" class="px-3 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold">Copy</button></div>
                            </div>
                            <div class="flex flex-wrap justify-end gap-2 mt-4">
                                <button onclick="copyAllRiskLayouts()" class="px-4 py-2.5 bg-slate-700 text-white rounded-lg text-sm font-bold">Copy Layout All</button>
                                <button onclick="confirmRiskLayoutToLedger()" class="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-bold">Confirm Layout</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

'''
a=a[:rs]+risk_html+a[re:]

# 4) Add risk modal CSS/JS helpers by replacing current risk JS section.
js_start=a.index("        // ================= RISK ================= //")
js_end=a.index("        // ================= WEBSITE NOTICE MANAGEMENT", js_start)
new_js=r'''        // ================= RISK ================= //
        let activeRiskMatchId = null;
        let activeRiskPayload = null;

        function loadRiskData() {
            fetch('/api/admin/risk-summary')
                .then(async res => { const t=await res.text(); return t ? JSON.parse(t) : {data:[]}; })
                .then(result => {
                    const matches=result.data||[];
                    const select=document.getElementById('risk-match-select');
                    if(!select)return;
                    const current=select.value;
                    select.innerHTML='<option value="">Choose a match...</option>';
                    matches.forEach(m=>{
                        const opt=document.createElement('option');
                        opt.value=String(m.id);
                        opt.textContent=`${m.custom_match_id||m.id} — ${m.match_name||'-'}`;
                        select.appendChild(opt);
                    });
                    if(current && matches.some(m=>String(m.id)===current)) select.value=current;
                })
                .catch(err=>console.error('Risk load error:',err));
        }

        async function openRiskPopup(matchId){
            if(!matchId)return;
            try{
                const res=await fetch(`/api/admin/risk/match/${encodeURIComponent(matchId)}`);
                const d=await res.json();
                if(!res.ok||!d.success)throw new Error(d.message||d.error||'Risk load failed');
                activeRiskMatchId=d.match.id;
                activeRiskPayload=d;
                const fmt=n=>Number(n||0).toLocaleString();
                document.getElementById('risk-modal-title').textContent=`${d.match.custom_match_id||d.match.id} — ${d.match.match_name||'-'}`;
                document.getElementById('risk-modal-meta').textContent=`Kickoff: ${formatMyanmarTime(d.match.match_time)} • ကြေးပေးအသင်း: ${d.match.favored_team} • Status: ${d.match.status}`;
                document.getElementById('risk-sum-pool').textContent=fmt(d.total.total_pool);
                const worst=Math.max(Number(d.total.home_layout||0),Number(d.total.away_layout||0),Number(d.total.over_layout||0),Number(d.total.under_layout||0));
                document.getElementById('risk-sum-worst').textContent=fmt(worst);
                const level=worst>0 ? (worst>=200000?'CRITICAL':worst>=100000?'HIGH':worst>=50000?'MEDIUM':'NORMAL') : 'NORMAL';
                const levelEl=document.getElementById('risk-sum-level'); levelEl.textContent=level; levelEl.className='text-xl font-extrabold mt-1 '+(level==='CRITICAL'||level==='HIGH'?'text-rose-600':level==='MEDIUM'?'text-amber-600':'text-emerald-600');
                document.getElementById('risk-sum-layout').textContent=fmt(d.total.total_layout);
                const tbody=document.getElementById('risk-detail-list'); tbody.innerHTML='';
                (d.data||[]).forEach(r=>{
                    const cls=r.visual_alert==='CRITICAL'?'text-rose-700 bg-rose-50 border-rose-200':r.visual_alert==='HIGH'?'text-amber-700 bg-amber-50 border-amber-200':'text-emerald-700 bg-emerald-50 border-emerald-200';
                    tbody.innerHTML+=`<tr><td class="border-b p-3 font-semibold text-slate-800">${escapeHtml(r.marker||'-')}</td><td class="border-b p-3 text-center">${escapeHtml(r.match_id)}</td><td class="border-b p-3 text-right">${fmt(r.home_bet)}</td><td class="border-b p-3 text-right">${fmt(r.away_bet)}</td><td class="border-b p-3 text-right">${fmt(r.goal_over)}</td><td class="border-b p-3 text-right">${fmt(r.goal_under)}</td><td class="border-b p-3 text-right font-bold">${fmt(r.total_pool)}</td><td class="border-b p-3 text-center"><span class="inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-extrabold ${cls}">${r.visual_alert}</span></td></tr>`;
                });
                if(!(d.data||[]).length)tbody.innerHTML='<tr><td colspan="8" class="p-6 text-center text-slate-500">No pending bets for this match.</td></tr>';
                document.getElementById('risk-total-home').textContent=fmt(d.total.home_bet);
                document.getElementById('risk-total-away').textContent=fmt(d.total.away_bet);
                document.getElementById('risk-total-over').textContent=fmt(d.total.goal_over);
                document.getElementById('risk-total-under').textContent=fmt(d.total.goal_under);
                document.getElementById('risk-total-pool').textContent=fmt(d.total.total_pool);
                document.getElementById('risk-layout-total').textContent=fmt(d.total.total_layout);
                document.getElementById('risk-layout-home').textContent=`${d.layout_copy.home.label}, ${fmt(d.layout_copy.home.amount)}`;
                document.getElementById('risk-layout-away').textContent=`${d.layout_copy.away.label}, ${fmt(d.layout_copy.away.amount)}`;
                document.getElementById('risk-layout-over').textContent=`${d.layout_copy.over.label}, ${fmt(d.layout_copy.over.amount)}`;
                document.getElementById('risk-layout-under').textContent=`${d.layout_copy.under.label}, ${fmt(d.layout_copy.under.amount)}`;
                document.getElementById('risk-detail-modal').classList.remove('hidden');
                document.getElementById('risk-detail-modal').classList.add('flex');
            }catch(e){alert(e.message);}
        }

        function closeRiskPopup(){const el=document.getElementById('risk-detail-modal');el.classList.add('hidden');el.classList.remove('flex');}

        function riskCopyText(kind){
            if(!activeRiskPayload)return '';
            const x=activeRiskPayload.layout_copy[kind];
            return `${x.label}, ${Number(x.amount||0).toLocaleString()}`;
        }
        async function writeClipboard(text){
            try{await navigator.clipboard.writeText(text);alert('Layout ကို Copy ကူးပြီးပါပြီ။');}
            catch(_){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();alert('Layout ကို Copy ကူးပြီးပါပြီ။');}
        }
        function copyRiskLayout(kind){const t=riskCopyText(kind);if(t)writeClipboard(t);}
        function copyAllRiskLayouts(){if(!activeRiskPayload)return;const d=activeRiskPayload;const lines=[];[['home','Home'],['away','Away'],['over','G(O)'],['under','G(Un)']].forEach(([k,label])=>{const x=d.layout_copy[k];if(Number(x.amount||0)>0)lines.push(`${x.label}, ${Number(x.amount||0).toLocaleString()}`);});writeClipboard(lines.join('\n'));}

        async function confirmRiskLayoutToLedger(){
            if(!activeRiskPayload)return;
            const amount=Number(activeRiskPayload.total?.total_layout||0);
            if(amount<=0)return alert('Layout amount မရှိသေးပါ။');
            const ok=confirm(`Confirm Layout?\n\nMatch: ${activeRiskPayload.match.custom_match_id||activeRiskPayload.match.id} — ${activeRiskPayload.match.match_name}\nLayout: ${amount.toLocaleString()}\n\nConfirm လုပ်ပြီးရင် Admin Ledger မှာ OUT entry ဝင်ပါမယ်။`);
            if(!ok)return;
            const res=await fetch('/api/admin/risk/layout-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id:activeRiskPayload.match.id})});
            const d=await res.json();
            if(!res.ok||!d.success)return alert(d.message||d.error||'Layout confirmation failed');
            alert(`Layout confirmed. Ledger reference #${d.layout_id}`);
        }

'''
a=a[:js_start]+new_js+a[js_end:]

# 5) Fix the final init default to users already okay; risk loader is page-driven.
# 6) Add mobile modal CSS selector for risk detail.
a=a.replace("#editUserModal > div, #result-modal > div, #edit-odds-modal > div, #forward-modal > div { max-height: 92vh; overflow-y: auto; }",
            "#editUserModal > div, #result-modal > div, #edit-odds-modal > div, #forward-modal > div, #risk-detail-modal > div { max-height: 94vh; overflow-y: auto; }")

server.write_text(s,encoding='utf-8')
admin.write_text(a,encoding='utf-8')
print('patched')
