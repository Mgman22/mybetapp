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

        function formatDbUtcTime(timeStr) {
            if (!timeStr) return '-';
            const raw = String(timeStr).trim().replace(' ', 'T') + 'Z';
            const ms = Date.parse(raw);
            if (Number.isNaN(ms)) return timeStr;
            return new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Yangon', month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true }).format(new Date(ms)) + ' (GMT+6:30)';
        }

        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            sidebar.classList.toggle('hidden');
            sidebar.classList.toggle('absolute');
            sidebar.classList.toggle('z-40');
            sidebar.classList.toggle('h-full');
        }

        function switchPage(page) {
            ['dashboard', 'users', 'bet-limits', 'matches', 'results', 'final-scores', 'transactions', 'bets', 'risk', 'ledger', 'reports', 'audit', 'settings', 'backup', 'notice', 'rules'].forEach(p => {
                const pageEl = document.getElementById(`page-${p}`);
                const navEl = document.getElementById(`nav-${p}`);
                if (pageEl) pageEl.classList.add('hidden');
                if (navEl) {
                    if (p === 'risk') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-rose-400";
                    else if (p === 'bet-limits') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-amber-300";
                    else if (p === 'transactions') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-yellow-400";
                    else if (p === 'notice') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-cyan-400";
                    else if (p === 'final-scores') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-cyan-300";
                    else if (p === 'rules') navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-indigo-300";
                    else navEl.className = "w-full text-left px-4 py-2.5 rounded hover:bg-slate-800 text-slate-300";
                }
            });

            const activePage = document.getElementById(`page-${page}`);
            const activeNav = document.getElementById(`nav-${page}`);
            
            if (activePage) activePage.classList.remove('hidden');
            if (activeNav) {
                if (page === 'risk') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-rose-600 text-white font-semibold";
                else if (page === 'bet-limits') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-amber-500 text-slate-950 font-semibold";
                else if (page === 'transactions') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-yellow-600 text-white font-semibold";
                else if (page === 'notice') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-cyan-600 text-white font-semibold";
                else if (page === 'final-scores') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-cyan-600 text-white font-semibold";
                else if (page === 'rules') activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-indigo-600 text-white font-semibold";
                else activeNav.className = "w-full text-left px-4 py-2.5 rounded bg-blue-600 text-white font-semibold";
            }
            
            const titles = { 
                dashboard: 'Dashboard',
                users: 'Marker', 
                'bet-limits': 'Bettor Match Bet Limits',
                matches: 'Match Management', 
                results: 'Settlement Center',
                'final-scores': 'Final Score Manager',
                transactions: 'Deposit & Withdraw Transactions',
                bets: 'Betting Records', 
                risk: 'Risk Management',
                ledger: 'Admin Ledger',
                reports: 'Reports',
                audit: 'Audit Log',
                settings: 'System Settings',
                backup: 'Backup & Restore',
                notice: 'Website Notice Management',
                rules: 'Rules & Regulations'
            };
            document.getElementById('page-title').innerText = titles[page] || 'Admin Dashboard';

            if(page === 'dashboard') loadDashboard();
            else if(page === 'users') loadUsers();
            else if(page === 'bet-limits') loadBetLimits();
            else if(page === 'matches') { loadMatches(); loadGlobalLock(); loadLateBetCap(); }
            else if(page === 'results') loadResults();
            else if(page === 'final-scores') loadFinalScoreManager();
            else if(page === 'transactions') loadTransactions();
            else if(page === 'bets') loadBets();
            else if(page === 'risk') loadRiskData();
            else if(page === 'ledger') loadLedger();
            else if(page === 'reports') loadReports();
            else if(page === 'audit') loadAuditLog();
            else if(page === 'settings') loadAdminSettings();
            else if(page === 'backup') loadBackups();
            else if(page === 'notice') loadCurrentNotice();
            else if(page === 'rules') loadCurrentRules();

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
            if (customBox) customBox.classList.toggle('hidden', leagueSelect !== 'OTHER');
            updateAddMatchPreview();
        }

        function getBodyFavoredSide() {
            const selected = document.querySelector('input[name="body-favored-side"]:checked');
            return selected ? selected.value : 'home';
        }

        function updateAddMatchPreview() {
            const home = (document.getElementById('team-a')?.value || '').trim() || 'Home Team';
            const away = (document.getElementById('team-b')?.value || '').trim() || 'Away Team';
            const side = getBodyFavoredSide() === 'away' ? away : home;
            const date = document.getElementById('match-date')?.value || '';
            const time = document.getElementById('match-clock')?.value || '';
            const leagueEl = document.getElementById('match-league');
            const league = leagueEl?.value === 'OTHER'
                ? ((document.getElementById('custom-league-name')?.value || '').trim() || 'Other')
                : (leagueEl?.value || 'League');
            const body = document.getElementById('body-odds')?.value || '—';
            const gp = document.getElementById('goal-odds')?.value || '—';
            const kickoff = date && time ? `${date} ${time}` : 'Kickoff';
            const homeEl = document.getElementById('preview-home');
            const awayEl = document.getElementById('preview-away');
            const metaEl = document.getElementById('match-preview-meta');
            const favEl = document.getElementById('fav-preview');
            if (homeEl) homeEl.textContent = home;
            if (awayEl) awayEl.textContent = away;
            if (favEl) favEl.value = side;
            if (metaEl) metaEl.textContent = `${document.getElementById('custom-match-id')?.value || 'Match'} · ${league} · ${kickoff} · Body: ${side} ${body} · GP: ${gp}`;
        }

        function clearMatchForm() {
            const ids = ['custom-match-id','custom-league-name','match-date','match-clock','team-a','team-b'];
            ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            const league = document.getElementById('match-league');
            if (league) league.value = '';
            const custom = document.getElementById('custom-league-box');
            if (custom) custom.classList.add('hidden');
            const body = document.getElementById('body-odds');
            const gp = document.getElementById('goal-odds');
            if (body) body.value = '';
            if (gp) gp.value = '';
            const home = document.querySelector('input[name="body-favored-side"][value="home"]');
            if (home) home.checked = true;
            updateAddMatchPreview();
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

        function bindAddMatchPreviewEvents() {
            ['custom-match-id','match-league','custom-league-name','match-date','match-clock','team-a','team-b','body-odds','goal-odds']
                .forEach(id => {
                    const el = document.getElementById(id);
                    if (el) { el.addEventListener('input', updateAddMatchPreview); el.addEventListener('change', updateAddMatchPreview); }
                });
            document.querySelectorAll('input[name="body-favored-side"]').forEach(el => el.addEventListener('change', updateAddMatchPreview));
            updateAddMatchPreview();
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

        let betLimitUsers = [];
        let betLimitMatches = [];
        let savedBetLimits = [];

        function limitAmountLabel(value) {
            const n = Number(value || 0);
            return n > 0 ? n.toLocaleString() : 'Unlimited';
        }

        async function loadBetLimits() {
            const tbody = document.getElementById('bet-limit-list');
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="border p-5 text-center text-slate-500">Loading limits...</td></tr>';
            try {
                const [usersRes, matchesRes, limitsRes] = await Promise.all([
                    fetch('/api/users'), fetch('/api/matches'), fetch('/api/admin/bet-limits')
                ]);
                const [usersData, matchesData, limitsData] = await Promise.all([usersRes.json(), matchesRes.json(), limitsRes.json()]);
                if (!usersRes.ok || !matchesRes.ok || !limitsRes.ok || !limitsData.success) throw new Error(limitsData.message || 'Could not load bettor or match data.');
                betLimitUsers = usersData.data || [];
                betLimitMatches = matchesData.data || [];
                savedBetLimits = limitsData.data || [];
                const userSelect = document.getElementById('limit-user-select');
                const matchSelect = document.getElementById('limit-match-select');
                const oldUser = userSelect.value; const oldMatch = matchSelect.value;
                userSelect.innerHTML = '<option value="">Choose Bettor</option>' + betLimitUsers.map(u => `<option value="${Number(u.id)}">${escapeHtml(u.username)}</option>`).join('');
                matchSelect.innerHTML = '<option value="">Choose Match</option>' + betLimitMatches.map(m => `<option value="${Number(m.id)}">#${escapeHtml(m.custom_match_id || m.id)} — ${escapeHtml(m.match_name || '')}</option>`).join('');
                if (betLimitUsers.some(u => String(u.id) === oldUser)) userSelect.value = oldUser;
                if (betLimitMatches.some(m => String(m.id) === oldMatch)) matchSelect.value = oldMatch;
                tbody.innerHTML = savedBetLimits.length ? savedBetLimits.map(row => `
                    <tr class="hover:bg-slate-50">
                        <td class="border p-2.5 font-semibold">${escapeHtml(row.username || '-')}</td>
                        <td class="border p-2.5"><div class="font-bold">#${escapeHtml(row.custom_match_id || row.match_db_id)}</div><div class="text-xs text-slate-500">${escapeHtml(row.match_name || '')}</div></td>
                        <td class="border p-2.5 text-center font-semibold text-rose-700">${limitAmountLabel(row.body_home_limit)}</td>
                        <td class="border p-2.5 text-center font-semibold text-blue-700">${limitAmountLabel(row.body_away_limit)}</td>
                        <td class="border p-2.5 text-center font-semibold text-emerald-700">${limitAmountLabel(row.gp_over_limit)}</td>
                        <td class="border p-2.5 text-center font-semibold text-indigo-700">${limitAmountLabel(row.gp_under_limit)}</td>
                        <td class="border p-2.5 text-center text-xs text-slate-500">${escapeHtml(row.updated_at || '-')}</td>
                        <td class="border p-2.5 text-center whitespace-nowrap"><button type="button" onclick="editBetLimit(${Number(row.user_id)},${Number(row.match_db_id)})" class="bg-amber-500 text-white px-2.5 py-1 rounded text-xs font-bold">Edit</button> <button type="button" onclick="deleteBetLimit(${Number(row.user_id)},${Number(row.match_db_id)})" class="bg-red-600 text-white px-2.5 py-1 rounded text-xs font-bold">Remove</button></td>
                    </tr>`).join('') : '<tr><td colspan="8" class="border p-5 text-center text-slate-500">No limits saved yet. All sides are currently unlimited.</td></tr>';
            } catch (err) {
                if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="border p-5 text-center text-red-600">${escapeHtml(err.message || 'Failed to load limits.')}</td></tr>`;
            }
        }

        function editBetLimit(userId, matchDbId) {
            const row = savedBetLimits.find(x => Number(x.user_id) === Number(userId) && Number(x.match_db_id) === Number(matchDbId));
            if (!row) return;
            document.getElementById('limit-user-select').value = String(userId);
            document.getElementById('limit-match-select').value = String(matchDbId);
            document.getElementById('limit-body-home').value = Number(row.body_home_limit || 0);
            document.getElementById('limit-body-away').value = Number(row.body_away_limit || 0);
            document.getElementById('limit-gp-over').value = Number(row.gp_over_limit || 0);
            document.getElementById('limit-gp-under').value = Number(row.gp_under_limit || 0);
            document.getElementById('limit-user-select').focus();
            window.scrollTo({ top:0, behavior:'smooth' });
        }

        function clearBetLimitForm() {
            document.getElementById('limit-user-select').value = '';
            document.getElementById('limit-match-select').value = '';
            ['limit-body-home','limit-body-away','limit-gp-over','limit-gp-under'].forEach(id => document.getElementById(id).value = '0');
        }

        async function saveBetLimit() {
            const payload = {
                user_id:Number(document.getElementById('limit-user-select').value),
                match_db_id:Number(document.getElementById('limit-match-select').value),
                body_home_limit:Number(document.getElementById('limit-body-home').value || 0),
                body_away_limit:Number(document.getElementById('limit-body-away').value || 0),
                gp_over_limit:Number(document.getElementById('limit-gp-over').value || 0),
                gp_under_limit:Number(document.getElementById('limit-gp-under').value || 0)
            };
            if (!payload.user_id || !payload.match_db_id) return alert('Choose a Bettor and Match first.');
            if (Object.entries(payload).some(([k,v]) => k.endsWith('_limit') && (!Number.isFinite(v) || v < 0))) return alert('Limits must be zero or a positive number.');
            try {
                const res = await fetch('/api/admin/bet-limits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) return alert(data.message || 'Could not save bet limits.');
                alert('Bet limits saved.');
                await loadBetLimits();
            } catch (err) { alert(err.message || 'Could not save bet limits.'); }
        }

        async function deleteBetLimit(userId, matchDbId) {
            if (!confirm('Remove this limit rule? Bets on these sides will be unlimited until a new limit is saved.')) return;
            try {
                const res = await fetch(`/api/admin/bet-limits?user_id=${encodeURIComponent(userId)}&match_db_id=${encodeURIComponent(matchDbId)}`,{method:'DELETE'});
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) return alert(data.message || 'Could not remove bet limits.');
                await loadBetLimits();
            } catch (err) { alert(err.message || 'Could not remove bet limits.'); }
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

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\"/g, '&quot;')
                .replace(/'/g, '&#39;');
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
        async function editMatchQuick(id){ const m=allMatches.find(x=>Number(x.id)===Number(id)); if(!m)return; const league=prompt('League:',m.league||''); if(league===null)return; const name=prompt('Match name (Home vs Away):',m.match_name||''); if(name===null)return; const time=prompt('Kickoff (existing format):',m.match_time||''); if(time===null)return; const teams=String(name).split(/\s+vs\s+/i).map(x=>x.trim()); const homeTeam=teams[0]||'Home'; const awayTeam=teams[1]||'Away'; const currentFavored=String(m.body_favored_side||'home').toLowerCase()==='away'?'away':'home'; const currentFavoredName=currentFavored==='away'?awayTeam:homeTeam; const favoredInput=prompt(`ကြေးပေးအသင်းရွေးပါ။\n\nHome: ${homeTeam}\nAway: ${awayTeam}\n\nHome / Away`,currentFavored); if(favoredInput===null)return; const normalizedFavored=String(favoredInput).trim().toLowerCase(); if(!['home','away'].includes(normalizedFavored))return alert('ကြေးပေးအသင်းမှာ Home သို့မဟုတ် Away ပဲ ရွေးပါ။'); const r=await fetch(`/api/admin/matches/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({league,match_name:name,match_time:time,body_odds:m.body_odds,goal_odds:m.goal_odds,status:m.status,lock_mode:m.lock_mode||'global',lock_minutes:m.lock_mode==='override'?Number(m.lock_minutes):null,body_favored_side:normalizedFavored})}); const d=await r.json(); if(!r.ok||!d.success)return alert(d.message||'Match update failed'); loadMatches(); if(String(activeRiskMatchId||'')===String(m.id)){ await openRiskPopup(m.id); } }
        async function loadGlobalLock(){try{const r=await fetch('/api/admin/settings/lock'),d=await r.json();if(d.success)document.getElementById('global-lock-minutes').value=String(d.minutes);}catch(e){}}
        async function saveGlobalLock(minutes){try{const r=await fetch('/api/admin/settings/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:Number(minutes)})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success){alert(d.message||'Global lock update failed');return;}loadMatches();}catch(e){alert('Global lock update failed: '+e.message);}}
        async function loadLateBetCap(){try{const r=await fetch('/api/admin/settings/late-bet-cap'),d=await r.json();if(!d.success)return;document.getElementById('late-cap-enabled').value=d.enabled?'1':'0';document.getElementById('late-cap-amount').value=Number(d.amount||0)||'';}catch(e){}}
        async function saveLateBetCap(){try{const enabled=document.getElementById('late-cap-enabled').value==='1';const window_minutes=5;const amount=Number(document.getElementById('late-cap-amount').value||0);if(enabled && (!Number.isFinite(amount)||amount<=0)){alert('Late Bet Cap On ဖြစ်လျှင် Max stake ထည့်ပေးပါ။');return;}const r=await fetch('/api/admin/settings/late-bet-cap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,window_minutes,amount})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success){alert(d.message||'Late Bet Cap update failed');return;}loadMatches();}catch(e){alert('Late Bet Cap update failed: '+e.message);}}
        async function addMatch() {
            const leagueSelect = document.getElementById('match-league').value;
            const customLeague = (document.getElementById('custom-league-name').value || '').trim();
            const league = leagueSelect === 'OTHER' ? customLeague : leagueSelect;
            const custom_match_id = document.getElementById('custom-match-id').value.trim();
            const date = document.getElementById('match-date').value;
            const clock = document.getElementById('match-clock').value;
            const teamA = document.getElementById('team-a').value.trim();
            const teamB = document.getElementById('team-b').value.trim();
            const body_odds = document.getElementById('body-odds').value;
            const goal_odds = document.getElementById('goal-odds').value;
            const body_favored_side = getBodyFavoredSide();

            if (!custom_match_id || !league || !date || !clock || !teamA || !teamB || !body_odds || !goal_odds) {
                return alert('အချက်အလက်များ ပြည့်စုံစွာ ဖြည့်ပါ');
            }
            if (teamA.toLowerCase() === teamB.toLowerCase()) {
                return alert('Home Team နှင့် Away Team တူလို့မရပါ။');
            }

            const match_time = `${date}T${clock}`;
            try {
                const res = await fetch('/api/matches', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        league, custom_match_id,
                        match_name: `${teamA} vs ${teamB}`,
                        team_a: teamA, team_b: teamB,
                        body_odds, goal_odds, body_favored_side,
                        match_time, lock_mode: 'global'
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) return alert(data.message || data.error || 'Match ထည့်မရပါ။');

                alert(data.message || 'Match added successfully');
                clearMatchForm();
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
                <td class="border p-2.5 text-center"><select onchange="setMatchLock(${m.id},this.value)" class="border rounded px-1 py-1 text-xs"><option value="global" ${String(m.lock_mode||'global')==='global'?'selected':''}>Global (${m.global_lock_minutes||15}m)</option>${[15,10,5,2].map(n=>`<option value="${n}" ${String(m.lock_mode||'global')==='override' && Number(m.lock_minutes)===n?'selected':''}>Override ${n}m</option>`).join('')}</select></td>
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

        // ================= FINAL SCORE MANAGER ================= //
        async function loadFinalScoreManager() {
            const tbody = document.getElementById('final-score-list');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-500">Loading final scores...</td></tr>';
            try {
                const response = await fetch('/api/admin/final-scores', {cache:'no-store'});
                const payload = await response.json();
                if (!response.ok || !payload.success) throw new Error(payload.message || 'Unable to load final scores.');
                const matches = Array.isArray(payload.data) ? payload.data : [];
                allMatches = matches;
                if (!matches.length) {
                    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-500">No matches yet. Add a match first.</td></tr>';
                    return;
                }
                tbody.innerHTML = matches.map((m, index) => {
                    const id = Number(m.id);
                    const teams = String(m.match_name || 'Match').split(/\s+vs\s+/i);
                    const home = teams[0] || 'Home';
                    const away = teams[1] || 'Away';
                    const hasScore = m.home_score !== null && m.home_score !== undefined && m.away_score !== null && m.away_score !== undefined;
                    const score = hasScore ? `${m.home_score} - ${m.away_score}` : 'Not entered';
                    const state = String(m.status || '').toLowerCase();
                    const cannotEdit = ['settled','cancelled','postponed'].includes(state);
                    const published = Number(m.marquee_published) === 1;
                    const savedClass = hasScore ? 'text-emerald-700' : 'text-slate-500';
                    return `<tr>
                        <td class="border p-2 text-center">${index+1}</td>
                        <td class="border p-2 text-center font-bold">${escapeHtml(m.custom_match_id || m.id)}</td>
                        <td class="border p-2 min-w-[230px]"><div class="font-semibold">${escapeHtml(home)} vs ${escapeHtml(away)}</div><div class="text-xs text-slate-500 mt-1">${escapeHtml(m.league || '-')} · ${escapeHtml(formatAdminYgn(m.match_time))}</div><div class="text-xs text-slate-500 mt-1">Status: ${escapeHtml(m.status || '-')}</div></td>
                        <td class="border p-2 text-center font-extrabold ${savedClass}">${escapeHtml(score)}</td>
                        <td class="border p-2"><div class="flex items-center justify-center gap-2"><label class="text-xs text-slate-500">H <input id="score-home-${id}" type="number" min="0" max="99" step="1" value="${hasScore ? Number(m.home_score) : ''}" ${cannotEdit ? 'disabled' : ''} class="w-16 p-2 border rounded text-center font-bold" aria-label="${escapeHtml(home)} score"></label><span class="font-bold text-slate-400">–</span><label class="text-xs text-slate-500">A <input id="score-away-${id}" type="number" min="0" max="99" step="1" value="${hasScore ? Number(m.away_score) : ''}" ${cannotEdit ? 'disabled' : ''} class="w-16 p-2 border rounded text-center font-bold" aria-label="${escapeHtml(away)} score"></label></div></td>
                        <td class="border p-2 text-center">${published ? '<span class="inline-flex px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">Published</span>' : '<span class="inline-flex px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-bold">Hidden</span>'}</td>
                        <td class="border p-2"><div class="flex flex-wrap justify-center gap-2">
                            <button type="button" onclick="saveFinalScore(${id})" ${cannotEdit ? 'disabled title="Scores for settled/cancelled/postponed matches cannot be edited"' : ''} class="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-xs font-bold">Save Score</button>
                            <button type="button" onclick="toggleFinalScorePublication(${id},${published ? 0 : 1})" ${!hasScore && !published ? 'disabled title="Save a score first"' : ''} class="px-3 py-1.5 rounded ${published ? 'bg-amber-500 hover:bg-amber-600 text-slate-950' : 'bg-cyan-600 hover:bg-cyan-700 text-white'} disabled:bg-slate-300 text-xs font-bold">${published ? 'Hide' : 'Publish'}</button>
                            <button type="button" onclick="openSettlementForMatch(${id})" ${state === 'settled' || ['cancelled','postponed'].includes(state) ? 'disabled' : ''} class="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-xs font-bold">${state === 'settled' ? 'Settled' : 'Open Settlement'}</button>
                        </div></td>
                    </tr>`;
                }).join('');
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-red-600">${escapeHtml(err.message || 'Unable to load final scores.')}</td></tr>`;
            }
        }

        function formatAdminYgn(value) {
            if (!value) return '-';
            const raw = String(value).trim().replace(' ', 'T');
            const ms = parseMyanmarTime(value);
            if (!ms) return String(value);
            return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Yangon',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(ms));
        }

        async function saveFinalScore(matchDbId) {
            const homeInput = document.getElementById(`score-home-${matchDbId}`);
            const awayInput = document.getElementById(`score-away-${matchDbId}`);
            if (!homeInput || !awayInput) return;
            const home_score = Number(homeInput.value), away_score = Number(awayInput.value);
            if (homeInput.value === '' || awayInput.value === '' || !Number.isInteger(home_score) || !Number.isInteger(away_score) || home_score < 0 || away_score < 0 || home_score > 99 || away_score > 99) {
                return alert('Enter valid whole-number home and away scores from 0 to 99.');
            }
            if (!confirm(`Save final score ${home_score} - ${away_score}?\n\nThis will NOT settle bets or change payouts.`)) return;
            try {
                const response = await fetch(`/api/admin/final-scores/${matchDbId}/score`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({home_score,away_score})});
                const data = await response.json().catch(()=>({}));
                if (!response.ok || !data.success) throw new Error(data.message || 'Could not save score.');
                alert(data.message || 'Score saved. Settlement has not been run.');
                await loadFinalScoreManager();
            } catch (err) { alert(err.message || 'Could not save score.'); }
        }

        async function toggleFinalScorePublication(matchDbId, published) {
            try {
                const response = await fetch(`/api/admin/final-scores/${matchDbId}/publish`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({published:published === 1})});
                const data = await response.json().catch(()=>({}));
                if (!response.ok || !data.success) throw new Error(data.message || 'Could not update marquee visibility.');
                await loadFinalScoreManager();
                showAdminToast(data.message || (published ? 'Published.' : 'Hidden.'));
            } catch (err) { alert(err.message || 'Could not update marquee visibility.'); }
        }

        function openSettlementForMatch(matchDbId) {
            const idx = allMatches.findIndex(m => Number(m.id) === Number(matchDbId));
            if (idx < 0) return alert('Match not found. Refresh the Final Score Manager and try again.');
            openResultModalByIndex(idx);
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
                    const state = String(m.status||'').toLowerCase();
                    const settled = state === 'settled';
                    const blocked = ['cancelled','postponed'].includes(state);
                    const action = settled ? 'Settled' : (blocked ? 'View' : 'Open Settlement');
                    const cls = settled ? 'bg-emerald-600' : (blocked ? 'bg-slate-600' : 'bg-sky-600');
                    tbody.innerHTML += `
                        <tr>
                            <td class="border p-2.5 text-center">${idx + 1}</td>
                            <td class="border p-2.5 text-center text-xs">${escapeHtml(m.league||'-')}</td>
                            <td class="border p-2.5 text-center font-bold">${escapeHtml(m.custom_match_id || m.id)}</td>
                            <td class="border p-2.5 text-center">${escapeHtml(m.match_name||'-')}</td>
                            <td class="border p-2.5 text-center font-bold text-emerald-600">${escapeHtml(score)}</td>
                            <td class="border p-2.5 text-center">${escapeHtml(m.status||'-')}</td>
                            <td class="border p-2.5 text-center">
                                ${settled ? `<span class="text-emerald-600 font-bold text-xs">Settled</span>` : `<button onclick="openResultModalByIndex(${idx})" class="${cls} text-white px-3 py-1 rounded text-xs cursor-pointer">${action}</button>`}
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
                select.innerHTML += `<option value="${i}" ${i === idx ? 'selected' : ''}>${escapeHtml(m.match_name || 'Match')}</option>`;
            });
            onModalMatchSelectChange();
            document.getElementById('result-modal').classList.remove('hidden');
        }

        function setModalVisible(id, visible){
            const el=document.getElementById(id); if(!el)return;
            if(visible){ el.classList.remove('hidden'); el.classList.add('flex'); document.body.classList.add('overflow-hidden'); }
            else { el.classList.add('hidden'); el.classList.remove('flex'); if(!document.querySelector('.fixed.flex[role="dialog"]')) document.body.classList.remove('overflow-hidden'); }
        }

        function resetSettlementPreview(){
            const box=document.getElementById('settlement-preview'); if(box)box.classList.add('hidden');
            const c=document.getElementById('settlement-confirm-btn'); if(c)c.classList.add('hidden');
            const b=document.getElementById('settlement-preview-btn'); if(b){b.classList.remove('hidden');b.disabled=false;b.textContent='Preview Settlement';}
            const list=document.getElementById('settlement-preview-list'); if(list)list.innerHTML='';
            const modalList=document.getElementById('settlement-preview-list-modal'); if(modalList)modalList.innerHTML='';
            lastSettlementPreview=null;
            const cb=document.getElementById('settlement-confirm-modal-btn'); if(cb){cb.disabled=false;cb.textContent='Confirm Settlement';}
            const fb=document.getElementById('settlement-confirm-final-btn'); if(fb){fb.disabled=false;fb.textContent='Confirm';}
            setModalVisible('settlement-preview-modal',false);
            setModalVisible('settlement-confirm-modal',false);
        }

        function onModalMatchSelectChange() {
            const idx = parseInt(document.getElementById('modal-match-select').value);
            const match = allMatches[idx]; if (!match) return;
            currentActiveMatchId = match.custom_match_id || match.id;
            const teams = (match.match_name || '').split(/\s+vs\s+/i);
            document.getElementById('modal-league-display').innerText = match.league || '';
            document.getElementById('modal-status-badge').innerText = match.status || '';
            document.getElementById('modal-home-name').innerText = teams[0] || '';
            document.getElementById('modal-away-name').innerText = teams[1] || '';
            document.getElementById('home-score').value = match.home_score ?? '';
            document.getElementById('away-score').value = match.away_score ?? '';
            resetSettlementPreview();
        }

        function closeResultModal(){ resetSettlementPreview(); setModalVisible('result-modal',false); }
        function closeSettlementPreview(){ setModalVisible('settlement-preview-modal',false); }
        function closeSettlementConfirm(){ setModalVisible('settlement-confirm-modal',false); }

        function openSettlementConfirm(){
            if(!lastSettlementPreview)return alert('Preview the settlement first.');
            const p=lastSettlementPreview, s=p.data?.summary||{};
            document.getElementById('settlement-confirm-body').innerHTML=`
                <div class="space-y-1">
                    <div><span class="text-slate-400">Match:</span> <strong>${escapeHtml(p.data?.match?.custom_match_id||p.data?.match?.id||'-')} ${escapeHtml(p.data?.match?.match_name||'')}</strong></div>
                    <div><span class="text-slate-400">Score:</span> <strong>${p.home_score} - ${p.away_score}</strong></div>
                    <div><span class="text-slate-400">Bets:</span> ${Number(s.bets||0).toLocaleString()}</div>
                    <div><span class="text-slate-400">Stake:</span> ${Number(s.stake||0).toLocaleString()}</div>
                    <div><span class="text-slate-400">Payout:</span> ${Number(s.payout||0).toLocaleString()}</div>
                    <div><span class="text-slate-400">Admin Net P/L:</span> ${Number(s.admin_pl||0).toLocaleString()}</div>
                </div>`;
            setModalVisible('settlement-confirm-modal',true);
        }

        function saveMatchResult(){
            const home_score=parseInt(document.getElementById('home-score').value), away_score=parseInt(document.getElementById('away-score').value);
            if(isNaN(home_score)||isNaN(away_score))return alert('Enter a valid final score.');
            fetch('/api/matches/save-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id:currentActiveMatchId,home_score,away_score})})
            .then(async res=>{const text=await res.text();return text?JSON.parse(text):{};})
            .then(data=>{alert(data.message||'Saved');closeResultModal();loadResults();loadLedger();})
            .catch(err=>alert(err.message||'Save result failed'));
        }

        // ================= TRANSACTIONS ================= //
        function loadTransactions() {
            fetch('/api/admin/transactions').then(r=>r.json()).then(result=>{
                const list=result.data||[], tbody=document.getElementById('transaction-list');
                tbody.innerHTML='';
                if(!list.length){
                    return tbody.innerHTML='<tr><td colspan="10" class="border p-4 text-center">No transactions</td></tr>';
                }
                list.forEach((tx,i)=>{
                    const who = tx.process_by_who || (tx.processed_by === 'System' ? 'System' : (tx.processed_by ? 'Admin' : (tx.status === 'Completed' && ['Bet Placed','Parlay Bet','Payout','Refund'].includes(tx.type) ? 'System' : '-')));
                    const where = tx.process_by_where || (who === 'System' ? 'Server' : (tx.status === 'Approved' || tx.status === 'Rejected' ? 'Unknown' : '-'));
                    const processedTime = tx.processed_at ? formatDbUtcTime(tx.processed_at) : '-';
                    const marker = tx.username || '-';
                    const type = tx.type || '-';
                    tbody.innerHTML += `<tr data-tx-row="${Number(tx.id)}">
                      <td class="border p-2 text-center">${i+1}</td>
                      <td class="border p-2 font-semibold">${escapeHtml(marker)}</td>
                      <td class="border p-2 text-center">${escapeHtml(type)}</td>
                      <td class="border p-2 text-right font-bold">${Number(tx.amount||0).toLocaleString()}</td>
                      <td class="border p-2 text-center text-xs whitespace-nowrap">${formatDbUtcTime(tx.created_at)}</td>
                      <td class="border p-2 text-center text-xs whitespace-nowrap">${processedTime}</td>
                      <td class="border p-2 text-center font-semibold">${escapeHtml(who)}</td>
                      <td class="border p-2 text-center">${escapeHtml(where)}</td>
                      <td class="border p-2 text-center">${escapeHtml(tx.status||'-')}</td>
                      <td class="border p-2 text-center whitespace-nowrap">${tx.status==='Pending'
                        ? `<button type="button" data-tx-action="Approved" data-tx-id="${Number(tx.id)}" class="tx-action bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded text-xs mr-1">Approve</button><button type="button" data-tx-action="Rejected" data-tx-id="${Number(tx.id)}" class="tx-action bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded text-xs">Reject</button>`
                        : '-'}</td>
                    </tr>`;
                });
            }).catch(e=>{
                document.getElementById('transaction-list').innerHTML='<tr><td colspan="10" class="border p-4 text-center text-red-600">Failed to load transactions</td></tr>';
            });
        }

        async function actionTx(transaction_id, status, buttonEl) {
            const row = buttonEl?.closest('tr');
            const buttons = row ? row.querySelectorAll('.tx-action') : [];
            buttons.forEach(b => { b.disabled = true; b.dataset.busy = '1'; });
            try {
                const r = await fetch('/api/admin/transactions/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transaction_id: Number(transaction_id), status })
                });
                const text = await r.text();
                let data = {};
                try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
                if (!r.ok || !data.success) throw new Error(data.message || data.error || 'Transaction action failed');
                loadTransactions();
                if (typeof loadLedger === 'function') loadLedger();
            } catch (err) {
                buttons.forEach(b => { b.disabled = false; delete b.dataset.busy; });
                alert(err.message || 'Transaction action failed');
            }
        }

        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.tx-action');
            if (!btn || btn.dataset.busy === '1') return;
            const status = btn.dataset.txAction;
            const id = Number(btn.dataset.txId);
            if (!Number.isFinite(id) || !status) return;
            const actionText = status === 'Approved' ? 'approve' : 'reject';
            if (!confirm(`Are you sure you want to ${actionText} this transaction?`)) return;
            actionTx(id, status, btn);
        });

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

        let adminNotifications = [];
        let adminPreviousUnread = 0;
        let adminInitialNotificationsLoaded = false;
        let adminToastTimer = null;
        function showAdminToast(message){ const el=document.getElementById('admin-toast'); if(!el)return; el.textContent=message; el.classList.add('show'); clearTimeout(adminToastTimer); adminToastTimer=setTimeout(()=>el.classList.remove('show'),6000); }
        function toggleAdminNotifications(){
            const p=document.getElementById('admin-notification-panel'); if(!p)return; p.classList.toggle('hidden'); if(!p.classList.contains('hidden')) loadAdminNotifications();
        }
        async function loadAdminNotifications(){
            try{
                const r=await fetch('/api/admin/notifications',{cache:'no-store'}); const d=await r.json(); if(!r.ok||!d.success)return;
                adminNotifications=d.data||[]; const unread=Number(d.unread||0); const badge=document.getElementById('admin-notification-badge');
                if(badge){badge.textContent=String(unread);badge.classList.toggle('hidden',!(unread>0));}
                if(adminInitialNotificationsLoaded && unread>adminPreviousUnread){ const newest=adminNotifications.find(x=>Number(x.is_read)===0); if(newest) showAdminToast(`${newest.title}: ${newest.message}`); }
                adminPreviousUnread=unread; adminInitialNotificationsLoaded=true;
                const list=document.getElementById('admin-notification-list'); if(!list)return;
                list.innerHTML=adminNotifications.length?adminNotifications.map(n=>`<button type="button" onclick="readAdminNotification(${Number(n.id)})" class="w-full text-left notif-item ${Number(n.is_read)?'':'notif-unread'}"><div class="font-bold text-sm text-slate-800">${escapeHtml(n.title)}</div><div class="text-xs text-slate-600 mt-1">${escapeHtml(n.message)}</div><div class="notif-meta">${escapeHtml(formatDbUtcTime(n.created_at))}</div></button>`).join(''):'<div class="p-6 text-center text-sm text-slate-400">No notifications</div>';
            }catch(e){}
        }
        async function readAdminNotification(id){try{await fetch(`/api/admin/notifications/${id}/read`,{method:'POST'});}catch(_){} loadAdminNotifications(); if(typeof loadTransactions==='function')loadTransactions();}
        async function markAllAdminNotificationsRead(){try{await fetch('/api/admin/notifications/read-all',{method:'POST'});}catch(_){} loadAdminNotifications();}

        let adminServerClockOffsetMs = 0;
        let adminClockSyncInFlight = false;
        function adminNowMs(){ return Date.now() + adminServerClockOffsetMs; }
        function renderAdminDashboardClock(){
            const ms = adminNowMs();
            const dateEl = document.getElementById('dashboard-clock-date');
            const timeEl = document.getElementById('dashboard-clock-time');
            if(!dateEl || !timeEl) return;
            const d = new Date(ms);
            dateEl.textContent = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Yangon',weekday:'short',month:'short',day:'2-digit',year:'numeric'}).format(d) + ' • GMT+6:30';
            timeEl.textContent = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Yangon',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}).format(d);
        }
        async function syncAdminClock(){
            if(adminClockSyncInFlight) return;
            adminClockSyncInFlight = true;
            try{
                const t0=Date.now(); const r=await fetch('/api/time',{cache:'no-store'}); const t1=Date.now();
                const d=await r.json();
                if(r.ok && d.success && Number.isFinite(Number(d.server_now_ms))) adminServerClockOffsetMs = Number(d.server_now_ms) - Math.round((t0+t1)/2);
            }catch(_){ }
            finally{ adminClockSyncInFlight=false; renderAdminDashboardClock(); }
        }
        function startAdminDashboardClock(){
            clearInterval(window.__adminDashboardClockTimer);
            clearInterval(window.__adminDashboardSyncTimer);
            renderAdminDashboardClock();
            window.__adminDashboardClockTimer = setInterval(renderAdminDashboardClock,1000);
            window.__adminDashboardSyncTimer = setInterval(syncAdminClock,30000);
            syncAdminClock();
        }
        async function loadDashboard(){ const r=await fetch('/api/admin/dashboard'),d=await r.json(); if(!d.success)return; const f=n=>Number(n||0).toLocaleString(); document.getElementById('dash-stake').textContent=f(d.total_stake); document.getElementById('dash-payout').textContent=f(d.total_payout); document.getElementById('dash-pl').textContent=f(d.net_pl); document.getElementById('dash-open').textContent=Number(d.open_matches||0).toLocaleString(); startAdminDashboardClock(); }
        let currentReportPayload = null;
        let currentReportHeaders = [];
        let currentReportRows = [];

        function ygnLocalDateIso(dateObj=new Date()) {
            return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Yangon', year:'numeric', month:'2-digit', day:'2-digit'}).format(dateObj);
        }
        function shiftYgnDate(days){
            const parts=ygnLocalDateIso().split('-').map(Number);
            const d=new Date(Date.UTC(parts[0],parts[1]-1,parts[2],12));
            d.setUTCDate(d.getUTCDate()+days);
            return d.toISOString().slice(0,10);
        }
        function setReportRange(kind){
            const today=ygnLocalDateIso();
            document.getElementById('report-to').value=today;
            document.getElementById('report-from').value=kind==='today'?today:(kind==='7d'?shiftYgnDate(-6):shiftYgnDate(-29));
            loadReports();
        }
        async function initReportFilters(){
            const today=ygnLocalDateIso();
            const from=document.getElementById('report-from'),to=document.getElementById('report-to');
            if(from && !from.value) from.value=today;
            if(to && !to.value) to.value=today;
            try{
                const [ur,mr]=await Promise.all([fetch('/api/admin/users'),fetch('/api/matches')]);
                const ud=await ur.json(), md=await mr.json();
                const users=(ud.data||ud||[]).filter(u=>u.role==='user' || !u.role);
                const us=document.getElementById('report-marker');
                if(us && !us.dataset.loaded){us.innerHTML='<option value="">All Markers</option>'+users.map(u=>`<option value="${escapeHtml(String(u.username))}">${escapeHtml(String(u.username))}</option>`).join('');us.dataset.loaded='1';}
                const matches=md.data||md||[]; const ms=document.getElementById('report-match');
                if(ms && !ms.dataset.loaded){ms.innerHTML='<option value="">All Matches</option>'+matches.map(m=>`<option value="${escapeHtml(String(m.id))}">${escapeHtml(String(m.custom_match_id||m.id))} — ${escapeHtml(String(m.match_name||''))}</option>`).join('');ms.dataset.loaded='1';}
            }catch(e){console.error('Report filters:',e);}
        }
        async function loadReports(){
            try{
                await initReportFilters();
                const params=new URLSearchParams();
                ['from','to','marker','match','type'].forEach(k=>{const el=document.getElementById(`report-${k}`); if(el&&el.value) params.set(k,el.value);});
                const r=await fetch('/api/admin/reports?'+params.toString()); const d=await r.json();
                if(!r.ok||!d.success)throw new Error(d.message||d.error||'Failed to load reports');
                currentReportPayload=d; renderReportFromLoaded();
            }catch(e){document.getElementById('report-status').textContent=e.message||'Failed to load reports';document.getElementById('report-table').innerHTML='<tbody><tr><td class="border p-5 text-center text-red-600">Failed to load reports</td></tr></tbody>';}
        }
        function renderReportFromLoaded(){
            const d=currentReportPayload; if(!d)return;
            const type=document.getElementById('report-type')?.value||d.type||'summary';
            const fmt=n=>Number(n||0).toLocaleString();
            const sc=document.getElementById('report-summary-cards');
            const s=d.summary||{};
            const cards=type==='summary'
                ? [['Total Bets',fmt(s.total_bets)],['Total Stake',fmt(s.total_stake)],['Settled Stake',fmt(s.settled_stake)],['Total Payout',fmt(s.total_payout)],['Admin Net P/L',fmt(s.admin_net_pl)]]
                : type==='transactions'
                ? [['Transactions',fmt(s.tx_count)],['Approved',fmt(s.tx_approved)],['Rejected',fmt(s.tx_rejected)],['Pending',fmt(s.tx_pending)],['Amount',fmt(s.tx_amount)]]
                : [['Total Bets',fmt(s.total_bets)],['Total Stake',fmt(s.total_stake)],['Settled Stake',fmt(s.settled_stake)],['Total Payout',fmt(s.total_payout)],['Admin Net P/L',fmt(s.admin_net_pl)]];
            sc.innerHTML=cards.map(c=>`<div class="bg-slate-50 border rounded-xl p-4"><div class="text-[11px] uppercase font-bold tracking-wide text-slate-400">${escapeHtml(c[0])}</div><div class="text-xl font-extrabold mt-2 text-slate-800">${escapeHtml(c[1])}</div></div>`).join('');
            const table=d.tables?.[type]||{headers:[],rows:[]}; currentReportHeaders=table.headers||[]; currentReportRows=table.rows||[];
            const html='<thead><tr class="bg-gray-100 text-gray-700">'+currentReportHeaders.map(h=>`<th class="border p-2.5 text-center">${escapeHtml(h)}</th>`).join('')+'</tr></thead><tbody>'+(currentReportRows.length?currentReportRows.map(row=>'<tr>'+row.map((v,i)=>`<td class="border p-2.5 ${i>0?'text-right':''}">${escapeHtml(v==null?'':String(v))}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${Math.max(1,currentReportHeaders.length)}" class="border p-5 text-center text-slate-500">No report data</td></tr>`)+ '</tbody>';
            document.getElementById('report-table').innerHTML=html;
            document.getElementById('report-status').textContent=`${d.from} → ${d.to} • ${d.timezone} • ${type}`;
        }
        function exportCurrentReportCsv(){
            if(!currentReportHeaders.length)return alert('Load a report first.');
            const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
            const csv=[currentReportHeaders,currentReportRows,...[]].map(row=>row.map(esc).join(',')).join('\n');
            const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');
            a.href=url;a.download=`STT_Report_${document.getElementById('report-type')?.value||'summary'}_${ygnLocalDateIso()}.csv`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
        }

        async function loadLedger(){
            try{
                const marker=document.getElementById('ledger-marker-filter')?.value||'';
                const type=document.getElementById('ledger-type-filter')?.value||'';
                const direction=document.getElementById('ledger-direction-filter')?.value||'';
                const q=document.getElementById('ledger-search')?.value?.trim()||'';
                const params=new URLSearchParams(); if(marker)params.set('marker',marker); if(type)params.set('type',type); if(direction)params.set('direction',direction); if(q)params.set('q',q);
                const r=await fetch('/api/admin/ledger?'+params.toString()); const d=await r.json(); if(!d.success)throw new Error(d.error||'Failed to load ledger');
                const f=n=>Number(n||0).toLocaleString();
                document.getElementById('ledger-balance').textContent=f(d.summary?.balance);
                document.getElementById('ledger-in').textContent=f(d.summary?.total_in);
                document.getElementById('ledger-out').textContent=f(d.summary?.total_out);
                document.getElementById('ledger-count').textContent=f(d.summary?.entries);
                const list=d.data||[], tbody=document.getElementById('ledger-list'); tbody.innerHTML='';
                list.forEach((x,i)=>{
                    const dir=String(x.direction||'').toUpperCase();
                    const amount=f(x.amount);
                    tbody.innerHTML+=`<tr class="hover:bg-slate-50"><td class="border p-2 text-center">${list.length-i}</td><td class="border p-2 whitespace-nowrap text-xs">${formatDbUtcTime(x.created_at)}</td><td class="border p-2 font-semibold">${escapeHtml(x.entry_type||'-')}</td><td class="border p-2">${escapeHtml(x.username||'-')}</td><td class="border p-2 text-right font-bold">${amount}</td><td class="border p-2 text-center font-bold ${dir==='IN'?'text-emerald-600':'text-rose-600'}">${escapeHtml(dir||'-')}</td><td class="border p-2 text-right font-semibold">${f(x.running_balance)}</td><td class="border p-2 text-center">${escapeHtml(x.reference_type||'-')} #${escapeHtml(x.reference_id||'-')}</td><td class="border p-2">${escapeHtml(x.reason||'-')}</td><td class="border p-2">${escapeHtml(x.processed_by||'-')}</td></tr>`;
                });
                if(!list.length)tbody.innerHTML='<tr><td colspan="10" class="border p-4 text-center text-slate-500">No ledger entries</td></tr>';
                if(!document.getElementById('ledger-marker-filter')?.dataset.loaded){
                    const markerSelect=document.getElementById('ledger-marker-filter');
                    if(markerSelect){
                        const markers=[...new Set(list.map(x=>x.username).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b)));
                        markerSelect.innerHTML='<option value="">All Markers</option>'+markers.map(m=>`<option value="${escapeHtml(String(m))}">${escapeHtml(String(m))}</option>`).join(''); markerSelect.dataset.loaded='1';
                    }
                    const typeSelect=document.getElementById('ledger-type-filter');
                    if(typeSelect){const types=[...new Set(list.map(x=>x.entry_type).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b))); typeSelect.innerHTML='<option value="">All Types</option>'+types.map(t=>`<option value="${escapeHtml(String(t))}">${escapeHtml(String(t))}</option>`).join('');}
                }
            }catch(e){
                document.getElementById('ledger-list').innerHTML='<tr><td colspan="10" class="border p-4 text-center text-red-600">Failed to load ledger</td></tr>';
            }
        }

async function setMatchLock(id,minutes){ try{ const r=await fetch(`/api/admin/matches/${id}/lock`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lock_minutes:String(minutes)})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.success){alert(d.message||'Lock update failed');return;} loadMatches(); }catch(e){alert('Lock update failed: '+e.message);} }
        async function showOddsHistory(id){ const r=await fetch(`/api/admin/odds-history/${id}`),d=await r.json(); const rows=d.data||[]; alert(rows.length?rows.map(x=>`${x.changed_at} | Body ${x.body_odds} | O/U ${x.goal_odds} | By ${x.changed_by||'-'}`).join('\n'):'No odds history'); }
        function openResultModalByMatchId(id){ const idx=allMatches.findIndex(m=>Number(m.id)===Number(id)); if(idx>=0)openResultModalByIndex(idx); }
        let lastSettlementPreview = null;
        async function previewSettlement(){
            // The result modal select stores the match's array index, not its database ID.
            // Resolve by index so opening settlement from Final Score Manager previews the intended match.
            const selectedIndex = Number.parseInt(document.getElementById('modal-match-select').value, 10);
            const match = Number.isInteger(selectedIndex) ? allMatches[selectedIndex] : null;
            const match_id = match?.custom_match_id || match?.id || currentActiveMatchId;
            const hs=Number(document.getElementById('home-score').value),as=Number(document.getElementById('away-score').value);
            if(!match_id)return alert('Select a match first.');
            if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return alert('Enter a valid final score.');
            if(match && ['cancelled','postponed','settled'].includes(String(match.status||'').trim().toLowerCase()))return alert(`Settlement is not available for ${match.status}.`);
            const btn=document.getElementById('settlement-preview-btn'); if(btn){btn.disabled=true;btn.textContent='Loading Preview...';}
            try{
                const r=await fetch('/api/admin/settlement/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id,home_score:hs,away_score:as})});
                const d=await r.json();
                if(!r.ok||!d.success)throw new Error(d.message||'Preview failed');
                lastSettlementPreview={match_id,home_score:hs,away_score:as,data:d};
                const s=d.summary||{},f=n=>Number(n||0).toLocaleString();
                const title=`${d.match?.custom_match_id||d.match?.id||'-'} — ${d.match?.match_name||'Match'}`;
                document.getElementById('settlement-preview-title').textContent=title;
                document.getElementById('settlement-preview-meta-modal').textContent=`Score ${hs} - ${as} • Kickoff ${formatMyanmarTime(d.match?.match_time)}`;
                const map={
                    'modal-settle-sum-bets':s.bets,'modal-settle-sum-stake':s.stake,'modal-settle-sum-won':s.won,
                    'modal-settle-sum-lost':s.lost,'modal-settle-sum-payout':s.payout,'modal-settle-sum-pl':s.admin_pl
                };
                Object.entries(map).forEach(([id,v])=>document.getElementById(id).textContent=f(v));
                const rows=d.data||[], tbody=document.getElementById('settlement-preview-list-modal'); tbody.innerHTML='';
                rows.forEach(x=>{const o=x.outcome||{}, cls=Number(o.winFactor||0)>0?'bg-emerald-950/20':Number(o.winFactor||0)<0?'bg-rose-950/20':'bg-slate-900/20'; tbody.innerHTML+=`<tr class="${cls}"><td class="border border-slate-700 p-2">${escapeHtml(x.username||'-')}</td><td class="border border-slate-700 p-2 text-center">${escapeHtml(x.ticket_no||'-')}</td><td class="border border-slate-700 p-2">${escapeHtml(x.choice||'-')}</td><td class="border border-slate-700 p-2 text-center">${escapeHtml(x.odds_rate||'-')}</td><td class="border border-slate-700 p-2 text-right">${f(x.amount)}</td><td class="border border-slate-700 p-2 text-center font-semibold">${escapeHtml(o.status||'-')}</td><td class="border border-slate-700 p-2 text-right font-semibold">${f(o.returnAmount)}</td><td class="border border-slate-700 p-2 text-right">${f(o.netProfit)}</td></tr>`;});
                if(!rows.length)tbody.innerHTML='<tr><td colspan="8" class="border border-slate-700 p-5 text-center text-slate-400">No pending bets for this match.</td></tr>';
                setModalVisible('settlement-preview-modal',true);
                if(btn){btn.disabled=false;btn.classList.add('hidden');btn.textContent='Preview Settlement';}
            }catch(e){alert(e.message||'Preview failed');if(btn){btn.disabled=false;btn.textContent='Preview Settlement';}}
        }

        async function confirmSettlement(){
            if(!lastSettlementPreview)return alert('Preview the settlement first.');
            const p=lastSettlementPreview;
            const btn=document.getElementById('settlement-confirm-final-btn'); if(btn){btn.disabled=true;btn.textContent='Processing...';}
            try{
                const r=await fetch('/api/admin/settlement/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id:p.match_id,home_score:p.home_score,away_score:p.away_score})});
                const d=await r.json();
                if(!r.ok||!d.success)throw new Error(d.message||'Settlement failed');
                const finalScoreManagerIsOpen = !document.getElementById('page-final-scores')?.classList.contains('hidden');
                closeSettlementConfirm(); closeSettlementPreview(); closeResultModal(); loadResults(); loadLedger();
                if (finalScoreManagerIsOpen) loadFinalScoreManager();
                alert(`Settlement completed successfully.\n\nPayout: ${Number(d.summary?.payout||0).toLocaleString()}\nAdmin Net P/L: ${Number(d.summary?.admin_pl||0).toLocaleString()}`);
            }catch(e){alert(e.message||'Settlement failed');if(btn){btn.disabled=false;btn.textContent='Confirm';}}
        }

        // ================= RISK ================= //
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
        function copyRiskLayout(kind){if(!activeRiskPayload)return;const x=activeRiskPayload.layout_copy?.[kind];if(!x||Number(x.amount||0)<=0)return alert('ဒီဘက်မှာ Layout amount မရှိသေးပါ။');writeClipboard(`${x.label}, ${Number(x.amount||0).toLocaleString()}`);}
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

        // ================= SECURITY AUDIT LOG ================= //
        async function loadAuditLog(){
            const tbody=document.getElementById('audit-list'); const status=document.getElementById('audit-status');
            if(!tbody)return;
            tbody.innerHTML='<tr><td colspan="11" class="border p-5 text-center text-slate-500">Loading...</td></tr>';
            try{
                const p=new URLSearchParams();
                const ids=['audit-search','audit-user','audit-action','audit-device','audit-severity','audit-from','audit-to'];
                const keys=['q','user','action','device','severity','from','to'];
                ids.forEach((id,i)=>{const v=document.getElementById(id)?.value?.trim()||'';if(v)p.set(keys[i],v);});
                p.set('limit','500');
                const r=await fetch('/api/admin/audit-log?'+p.toString()); const d=await r.json();
                if(!r.ok||!d.success)throw new Error(d.error||'Failed to load audit log');
                const rows=d.data||[];
                const esc=escapeHtml;
                tbody.innerHTML=rows.map((x,i)=>{
                    const sev=String(x.severity||'INFO').toUpperCase();
                    const sevClass=sev==='CRITICAL'?'text-rose-700 font-bold':sev==='WARNING'?'text-amber-700 font-semibold':'text-slate-600';
                    return `<tr class="hover:bg-slate-50"><td class="border p-2 text-center">${rows.length-i}</td><td class="border p-2 whitespace-nowrap text-xs">${esc(formatDbUtcTime(x.created_at))}</td><td class="border p-2 font-semibold">${esc(x.username||'-')}</td><td class="border p-2 text-center">${esc(x.role||'-')}</td><td class="border p-2 font-mono text-xs">${esc(x.action||'-')}</td><td class="border p-2">${esc(x.module||'-')}</td><td class="border p-2">${esc(x.target||'-')}</td><td class="border p-2 max-w-[360px] truncate" title="${esc(x.details||'')}">${esc(x.details||'-')}</td><td class="border p-2 text-center ${sevClass}">${esc(sev)}</td><td class="border p-2 text-center">${esc(x.device||'-')}</td><td class="border p-2 text-xs">${esc(x.ip_address||'-')}</td></tr>`;
                }).join('');
                if(!rows.length)tbody.innerHTML='<tr><td colspan="11" class="border p-5 text-center text-slate-500">No audit activity found</td></tr>';
                if(status)status.textContent=`${rows.length.toLocaleString()} event(s) • Timezone: Asia/Yangon (GMT+6:30)`;
                const f=d.filters||{};
                const fill=(id,vals,label)=>{const el=document.getElementById(id);if(!el)return;const cur=el.value;el.innerHTML=`<option value="">${label}</option>`+(vals||[]).map(v=>`<option value="${esc(String(v))}">${esc(String(v))}</option>`).join('');if(cur)el.value=cur;};
                fill('audit-user',f.users,'All Users'); fill('audit-action',f.actions,'All Actions');
            }catch(e){
                tbody.innerHTML='<tr><td colspan="11" class="border p-5 text-center text-red-600">Failed to load audit log</td></tr>';
                if(status)status.textContent=e.message||'Audit log error';
            }
        }

        // ================= SYSTEM SETTINGS ================= //
        async function loadAdminSettings(){
            const status=document.getElementById('settings-status');
            try{
                const res=await fetch('/api/admin/settings');
                const d=await res.json();
                if(!res.ok||!d.success) throw new Error(d.error||d.message||'Failed to load settings');
                const x=d.data||{};
                document.getElementById('settings-global-lock').value=String(x.global_lock_minutes||15);
                document.getElementById('settings-late-enabled').checked=String(x.late_bet_cap_enabled||'0')==='1';
                document.getElementById('settings-late-amount').value=Number(x.late_bet_cap_amount||0);
                status.textContent='Loaded • Asia/Yangon (GMT+6:30)';
                status.className='text-sm font-bold text-emerald-600';
            }catch(e){ status.textContent=e.message||'Failed to load settings'; status.className='text-sm font-bold text-red-600'; }
        }
        async function saveAdminSettings(){
            const status=document.getElementById('settings-status');
            const body={
                global_lock_minutes:Number(document.getElementById('settings-global-lock').value),
                late_bet_cap_enabled:document.getElementById('settings-late-enabled').checked,
                late_bet_cap_amount:Number(document.getElementById('settings-late-amount').value||0)
            };
            status.textContent='Saving...'; status.className='text-sm font-bold text-amber-600';
            try{
                const res=await fetch('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
                const d=await res.json();
                if(!res.ok||!d.success) throw new Error(d.error||d.message||'Failed to save settings');
                status.textContent='Saved successfully'; status.className='text-sm font-bold text-emerald-600';
                if(typeof loadGlobalLock==='function') loadGlobalLock();
                if(typeof loadLateBetCap==='function') loadLateBetCap();
            }catch(e){status.textContent=e.message||'Failed to save settings';status.className='text-sm font-bold text-red-600';}
        }

        // ================= BACKUP / RESTORE ================= //
        function formatBackupSize(n){
            const x=Number(n||0); if(x<1024) return `${x} B`; if(x<1024*1024) return `${(x/1024).toFixed(1)} KB`; return `${(x/1024/1024).toFixed(2)} MB`;
        }
        function formatBackupTime(iso){
            if(!iso)return '-';
            return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Yangon',month:'short',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(iso))+' (GMT+6:30)';
        }
        async function loadBackups(){
            const tbody=document.getElementById('backup-list'); if(!tbody)return;
            tbody.innerHTML='<tr><td colspan="5" class="p-5 text-center text-slate-500">Loading...</td></tr>';
            try{
                const res=await fetch('/api/admin/backups'); const d=await res.json();
                if(!res.ok||!d.success) throw new Error(d.error||d.message||'Failed to load backups');
                tbody.innerHTML='';
                (d.data||[]).forEach((b,i)=>{
                    const tr=document.createElement('tr');
                    tr.innerHTML=`<td class="border p-2 text-center">${i+1}</td><td class="border p-2 font-semibold">${escapeHtml(b.name)}</td><td class="border p-2 text-center">${escapeHtml(formatBackupTime(b.created_at))}</td><td class="border p-2 text-right">${escapeHtml(formatBackupSize(b.size))}</td><td class="border p-2 text-center"><div class="flex justify-center gap-2"><button onclick="downloadBackup('${encodeURIComponent(b.name)}')" class="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-bold">Download</button><button onclick="restoreBackup('${encodeURIComponent(b.name)}')" class="px-3 py-1.5 rounded bg-rose-600 text-white text-xs font-bold">Restore</button></div></td>`;
                    tbody.appendChild(tr);
                });
                if(!(d.data||[]).length) tbody.innerHTML='<tr><td colspan="5" class="p-5 text-center text-slate-500">No backups yet.</td></tr>';
            }catch(e){tbody.innerHTML=`<tr><td colspan="5" class="p-5 text-center text-red-600">${escapeHtml(e.message||'Failed to load backups')}</td></tr>`;}
        }
        async function downloadBackup(encodedName){
            const name=decodeURIComponent(encodedName);
            try{
                const token=localStorage.getItem('adminAuthToken')||'';
                const res=await fetch(`/api/admin/backups/${encodeURIComponent(name)}/download`,{headers:{Authorization:`Bearer ${token}`}});
                if(!res.ok) throw new Error(`Download failed (${res.status})`);
                const blob=await res.blob();
                const url=URL.createObjectURL(blob);
                const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
            }catch(e){alert(e.message||'Download failed');}
        }

        async function createAdminBackup(){
            if(!confirm('Create a database backup now?'))return;
            try{
                const res=await fetch('/api/admin/backups',{method:'POST'}); const d=await res.json();
                if(!res.ok||!d.success) throw new Error(d.error||d.message||'Backup failed');
                alert(`Backup created successfully.\n\n${d.name}`); loadBackups();
            }catch(e){alert(e.message||'Backup failed');}
        }
        async function restoreBackup(encodedName){
            const name=decodeURIComponent(encodedName);
            if(!confirm(`Restore this backup?\n\n${name}\n\nThe current database will be replaced.`))return;
            try{
                const res=await fetch(`/api/admin/backups/${encodeURIComponent(name)}/restore`,{method:'POST'}); const d=await res.json();
                if(!res.ok||!d.success) throw new Error(d.error||d.message||'Restore failed');
                alert(`Database restored successfully.\n\nEmergency backup: ${d.emergency_backup||'-'}`);
                location.reload();
            }catch(e){alert(e.message||'Restore failed');}
        }

        // ================= RULES & REGULATIONS MANAGEMENT ================= //
async function loadCurrentRules() {
    try {
        const res = await fetch('/api/rules', { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Rules load failed');
        document.getElementById('rulesTextInput').value = data.rules || '';
        document.getElementById('rulesEnabledInput').checked = data.enabled !== false;
    } catch (err) {
        console.error('Failed to load rules:', err);
    }
}

document.getElementById('adminRulesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusMsg = document.getElementById('rulesStatusMsg');
    statusMsg.textContent = 'Saving...';
    statusMsg.className = 'text-sm font-bold text-yellow-600';
    try {
        const res = await fetch('/api/admin/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rules: document.getElementById('rulesTextInput').value,
                enabled: document.getElementById('rulesEnabledInput').checked
            })
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.message || 'Save failed');
        statusMsg.textContent = 'Rules saved successfully.';
        statusMsg.className = 'text-sm font-bold text-green-600';
    } catch (err) {
        console.error('Rules save error:', err);
        statusMsg.textContent = err.message || 'Save failed';
        statusMsg.className = 'text-sm font-bold text-red-600';
    }
});

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
        bindAddMatchPreviewEvents();
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
    
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const confirmModal=document.getElementById('settlement-confirm-modal');
            const previewModal=document.getElementById('settlement-preview-modal');
            if(confirmModal && !confirmModal.classList.contains('hidden')) return closeSettlementConfirm();
            if(previewModal && !previewModal.classList.contains('hidden')) return closeSettlementPreview();
            const resultModal=document.getElementById('result-modal');
            if(resultModal && !resultModal.classList.contains('hidden')) closeResultModal();
        });
        setInterval(loadAdminNotifications, 15000);
        document.addEventListener('click', e=>{ const p=document.getElementById('admin-notification-panel'); const b=e.target.closest('[onclick*=toggleAdminNotifications]'); if(p&&!b&&!p.contains(e.target)) p.classList.add('hidden'); });
