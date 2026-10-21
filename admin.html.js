

        const _adminNativeFetch = window.fetch.bind(window);
        window.fetch = function(input, init = {}) {
            const token = localStorage.getItem('adminAuthToken');
            const url = typeof input === 'string' ? input : input.url;
            if (token && String(url).startsWith('/api/')) {
                init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
            }
            return _adminNativeFetch(input, init).then(res => {
                if ((res.status === 401 || res.status === 403) && token && !String(url).includes('/api/login')) {
                    localStorage.removeItem('adminAuthToken');
                    showAdminLogin();
                }
                return res;
            });
        };

        function showAdminLogin() { document.getElementById('adminLoginGate').classList.remove('hidden'); }
        function hideAdminLogin() { document.getElementById('adminLoginGate').classList.add('hidden'); }
        async function adminLogin(e) {
            e.preventDefault();
            const err = document.getElementById('adminLoginError'); err.textContent = '';
            try {
                const res = await _adminNativeFetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username:document.getElementById('adminUsername').value.trim(), password:document.getElementById('adminPassword').value }) });
                const data = await res.json();
                if (!res.ok || !data.success || data.user.role !== 'admin') { err.textContent = data.message || 'Admin login failed'; return; }
                localStorage.setItem('adminAuthToken', data.token);
                hideAdminLogin();
                loadUsers();
            } catch (_) { err.textContent = 'Server connection error'; }
        }
        let currentActiveMatchId = null;
        let forwardMatchData = {};
        let allMatches = [];
        let riskMatchesData = [];

        const MYANMAR_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;
        const BET_LOCK_MINUTES = 15;

        function parseMyanmarTime(timeStr) {
            if (!timeStr) return 0;
            let raw = String(timeStr).trim().replace(' ', 'T');
            if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
                const t = new Date(raw).getTime();
                return Number.isNaN(t) ? 0 : t;
            }
            const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
            if (!m) return new Date(raw).getTime() || 0;
            const [, y, mo, d, h, mi, sec='00'] = m;
            return Date.UTC(+y, +mo-1, +d, +h, +mi, +sec) - MYANMAR_OFFSET_MS;
        }

        function formatMyanmarTime(timeStr) {
            const ms = parseMyanmarTime(timeStr);
            if (!ms) return timeStr || '-';
            return new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Yangon', month: 'short', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            }).format(new Date(ms));
        }

        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            sidebar.classList.toggle('hidden');
            sidebar.classList.toggle('absolute');
            sidebar.classList.toggle('z-40');
            sidebar.classList.toggle('h-full');
        }

        function switchPage(page) {
            ['dashboard', 'users', 'matches', 'results', 'transactions', 'bets', 'risk', 'ledger', 'notice'].forEach(p => {
                const pageEl = document.getElementById(`page-${p}`);
                const navEl = document.getElementById(`nav-${p}`);
                if (pageEl) pageEl.classList.add('hidden');
                if (navEl) {
                    if (p === 'risk') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-rose-400";
                    else if (p === 'transactions') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-yellow-400";
                    else if (p === 'notice') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-cyan-400";
                    else navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-slate-300";
                }
            });

            const activePage = document.getElementById(`page-${page}`);
            const activeNav = document.getElementById(`nav-${page}`);
            
            if (activePage) activePage.classList.remove('hidden');
            if (activeNav) {
                if (page === 'risk') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-rose-600 text-white font-semibold";
                else if (page === 'transactions') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-yellow-600 text-white font-semibold";
                else if (page === 'notice') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-cyan-600 text-white font-semibold";
                else activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-blue-600 text-white font-semibold";
            }
            
            const titles = { 
                dashboard: 'Dashboard',
                users: 'Marker', 
                matches: 'Match Management', 
                results: 'Match Results', 
                transactions: 'Deposit & Withdraw Transactions',
                bets: 'Betting Records', 
                risk: 'Risk Management & Bet Summary',
                ledger: 'Admin Ledger',
                notice: 'Website Notice Management'
            };
            document.getElementById('page-title').innerText = titles[page] || 'Admin Dashboard';

            if(page === 'dashboard') loadDashboard();
            else if(page === 'users') loadUsers();
            else if(page === 'matches') { loadMatches(); loadGlobalLock(); }
            else if(page === 'results') loadResults();
            else if(page === 'transactions') loadTransactions();
            else if(page === 'bets') loadBets();
            else if(page === 'risk') loadRiskData();
            else if(page === 'ledger') loadLedger();
            else if(page === 'notice') loadCurrentNotice();

            if (window.innerWidth < 768) {
                const sidebar = document.getElementById('sidebar');
                sidebar.classList.add('hidden');
            }
        }

        async function changeAdminPassword() {
            const current_password = prompt('Current admin password:'); if (current_password === null) return;
            const new_password = prompt('New admin password (8+ chars):'); if (new_password === null) return;
            const confirm_password = prompt('Confirm new password:'); if (confirm_password === null) return;
            if (new_password !== confirm_password) return alert('Passwords do not match.');
            const res = await fetch('/api/admin/change-password', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current_password,new_password})});
            const data = await res.json().catch(()=>({}));
            if (!res.ok || !data.success) return alert(data.message || 'Password change failed');
            alert(data.message || 'Password changed.');
            localStorage.removeItem('adminAuthToken'); showAdminLogin();
        }

        async function adminLogout() { try { await fetch('/api/logout', { method:'POST' }); } catch (_) {} localStorage.removeItem('adminAuthToken'); showAdminLogin(); }
        function pad(n) { return n < 10 ? '0' + n : n; }
        
        function handleLeagueChange() {
            const leagueSelect = document.getElementById('match-league').value;
            const customBox = document.getElementById('custom-league-box');
            customBox.classList.toggle('hidden', leagueSelect !== 'OTHER');
        }

        function populateOddsDropdowns() {
            const bodySelect = document.getElementById('body-odds');
            const goalSelect = document.getElementById('goal-odds');
            if(!bodySelect || !goalSelect) return;
            
            let bodyHtml = '<option value="0=">0= (Level Ball)</option>';
            for (let i = 5; i <= 95; i += 5) bodyHtml += `<option value="0-${pad(i)}">0-${pad(i)}</option>`;
            bodyHtml += `<option value="0-100">0-100</option>`;
            for (let goal = 1; goal <= 6; goal++) {
                bodyHtml += `<option value="${goal}=">${goal}=</option>`;
                for (let i = 5; i <= 95; i += 5) { 
                    bodyHtml += `<option value="${goal}+${pad(i)}">${goal}+${pad(i)}</option><option value="${goal}-${pad(i)}">${goal}-${pad(i)}</option>`; 
                }
            }
            bodySelect.innerHTML = bodyHtml;

            let goalHtml = '';
            for (let goal = 2; goal <= 7; goal++) {
                goalHtml += `<option value="${goal}=">${goal}=</option>`;
                for (let i = 5; i <= 95; i += 5) { 
                    goalHtml += `<option value="${goal}+${pad(i)}">${goal}+${pad(i)}</option><option value="${goal}-${pad(i)}">${goal}-${pad(i)}</option>`; 
                }
            }
            goalSelect.innerHTML = goalHtml;
        }

        function generateEditOddsDropdowns() {
            const bodySelect = document.getElementById('edit-body-odds');
            const goalSelect = document.getElementById('edit-goal-odds');
            if(!bodySelect || !goalSelect) return;
            
            let bodyHtml = '<option value="0=">0= (Level Ball)</option>';
            for (let i = 5; i <= 95; i += 5) bodyHtml += `<option value="0-${pad(i)}">0-${pad(i)}</option>`;
            bodyHtml += `<option value="0-100">0-100</option>`;
            for (let goal = 1; goal <= 6; goal++) {
                bodyHtml += `<option value="${goal}=">${goal}=</option>`;
                for (let i = 5; i <= 95; i += 5) { 
                    bodyHtml += `<option value="${goal}+${pad(i)}">${goal}+${pad(i)}</option><option value="${goal}-${pad(i)}">${goal}-${pad(i)}</option>`; 
                }
            }
            bodySelect.innerHTML = bodyHtml;

            let goalHtml = '';
            for (let goal = 2; goal <= 7; goal++) {
                goalHtml += `<option value="${goal}=">${goal}=</option>`;
                for (let i = 5; i <= 95; i += 5) { 
                    goalHtml += `<option value="${goal}+${pad(i)}">${goal}+${pad(i)}</option><option value="${goal}-${pad(i)}">${goal}-${pad(i)}</option>`; 
                }
            }
            goalSelect.innerHTML = goalHtml;
        }

        // ================= USERS ================= //
        function createUser() {
            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value.trim();
            const balance = parseFloat(document.getElementById('new-balance').value) || 0;
            if (!username || !password) return alert('Username နှင့် Password ဖြည့်ပါ။');

            fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, balance })
            })
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : {};
            })
            .then(data => {
                alert(data.message || 'Success');
                document.getElementById('new-username').value = '';
                document.getElementById('new-password').value = '';
                document.getElementById('new-balance').value = '';
                loadUsers();
            })
            .catch(err => console.error('Error:', err));
        }

        function loadUsers() {
            fetch('/api/users')
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : { data: [] };
            })
            .then(result => {
                const users = result.data || result || [];
                const tbody = document.getElementById('user-list');
                tbody.innerHTML = '';
                if(!users.length) return tbody.innerHTML = `<tr><td colspan="5" class="border p-4 text-center">No users</td></tr>`;
                users.forEach((u, i) => {
                    tbody.innerHTML += `
                        <tr>
                            <td class="border p-2.5 text-center">${i+1}</td>
                            <td class="border p-2.5 text-center font-semibold">${u.username}</td>
                            <td class="border p-2.5 text-center text-green-600 font-bold">${(u.balance || 0).toLocaleString()}</td>
                            <td class="border p-2.5 text-center">
                                <div class="flex flex-wrap justify-center gap-1">
                                  ${['Active','Suspend','Inactive'].map(st=>`<button onclick="setUserStatus(${u.id}, '${escapeJs(u.username)}', '${st}')" class="px-2 py-1 rounded text-[11px] font-bold ${String(u.status||'Active')===st ? (st==='Active'?'bg-green-600 text-white':st==='Suspend'?'bg-amber-500 text-white':'bg-red-600 text-white') : 'bg-gray-100 text-gray-600'}">${st}</button>`).join('')}
                                </div>
                            </td>
                            <td class="border p-2.5 text-center">
                                <div class="flex flex-wrap justify-center gap-1.5">
                                    <button onclick="openEditUser(${u.id}, '${escapeJs(u.username)}', ${Number(u.balance || 0)})" class="bg-amber-500 text-white px-2.5 py-1 rounded text-xs font-semibold">Edit</button>
                                    <button onclick="resetUserPassword(${u.id}, '${escapeJs(u.username)}')" class="bg-indigo-600 text-white px-2.5 py-1 rounded text-xs font-semibold">Reset Password</button>
                                    <button onclick="addBalance(${u.id}, '${escapeJs(u.username)}')" class="bg-blue-600 text-white px-2.5 py-1 rounded text-xs font-semibold">Balance</button>
                                    <button onclick="showUserHistory(${u.id}, '${escapeJs(u.username)}')" class="bg-slate-700 text-white px-2.5 py-1 rounded text-xs font-semibold">History</button>
                                    <button onclick="deleteUser(${u.id}, '${escapeJs(u.username)}')" class="bg-red-600 text-white px-2.5 py-1 rounded text-xs font-semibold">Delete</button>
                                </div>
                            </td>
                        </tr>`;
                });
            })
            .catch(err => console.error('Error:', err));
        }

        function escapeJs(value) {
            return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
        }

        async function addBalance(userId, username) {
            const amount = prompt(`Balance adjustment for ${username}\n\nUse positive to add, negative to deduct:`);
            if (amount === null || amount.trim()==='' || isNaN(amount) || Number(amount) === 0) return;
            const reason = prompt('Reason is required for Ledger audit:');
            if (reason === null || !reason.trim()) return alert('Reason is required.');
            const res = await fetch('/api/users/add-balance', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,amount:Number(amount),reason:reason.trim()})});
            const result = await res.json().catch(()=>({}));
            if (!res.ok || !result.success) return alert(result.message || 'Balance update failed');
            alert(`Balance updated\nNew balance: ${Number(result.balance||0).toLocaleString()}`);
            loadUsers(); loadLedger();
        }

        async function setUserStatus(id, username, status) {
            if (!confirm(`${username} account ကို ${status} အဖြစ်ပြောင်းမလား?`)) return;
            const res = await fetch(`/api/users/${id}/status`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
            const data = await res.json().catch(()=>({}));
            if (!res.ok || !data.success) return alert(data.message || 'Status update failed');
            loadUsers();
        }

        async function resetUserPassword(id, username) {
            const pw=prompt(`${username} အတွက် Password အသစ်ထည့်ပါ (6+ chars):`); if(pw===null)return;
            if(pw.length<6)return alert('Password အနည်းဆုံး 6 လုံး');
            const res=await fetch(`/api/users/${id}/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
            const d=await res.json().catch(()=>({})); if(!res.ok||!d.success)return alert(d.message||'Reset failed'); alert('Password reset ပြီးပါပြီ။');
        }

        async function showUserHistory(id, username) {
            const [b,t]=await Promise.all([fetch(`/api/admin/users/${id}/bets`).then(r=>r.json()),fetch(`/api/admin/users/${id}/transactions`).then(r=>r.json())]);
            const bets=b.data||[], tx=t.data||[];
            alert(`${username} History\n\nBets: ${bets.length}\nTransactions: ${tx.length}`);
        }

        function openEditUser(id, username, balance) {
            document.getElementById('edit-user-id').value = id;
            document.getElementById('edit-username').value = username;
            document.getElementById('edit-balance').value = balance;
            document.getElementById('edit-password').value = '';
            const modal = document.getElementById('editUserModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeEditUser() {
            const modal = document.getElementById('editUserModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        async function saveEditedUser() {
            const id = document.getElementById('edit-user-id').value;
            const username = document.getElementById('edit-username').value.trim();
                    const password = document.getElementById('edit-password').value;
            if (!username) return alert('Username ဖြည့်ပါ။');
            if (password && password.length < 6) return alert('Password အသစ်သည် အနည်းဆုံး 6 လုံးရှိရပါမည်။');
        
            const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok || !result.success) return alert(result.message || 'User update failed');
            alert('User information updated successfully.');
            closeEditUser();
            loadUsers();
        }

        async function deleteUser(id, username) {
            const ok = confirm(`"${username}" ကို အပြီးဖျက်မည်။\n\nUser account, betting records နှင့် transaction records များကိုပါ ဖျက်သွားမည်ဖြစ်ပါသည်။\n\nဆက်လုပ်မလား?`);
            if (!ok) return;

            const res = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const result = await res.json().catch(() => ({}));
            if (!res.ok || !result.success) return alert(result.message || 'User delete failed');
            alert('User deleted successfully.');
            loadUsers();
        }

        // ================= MATCHES ================= //
        async function editMatchQuick(id){ const m=allMatches.find(x=>Number(x.id)===Number(id)); if(!m)return; const league=prompt('League:',m.league||''); if(league===null)return; const name=prompt('Match name (Home vs Away):',m.match_name||''); if(name===null)return; const time=prompt('Kickoff (existing format):',m.match_time||''); if(time===null)return; const r=await fetch(`/api/admin/matches/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({league,match_name:name,match_time:time,body_odds:m.body_odds,goal_odds:m.goal_odds,status:m.status,lock_minutes:Number(m.lock_minutes||15)})}); const d=await r.json(); if(!r.ok||!d.success)return alert(d.message||'Match update failed'); loadMatches(); }
        async function loadGlobalLock(){try{const r=await fetch('/api/admin/settings/lock'),d=await r.json();if(d.success)document.getElementById('global-lock-minutes').value=String(d.minutes);}catch(e){}}
        async function saveGlobalLock(minutes){try{const r=await fetch('/api/admin/settings/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:Number(minutes)})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success){alert(d.message||'Global lock update failed');return;}loadMatches();}catch(e){alert('Global lock update failed: '+e.message);}}
        async function addMatch() {
            const leagueSelect = document.getElementById('match-league').value;
            const league = leagueSelect === 'OTHER' ? document.getElementById('custom-league-name').value.trim() : leagueSelect;
            const custom_match_id = document.getElementById('custom-match-id').value.trim();
            const match_time = document.getElementById('match-time').value;
            const teamA = document.getElementById('team-a').value.trim();
            const teamB = document.getElementById('team-b').value.trim();
            const body_odds = document.getElementById('body-odds').value;
            const goal_odds = document.getElementById('goal-odds').value;

            if (!league || !teamA || !teamB || !match_time) return alert('အချက်အလက်များ ဖြည့်ပါ');

            try {
                const res = await fetch('/api/matches', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ league, custom_match_id, match_name: `${teamA} vs ${teamB}`, body_odds, goal_odds, match_time })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) return alert(data.message || 'Match ထည့်မရပါ။');

                alert(data.message || 'Match added successfully');
                // Clear the Add New Match form after a successful save.
                document.getElementById('match-league').value = 'ENGLISH PREMIER LEAGUE';
                document.getElementById('custom-league-name').value = '';
                document.getElementById('custom-league-box').classList.add('hidden');
                document.getElementById('custom-match-id').value = '';
                document.getElementById('match-time').value = '';
                document.getElementById('team-a').value = '';
                document.getElementById('team-b').value = '';
                document.getElementById('body-odds').value = '';
                document.getElementById('goal-odds').value = '';
                loadMatches();
                loadGlobalLock();
            } catch (err) {
                console.error('Error:', err);
                alert('Server connection error');
            }
        }

        function loadMatches() {
            fetch('/api/matches')
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : { data: [] };
            })
            .then(result => {
                allMatches = result.data || result || [];
                filterMatches();
            })
            .catch(err => console.error('Error:', err));
        }

        function filterMatches() {
            const query = document.getElementById('search-match').value.toLowerCase();
            const selectedLeague = document.getElementById('filter-league-search').value;
            const filtered = allMatches.filter(m => {
                const matchesSearch = (m.match_name && m.match_name.toLowerCase().includes(query));
                const matchesLeague = (selectedLeague === 'ALL' || m.league === selectedLeague);
                return matchesSearch && matchesLeague;
            });
            renderMatchesTable(filtered);
        }

        function renderMatchesTable(matches) {
            const tbody=document.getElementById('match-list'); tbody.innerHTML='';
            if(!matches.length){tbody.innerHTML='<tr><td colspan="10" class="border p-4 text-center">No matches</td></tr>';return;}
            matches.forEach((m,idx)=>{
              const statusClass=m.status==='Open'?'bg-green-100 text-green-700':m.status==='Suspend'?'bg-amber-100 text-amber-700':'bg-red-100 text-red-700';
              tbody.innerHTML+=`<tr>
                <td class="border p-2.5 text-center">${idx+1}</td><td class="border p-2.5 text-center text-xs">${m.league||'-'}</td>
                <td class="border p-2.5 text-center font-bold">${m.custom_match_id||m.id}</td><td class="border p-2.5 text-center">${m.match_name||'-'}</td>
                <td class="border p-2.5 text-center text-xs whitespace-nowrap">${formatMyanmarTime(m.match_time)}</td>
                <td class="border p-2.5 text-center"><select onchange="setMatchLock(${m.id},this.value)" class="border rounded px-1 py-1 text-xs"><option value="global" ${m.lock_minutes==null?'selected':''}>Global (${m.global_lock_minutes||15}m)</option>${[15,10,5,2].map(n=>`<option value="${n}" ${Number(m.lock_minutes)===n?'selected':''}>Override ${n}m</option>`).join('')}</select></td>
                <td class="border p-2.5 text-center font-bold text-red-600">${m.body_odds||'-'}</td><td class="border p-2.5 text-center font-bold text-blue-600">${m.goal_odds||'-'}</td>
                <td class="border p-2.5 text-center"><span class="px-2 py-1 text-xs rounded ${statusClass}">${m.status||'-'}</span><div class="text-[11px] mt-1 text-gray-500">${m.betting_open===false&&m.status==='Open'?'Bet Closed':''}</div></td>
                <td class="border p-2.5 text-center"><div class="flex flex-wrap justify-center gap-1">
                  <button onclick="editMatchQuick(${m.id})" class="bg-blue-600 text-white px-2 py-1 rounded text-xs">Edit</button><button onclick="openEditOddsModal(${m.id})" class="bg-sky-600 text-white px-2 py-1 rounded text-xs">Odds</button>
                  <button onclick="showOddsHistory(${m.id})" class="bg-indigo-600 text-white px-2 py-1 rounded text-xs">History</button>
                  <button onclick="toggleStatus(${m.id}, '${m.status==='Open'?'Closed':'Open'}')" class="bg-amber-500 text-white px-2 py-1 rounded text-xs">${m.status==='Open'?'Close':'Open'}</button>
                  <button onclick="toggleStatus(${m.id}, 'Suspend')" class="bg-orange-500 text-white px-2 py-1 rounded text-xs">Suspend</button><button onclick="toggleStatus(${m.id}, 'Cancelled')" class="bg-red-700 text-white px-2 py-1 rounded text-xs">Cancel</button>
                  <button onclick="deleteMatch(${m.id})" class="bg-red-500 text-white px-2 py-1 rounded text-xs">Delete</button>
                </div></td></tr>`;
            });
        }

        function openEditOddsModal(id) {
            const match = allMatches.find(m => m.id === id);
            if (!match) return;
            document.getElementById('edit-match-db-id').value = match.id;
            document.getElementById('edit-match-name').value = match.match_name;
            generateEditOddsDropdowns();
            if(match.body_odds) document.getElementById('edit-body-odds').value = match.body_odds;
            if(match.goal_odds) document.getElementById('edit-goal-odds').value = match.goal_odds;
            document.getElementById('edit-odds-modal').classList.remove('hidden');
        }

        function closeEditOddsModal() { document.getElementById('edit-odds-modal').classList.add('hidden'); }

        function saveMatchOdds() {
            const id = document.getElementById('edit-match-db-id').value;
            const body_odds = document.getElementById('edit-body-odds').value;
            const goal_odds = document.getElementById('edit-goal-odds').value;
            fetch(`/api/matches/${id}/odds`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body_odds, goal_odds })
            }).then(() => { closeEditOddsModal(); loadMatches(); });
        }

        function toggleStatus(id, newStatus) {
            fetch(`/api/matches/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            }).then(() => loadMatches());
        }

        function deleteMatch(id) {
            if(!confirm('သေချာပါသလား?')) return;
            fetch(`/api/matches/${id}`, { method: 'DELETE' }).then(() => loadMatches());
        }

        // ================= RESULTS ================= //
        function loadResults() {
            fetch('/api/matches')
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : { data: [] };
            })
            .then(result => {
                allMatches = result.data || result || [];
                const tbody = document.getElementById('result-list');
                tbody.innerHTML = '';
                allMatches.forEach((m, idx) => {
                    const score = (m.home_score !== null && m.away_score !== null) ? `${m.home_score} - ${m.away_score}` : 'Not Settled';
                    tbody.innerHTML += `
                        <tr>
                            <td class="border p-2.5 text-center">${idx + 1}</td>
                            <td class="border p-2.5 text-center text-xs">${m.league}</td>
                            <td class="border p-2.5 text-center font-bold">${m.custom_match_id || m.id}</td>
                            <td class="border p-2.5 text-center">${m.match_name}</td>
                            <td class="border p-2.5 text-center font-bold text-emerald-600">${score}</td>
                            <td class="border p-2.5 text-center">${m.status}</td>
                            <td class="border p-2.5 text-center">
                                <button onclick="openResultModalByIndex(${idx})" class="bg-sky-600 text-white px-3 py-1 rounded text-xs cursor-pointer">Enter Score</button>
                            </td>
                        </tr>`;
                });
            })
            .catch(err => console.error('Error:', err));
        }

        function openResultModalByIndex(idx) {
            const select = document.getElementById('modal-match-select');
            select.innerHTML = '';
            allMatches.forEach((m, i) => {
                select.innerHTML += `<option value="${i}" ${i === idx ? 'selected' : ''}>${m.match_name}</option>`;
            });
            onModalMatchSelectChange();
            document.getElementById('result-modal').classList.remove('hidden');
        }

        function onModalMatchSelectChange() {
            const idx = parseInt(document.getElementById('modal-match-select').value);
            const match = allMatches[idx];
            if (!match) return;
            currentActiveMatchId = match.custom_match_id || match.id;
            const teams = (match.match_name || '').split(' vs ');
            document.getElementById('modal-league-display').innerText = match.league;
            document.getElementById('modal-status-badge').innerText = match.status;
            document.getElementById('modal-home-name').innerText = teams[0] || '';
            document.getElementById('modal-away-name').innerText = teams[1] || '';
            document.getElementById('home-score').value = match.home_score ?? '';
            document.getElementById('away-score').value = match.away_score ?? '';
        }

        function closeResultModal() { document.getElementById('result-modal').classList.add('hidden'); }

        function saveMatchResult() {
            const home_score = parseInt(document.getElementById('home-score').value);
            const away_score = parseInt(document.getElementById('away-score').value);
            if (isNaN(home_score) || isNaN(away_score)) return alert('ဂိုးရလဒ် ထည့်ပါ');

            fetch('/api/matches/save-result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ match_id: currentActiveMatchId, home_score, away_score })
            })
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : {};
            })
            .then(data => {
                alert(data.message || 'Saved');
                closeResultModal();
                loadResults();
            })
            .catch(err => console.error('Error:', err));
        }

        // ================= TRANSACTIONS ================= //
        function loadTransactions() {
            fetch('/api/admin/transactions').then(r=>r.json()).then(result=>{
                const list=result.data||[], tbody=document.getElementById('transaction-list'); tbody.innerHTML='';
                if(!list.length)return tbody.innerHTML='<tr><td colspan="7" class="border p-4 text-center">No transactions</td></tr>';
                list.forEach((tx,i)=>{ tbody.innerHTML+=`<tr>
                  <td class="border p-2.5 text-center">${i+1}</td><td class="border p-2.5 font-semibold">${tx.username||'-'}</td>
                  <td class="border p-2.5 text-center">${tx.type||'-'}</td><td class="border p-2.5 text-center font-bold">${Number(tx.amount||0).toLocaleString()}</td>
                  <td class="border p-2.5 text-center text-xs">${formatMyanmarTime(tx.created_at)}</td>
                  <td class="border p-2.5 text-center text-xs">${tx.processed_by||'-'} / ${tx.payment_method||'-'} / ${tx.account_name||'-'} ${tx.phone||''}</td>
                  <td class="border p-2.5 text-center">${tx.status||'-'} ${tx.status==='Pending'?`<button onclick="actionTx(${tx.id},'Approved','${escapeJs(tx.username)}',${Number(tx.amount||0)},'${escapeJs(tx.type)}')" class="bg-green-600 text-white px-2 py-1 rounded text-xs ml-1">Approve</button><button onclick="actionTx(${tx.id},'Rejected','${escapeJs(tx.username)}',${Number(tx.amount||0)},'${escapeJs(tx.type)}')" class="bg-red-600 text-white px-2 py-1 rounded text-xs ml-1">Reject</button>`:''}</td>
                </tr>`;});
            }).catch(e=>{document.getElementById('transaction-list').innerHTML='<tr><td colspan="7" class="border p-4 text-center text-red-600">Failed to load transactions</td></tr>';});
        }

        function actionTx(transaction_id, status, username, amount, type) {
            fetch('/api/admin/transactions/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_id, status, username, amount, type })
            })
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : {};
            })
            .then(data => {
                alert(data.message || 'Success');
                loadTransactions();
            })
            .catch(err => console.error('Error:', err));
        }

        // ================= BETS ================= //
        function loadBets() {
            fetch('/api/bets')
            .then(async res => {
                const text = await res.text();
                return text ? JSON.parse(text) : { data: [] };
            })
            .then(result => {
                const bets = result.data || result || [];
                const tbody = document.getElementById('bets-list');
                tbody.innerHTML = '';
                if(!bets.length) return tbody.innerHTML = `<tr><td colspan="9" class="border p-4 text-center">No bets</td></tr>`;
                bets.forEach((b, i) => {
                    tbody.innerHTML += `
                        <tr>
                            <td class="border p-2.5 text-center">${i+1}</td>
                            <td class="border p-2.5 text-center">${b.username}</td>
                            <td class="border p-2.5 text-center">${b.match_id}</td>
                            <td class="border p-2.5 text-center">${b.match_name}</td>
                            <td class="border p-2.5 text-center">${b.bet_type}</td>
                            <td class="border p-2.5 text-center">${b.choice}</td>
                            <td class="border p-2.5 text-center">${b.amount.toLocaleString()}</td>
                            <td class="border p-2.5 text-center font-bold">${b.status}</td>
                            <td class="border p-2.5 text-center">
                                <button onclick="deleteBet(${b.id})" class="bg-red-500 text-white px-2 py-1 rounded text-xs cursor-pointer">Delete</button>
                            </td>
                        </tr>`;
                });
            })
            .catch(err => console.error('Error:', err));
        }

        function deleteBet(id) {
            if(!confirm('သေချာပါသလား?')) return;
            fetch(`/api/bets/${id}`, { method: 'DELETE' }).then(() => loadBets());
        }

        async function loadDashboard(){ const r=await fetch('/api/admin/dashboard'),d=await r.json(); if(!d.success)return; const f=n=>Number(n||0).toLocaleString(); document.getElementById('dash-stake').textContent=f(d.total_stake); document.getElementById('dash-payout').textContent=f(d.total_payout); document.getElementById('dash-pl').textContent=f(d.net_pl); document.getElementById('dash-open').textContent=Number(d.open_matches||0).toLocaleString(); document.getElementById('dashboard-date').textContent=`${d.date} • ${d.timezone}`; }
        async function loadLedger(){ const r=await fetch('/api/admin/ledger'),d=await r.json(); if(!d.success)return; document.getElementById('ledger-balance').textContent=Number(d.summary?.balance||0).toLocaleString(); document.getElementById('ledger-in').textContent=Number(d.summary?.total_in||0).toLocaleString(); document.getElementById('ledger-out').textContent=Number(d.summary?.total_out||0).toLocaleString(); const tbody=document.getElementById('ledger-list'); tbody.innerHTML=''; (d.data||[]).forEach((x,i)=>tbody.innerHTML+=`<tr><td class="border p-2 text-center">${i+1}</td><td class="border p-2">${x.entry_type||'-'}</td><td class="border p-2">${x.username||'-'}</td><td class="border p-2 text-right font-bold">${Number(x.amount||0).toLocaleString()}</td><td class="border p-2 text-center font-bold ${x.direction==='IN'?'text-emerald-600':'text-rose-600'}">${x.direction||'-'}</td><td class="border p-2 text-right font-semibold">${Number(x.running_balance||0).toLocaleString()}</td><td class="border p-2 text-center">${x.reference_type||'-'} #${x.reference_id||'-'}</td><td class="border p-2">${x.reason||'-'}</td><td class="border p-2">${x.processed_by||'-'}</td><td class="border p-2 text-xs">${formatMyanmarTime(x.created_at)}</td></tr>`); if(!(d.data||[]).length)tbody.innerHTML='<tr><td colspan="10" class="border p-4 text-center">No ledger entries</td></tr>'; }
        async function setMatchLock(id,minutes){ try{ const r=await fetch(`/api/admin/matches/${id}/lock`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lock_minutes:String(minutes)})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.success){alert(d.message||'Lock update failed');return;} loadMatches(); }catch(e){alert('Lock update failed: '+e.message);} }
        async function showOddsHistory(id){ const r=await fetch(`/api/admin/odds-history/${id}`),d=await r.json(); const rows=d.data||[]; alert(rows.length?rows.map(x=>`${x.changed_at} | Body ${x.body_odds} | O/U ${x.goal_odds} | By ${x.changed_by||'-'}`).join('\n'):'No odds history'); }
        function copyLayout(idx){ const m=riskMatchesData[idx]; if(!m)return; navigator.clipboard.writeText(m.copy_text||`Match ${m.custom_match_id||m.id} | ${m.match_name} | Layout ${Number(m.layout_amount||0).toLocaleString()}`).then(()=>alert('Layout amount စာသား Copy ကူးပြီးပါပြီ။')); }
        function openResultModalByMatchId(id){ const idx=allMatches.findIndex(m=>Number(m.id)===Number(id)); if(idx>=0)openResultModalByIndex(idx); }
        async function previewSettlement(){ const match=allMatches.find(m=>String(m.id)===String(document.getElementById('modal-match-select').value)) || allMatches.find(m=>String(m.custom_match_id)===String(currentActiveMatchId)); const match_id=match?.custom_match_id||match?.id||currentActiveMatchId; const hs=Number(document.getElementById('home-score').value),as=Number(document.getElementById('away-score').value); if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return alert('ဂိုးရလဒ် ထည့်ပါ'); const r=await fetch('/api/admin/settlement/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id,home_score:hs,away_score:as})}); const d=await r.json(); if(!r.ok||!d.success)return alert(d.message||'Preview failed'); const ok=confirm(`SETTLEMENT PREVIEW\n\nMatch: ${d.match?.custom_match_id||d.match?.id} ${d.match?.match_name}\nScore: ${hs} - ${as}\nBets: ${d.summary?.bets||0}\nStake: ${Number(d.summary?.stake||0).toLocaleString()}\nPayout: ${Number(d.summary?.payout||0).toLocaleString()}\nNet P/L: ${Number((d.summary?.stake||0)-(d.summary?.payout||0)).toLocaleString()}\n\nConfirm settlement?`); if(!ok)return; const cr=await fetch('/api/admin/settlement/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id,home_score:hs,away_score:as})}); const cd=await cr.json(); alert(cd.message|| (cd.success?'Settlement complete':'Settlement failed')); if(cd.success){closeResultModal();loadResults();}}

        // ================= RISK ================= //
        function loadRiskData() {
            fetch('/api/admin/risk-summary')
                .then(async res => { const t = await res.text(); return t ? JSON.parse(t) : { data: [] }; })
                .then(result => {
                    const matches = result.data || [];
                    riskMatchesData = matches;
                    const tbody = document.getElementById('risk-list');
                    tbody.innerHTML = '';
                    if (!matches.length) {
                        tbody.innerHTML = '<tr><td colspan="10" class="border p-4 text-center text-gray-500">No risk data</td></tr>';
                        return;
                    }
                    matches.forEach((m, idx) => {
                        const total = Number(m.total_pool) || 0;
                        tbody.innerHTML += `
                            <tr>
                                <td class="border p-2.5 text-center font-bold">${m.custom_match_id || m.id}</td>
                                <td class="border p-2.5 text-center">${m.match_name || '-'}</td>
                                <td class="border p-2.5 text-center text-rose-600 font-bold">${total.toLocaleString()}</td>
                                <td class="border p-2.5 text-center">${Number(m.home_amount||0).toLocaleString()}</td>
                                <td class="border p-2.5 text-center">${Number(m.away_amount||0).toLocaleString()}</td>
                                <td class="border p-2.5 text-center">${Number(m.over_amount||0).toLocaleString()}</td>
                                <td class="border p-2.5 text-center">${Number(m.under_amount||0).toLocaleString()}</td>
                                <td class="border p-2.5 text-center">${m.bettor_count || 0}</td>
                                <td class="border p-2.5 text-center font-bold text-rose-600">${Number(m.max_side_risk||0).toLocaleString()}</td>
                                <td class="border p-2.5 text-center"><div class="font-bold text-rose-700">${Number(m.layout_amount||0).toLocaleString()}</div><button onclick="copyLayout(${idx})" class="mt-1 bg-slate-700 text-white px-2 py-1 rounded text-[11px]">Copy</button></td>
                                <td class="border p-2.5 text-center">
                                    <button onclick="openForwardModalByIndex(${idx})" class="bg-rose-600 text-white px-3 py-1 rounded text-xs cursor-pointer">Transfer</button>
                                </td>
                            </tr>`;
                    });
                })
                .catch(err => console.error('Risk load error:', err));
        }

        function openForwardModalByIndex(idx) {
            const m = riskMatchesData[idx];
            if (!m) return;
            const teams = (m.match_name || '').split(' vs ');
            const matchId = m.custom_match_id || m.id;
            forwardMatchData = { matchId };
            document.getElementById('forward-match-id').innerText = matchId;
            document.getElementById('forward-choice').innerHTML = `
                <option value="${teams[0]?.trim()}">${teams[0]?.trim()}</option>
                <option value="${teams[1]?.trim()}">${teams[1]?.trim()}</option>
                <option value="Over">Over</option>
                <option value="Under">Under</option>
            `;
            document.getElementById('forward-amount').value = '';
            document.getElementById('forward-modal').classList.remove('hidden');
        }

        function closeForwardModal() { document.getElementById('forward-modal').classList.add('hidden'); }

        function submitForwardRisk() {
            const choice = document.getElementById('forward-choice').value;
            const amount = parseFloat(document.getElementById('forward-amount').value);
            if(!amount || amount <= 0) return alert('ပမာဏထည့်ပါ');

            fetch('/api/admin/forward-risk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ match_id: forwardMatchData.matchId, choice, amount })
            }).then(() => { closeForwardModal(); loadRiskData(); });
        }

        // ================= WEBSITE NOTICE MANAGEMENT (NEW SCRIPTS) ================= //
        async function loadCurrentNotice() {
            try {
                const res = await fetch('/api/notice');
                const data = await res.json();
                if (data) {
                    let text = "";
                    if (typeof data === 'string') text = data;
                    else if (data.notice) text = data.notice;
                    else if (data.message) text = data.message;
                    
                    document.getElementById('noticeTextInput').value = text;
                    document.getElementById('noticeEnabledInput').checked = data.enabled !== false;
                }
            } catch (err) {
                console.error('Failed to load current notice:', err);
            }
        }

        document.getElementById('adminNoticeForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const noticeText = document.getElementById('noticeTextInput').value.trim();
            const statusMsg = document.getElementById('noticeStatusMsg');

            statusMsg.textContent = "သိမ်းဆည်းနေပါသည်...";
            statusMsg.className = "text-sm font-bold text-yellow-600";

            try {
                const res = await fetch('/api/admin/notice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notice: noticeText, enabled: document.getElementById('noticeEnabledInput').checked })
                });
                const result = await res.json();

                if (result.success !== false) {
                    statusMsg.textContent = "✔ Notice အောင်မြင်စွာ တင်ပြီးပါပြီ။";
                    statusMsg.className = "text-sm font-bold text-green-600";
                } else {
                    statusMsg.textContent = "✖ မအောင်မြင်ပါ။ ထပ်ကြိုးစားပါ။";
                    statusMsg.className = "text-sm font-bold text-red-600";
                }
            } catch (err) {
                console.error('Error updating notice:', err);
                statusMsg.textContent = "✖ Server ချိတ်ဆက်မှု အဆင်မပြေပါ။";
                statusMsg.className = "text-sm font-bold text-red-600";
            }
        });

        populateOddsDropdowns();
        document.getElementById('adminLoginForm').addEventListener('submit', adminLogin);
        (async function initAdminSecurity(){
            const token = localStorage.getItem('adminAuthToken');
            if (!token) return showAdminLogin();
            try {
                const res = await fetch('/api/me'); const data = await res.json();
                if (!res.ok || !data.success || data.user.role !== 'admin') return showAdminLogin();
                hideAdminLogin(); switchPage('users');
            } catch (_) { showAdminLogin(); }
        })();
    