from pathlib import Path
p=Path('/mnt/data/phase_marker/public/admin.html')
s=p.read_text()
# Dashboard block
start=s.index('            <!-- PAGE 0: DASHBOARD -->')
end=s.index('            <!-- PAGE 1: USERS -->', start)
dashboard='''            <!-- PAGE 0: DASHBOARD -->
            <div id="page-dashboard" class="space-y-6 hidden">
                <div class="dashboard-hero rounded-2xl p-6 md:p-7 text-white shadow-lg">
                    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div>
                            <div class="text-[11px] uppercase tracking-[.18em] text-blue-100/80 font-bold">Overview</div>
                            <h3 class="text-2xl md:text-3xl font-extrabold mt-1">Good evening, Administrator</h3>
                            <p id="dashboard-date" class="text-sm text-blue-100/80 mt-2">Asia/Yangon</p>
                        </div>
                        <button onclick="loadDashboard()" class="dashboard-refresh px-4 py-2.5 rounded-xl text-sm font-bold">Refresh</button>
                    </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div class="dashboard-kpi"><div class="kpi-label">Total Stake</div><div id="dash-stake" class="kpi-value">0</div><div class="kpi-note">Today</div></div>
                    <div class="dashboard-kpi"><div class="kpi-label">Total Payout</div><div id="dash-payout" class="kpi-value">0</div><div class="kpi-note">Today</div></div>
                    <div class="dashboard-kpi"><div class="kpi-label">Net P/L</div><div id="dash-pl" class="kpi-value">0</div><div class="kpi-note">Stake − Payout</div></div>
                    <div class="dashboard-kpi"><div class="kpi-label">Open Matches</div><div id="dash-open" class="kpi-value">0</div><div class="kpi-note">Currently open</div></div>
                </div>
            </div>

'''
s=s[:start]+dashboard+s[end:]
# Add dashboard styles
style_anchor='        :root { --stt-navy:#0f172a;'
styles='''        .dashboard-hero{background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 58%,#2563eb 100%);position:relative;overflow:hidden}.dashboard-hero:after{content:"";position:absolute;width:260px;height:260px;border-radius:50%;right:-90px;top:-130px;background:rgba(255,255,255,.10);filter:blur(2px)}.dashboard-refresh{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);backdrop-filter:blur(10px)}.dashboard-refresh:hover{background:rgba(255,255,255,.18)}.dashboard-kpi{background:#fff;border:1px solid #e7ebf0;border-radius:16px;padding:20px;box-shadow:0 8px 24px rgba(15,23,42,.05);min-height:132px;position:relative;overflow:hidden}.dashboard-kpi:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,#2563eb,#60a5fa)}.kpi-label{font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em}.kpi-value{font-size:28px;font-weight:900;letter-spacing:-.03em;color:#0f172a;margin-top:10px}.kpi-note{font-size:11px;color:#94a3b8;margin-top:5px}
'''
s=s.replace(style_anchor,styles+style_anchor,1)
# Marker balance edit field to view-only
s=s.replace('''                <div>\n                    <label class="block text-sm font-semibold mb-1">Balance</label>\n                    <input id="edit-balance" type="number" min="0" step="1" class="w-full p-2.5 border rounded focus:outline-blue-500">\n                </div>''','''                <div>\n                    <label class="block text-sm font-semibold mb-1">Current Balance</label>\n                    <input id="edit-balance" type="text" readonly class="w-full p-2.5 border rounded bg-slate-50 text-slate-500">\n                    <p class="text-[11px] text-slate-400 mt-1">Balance changes must use the Balance action so the Ledger stays complete.</p>\n                </div>''',1)
# Replace amount prompt with reason-aware call
old='''        function addBalance(userId, username) {\n            const amount = prompt(`ထည့်မည့်ပမာဏ (MMK) - ${username}:`);\n            if (!amount || isNaN(amount) || Number(amount) <= 0) return;\n            fetch('/api/users/add-balance', {\n                method: 'POST',\n                headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify({ username, amount: parseFloat(amount) })\n            }).then(async res => {\n                const result = await res.json().catch(() => ({}));\n                if (!res.ok || !result.success) alert(result.message || 'Balance update failed');\n                loadUsers();\n            });\n        }'''
new='''        async function addBalance(userId, username) {\n            const amount = prompt(`Balance adjustment for ${username}\\n\\nUse positive to add, negative to deduct:`);\n            if (amount === null || amount.trim()==='' || isNaN(amount) || Number(amount) === 0) return;\n            const reason = prompt('Reason is required for Ledger audit:');\n            if (reason === null || !reason.trim()) return alert('Reason is required.');\n            const res = await fetch('/api/users/add-balance', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,amount:Number(amount),reason:reason.trim()})});\n            const result = await res.json().catch(()=>({}));\n            if (!res.ok || !result.success) return alert(result.message || 'Balance update failed');\n            alert(`Balance updated\\nNew balance: ${Number(result.balance||0).toLocaleString()}`);\n            loadUsers(); loadLedger();\n        }'''
s=s.replace(old,new,1)
# Save edited user omit balance
s=s.replace("    const balance = document.getElementById('edit-balance').value;\n", "",1)
s=s.replace("    if (balance === '' || Number(balance) < 0 || Number.isNaN(Number(balance))) return alert('Balance မမှန်ကန်ပါ။');\n", "",1)
s=s.replace("body: JSON.stringify({ username, balance: Number(balance), password })", "body: JSON.stringify({ username, password })",1)
# load dashboard formatter no MMK
old="async function loadDashboard(){ const r=await fetch('/api/admin/dashboard'),d=await r.json(); if(!d.success)return; const f=n=>Number(n||0).toLocaleString()+' MMK'; document.getElementById('dash-stake').textContent=f(d.total_stake); document.getElementById('dash-payout').textContent=f(d.total_payout); document.getElementById('dash-pl').textContent=f(d.net_pl); document.getElementById('dash-open').textContent=Number(d.open_matches||0).toLocaleString(); document.getElementById('dashboard-date').textContent=`${d.date} • ${d.timezone}`; }"
new="async function loadDashboard(){ const r=await fetch('/api/admin/dashboard'),d=await r.json(); if(!d.success)return; const f=n=>Number(n||0).toLocaleString(); document.getElementById('dash-stake').textContent=f(d.total_stake); document.getElementById('dash-payout').textContent=f(d.total_payout); document.getElementById('dash-pl').textContent=f(d.net_pl); document.getElementById('dash-open').textContent=Number(d.open_matches||0).toLocaleString(); document.getElementById('dashboard-date').textContent=`${d.date} • ${d.timezone}`; }"
s=s.replace(old,new,1)
# Ledger page replace with connected summary + running balance
ls=s.index('            <!-- PAGE: ADMIN LEDGER -->')
le=s.index('            <!-- PAGE 7: WEBSITE NOTICE',ls)
ledger='''            <!-- PAGE: ADMIN LEDGER -->
            <div id="page-ledger" class="space-y-6 hidden">
              <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3"><div><h3 class="font-bold text-lg text-emerald-600">Admin Ledger</h3><p class="text-sm text-gray-500">All connected cash movements from markers, bets, transactions and payouts</p></div><button onclick="loadLedger()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded text-sm font-semibold">Refresh</button></div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4"><div class="bg-white border rounded-xl p-4 shadow-sm"><div class="text-xs uppercase font-bold text-slate-400">Running Balance</div><div id="ledger-balance" class="text-2xl font-extrabold mt-2">0</div></div><div class="bg-white border rounded-xl p-4 shadow-sm"><div class="text-xs uppercase font-bold text-slate-400">Total In</div><div id="ledger-in" class="text-2xl font-extrabold mt-2 text-emerald-600">0</div></div><div class="bg-white border rounded-xl p-4 shadow-sm"><div class="text-xs uppercase font-bold text-slate-400">Total Out</div><div id="ledger-out" class="text-2xl font-extrabold mt-2 text-rose-600">0</div></div></div>
              <div class="bg-white rounded-xl shadow-sm p-5 border"><div class="overflow-x-auto"><table class="w-full border-collapse border border-gray-200 text-sm"><thead><tr class="bg-gray-100"><th class="border p-2">No.</th><th class="border p-2">Type</th><th class="border p-2">Marker</th><th class="border p-2">Amount</th><th class="border p-2">Direction</th><th class="border p-2">Running Balance</th><th class="border p-2">Reference</th><th class="border p-2">Reason</th><th class="border p-2">Processed By</th><th class="border p-2">Time</th></tr></thead><tbody id="ledger-list"></tbody></table></div></div>
            </div>

'''
s=s[:ls]+ledger+s[le:]
# loadLedger replacement
old_start=s.index('        async function loadLedger()')
old_end=s.index('\n', old_start)
# one-line function only
line=s[old_start:old_end]
newline="        async function loadLedger(){ const r=await fetch('/api/admin/ledger'),d=await r.json(); if(!d.success)return; document.getElementById('ledger-balance').textContent=Number(d.summary?.balance||0).toLocaleString(); document.getElementById('ledger-in').textContent=Number(d.summary?.total_in||0).toLocaleString(); document.getElementById('ledger-out').textContent=Number(d.summary?.total_out||0).toLocaleString(); const tbody=document.getElementById('ledger-list'); tbody.innerHTML=''; (d.data||[]).forEach((x,i)=>tbody.innerHTML+=`<tr><td class=\"border p-2 text-center\">${i+1}</td><td class=\"border p-2\">${x.entry_type||'-'}</td><td class=\"border p-2\">${x.username||'-'}</td><td class=\"border p-2 text-right font-bold\">${Number(x.amount||0).toLocaleString()}</td><td class=\"border p-2 text-center font-bold ${x.direction==='IN'?'text-emerald-600':'text-rose-600'}\">${x.direction||'-'}</td><td class=\"border p-2 text-right font-semibold\">${Number(x.running_balance||0).toLocaleString()}</td><td class=\"border p-2 text-center\">${x.reference_type||'-'} #${x.reference_id||'-'}</td><td class=\"border p-2\">${x.reason||'-'}</td><td class=\"border p-2\">${x.processed_by||'-'}</td><td class=\"border p-2 text-xs\">${formatMyanmarTime(x.created_at)}</td></tr>`); if(!(d.data||[]).length)tbody.innerHTML='<tr><td colspan=\"10\" class=\"border p-4 text-center\">No ledger entries</td></tr>'; }"
s=s[:old_start]+newline+s[old_end:]
# remove MMK labels in admin all amount displays
s=s.replace(' MMK','').replace('(MMK)','').replace(' (MMK)','')
# login default page Marker
s=s.replace("hideAdminLogin(); switchPage('dashboard');", "hideAdminLogin(); switchPage('users');",1)
p.write_text(s)
# bettor remove MMK labels from visible UI strings and formatters
q=Path('/mnt/data/phase_marker/public/index.html'); t=q.read_text(); t=t.replace(' MMK','').replace('(MMK)','').replace(' (MMK)',''); q.write_text(t)
