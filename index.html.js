

        const _nativeFetch = window.fetch.bind(window);
        window.fetch = function(input, init = {}) {
            const token = localStorage.getItem('authToken');
            const url = typeof input === 'string' ? input : input.url;
            if (token && String(url).startsWith('/api/')) {
                init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
            }
            return _nativeFetch(input, init).then(async res => {
                if ((res.status === 401 || res.status === 403) && token && !String(url).includes('/api/login')) {
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('currentUser');
                    if (typeof showLoginGate === 'function') showLoginGate();
                }
                return res;
            });
        };
        let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;
        let authToken = localStorage.getItem('authToken') || null;
        let placeBetModalInstance = null;
        let depositModalInstance = null;
        let withdrawModalInstance = null;

        const adminPaymentAccounts = {
            'KPay': { phone: '09791234567', name: 'KBZPay: Football Bet Admin' },
            'AYA Pay': { phone: '09798765432', name: 'AYA Pay: Football Bet Admin' }
        };

        document.addEventListener('DOMContentLoaded', () => {
            placeBetModalInstance = new bootstrap.Modal(document.getElementById('placeBetModal'));
            depositModalInstance = new bootstrap.Modal(document.getElementById('depositModal'));
            withdrawModalInstance = new bootstrap.Modal(document.getElementById('withdrawModal'));

            updateUserUI();
            updateDateTime();
            setInterval(updateDateTime, 1000);

            document.getElementById('loginForm').addEventListener('submit', handleLogin);
            document.getElementById('gateLoginForm').addEventListener('submit', handleGateLogin);
            if (currentUser && authToken) {
                fetch('/api/me').then(r => r.json().then(data => ({ok:r.ok, data}))).then(({ok, data}) => {
                    if (!ok || !data.success || data.user.role !== 'user') throw new Error('session');
                    currentUser = data.user;
                    authToken = data.token;
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    localStorage.setItem('authToken', authToken);
                    enterAuthenticatedView();
                }).catch(() => showLoginGate());
            } else {
                showLoginGate();
            }
            document.getElementById('betForm').addEventListener('submit', handlePlaceBet);
            document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
            document.getElementById('depositForm').addEventListener('submit', handleDepositSubmit);
            document.getElementById('withdrawForm').addEventListener('submit', handleWithdrawSubmit);
        });

        function updateDateTime() {
            const now = new Date();
            const el = document.getElementById('live-datetime');
            if (el) {
                el.innerText = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            }
        }

        function selectDepositPayment(method) {
            document.getElementById('depPaymentMethod').value = method;
            document.getElementById('optDepKPay').classList.toggle('active', method === 'KPay');
            document.getElementById('optDepAYAPay').classList.toggle('active', method === 'AYA Pay');

            const info = adminPaymentAccounts[method];
            document.getElementById('depPaymentTypeLabel').innerText = method;
            document.getElementById('depAdminPhone').innerText = info.phone;
            document.getElementById('depAdminName').innerText = `အကောင့်အမည်: ${info.name}`;
        }

        function selectWithdrawPayment(method) {
            document.getElementById('withPaymentMethod').value = method;
            document.getElementById('optWithKPay').classList.toggle('active', method === 'KPay');
            document.getElementById('optWithAYAPay').classList.toggle('active', method === 'AYA Pay');
        }

        async function handleDepositSubmit(e) {
            e.preventDefault();
            if (!currentUser) return;

            const payload = {
                username: currentUser.username,
                payment_method: document.getElementById('depPaymentMethod').value,
                amount: Number(document.getElementById('depAmount').value),
                transaction_id: document.getElementById('depTxnId').value
            };

            try {
                const res = await fetch('/api/user/deposit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();

                if (result.success) {
                    alert('ငွေသွင်းတောင်းဆိုမှု အောင်မြင်ပါသည်။ Admin စစ်ဆေးပြီးပါက Balance ဖြည့်ပေးပါမည်။');
                    depositModalInstance.hide();
                    document.getElementById('depositForm').reset();
                    loadTransactionStatement(true);
                } else {
                    alert(result.message || 'ငွေသွင်းတောင်းဆိုမှု မအောင်မြင်ပါ။');
                }
            } catch (err) {
                alert('Server အမှားအယွင်း ရှိနေပါသည်။');
            }
        }

        async function handleWithdrawSubmit(e) {
            e.preventDefault();
            if (!currentUser) return;

            const amount = Number(document.getElementById('withAmount').value);
            if (amount > currentUser.balance) {
                alert('ထုတ်ယူလိုသော ပမာဏသည် လက်ရှိ Balance ထက် ပိုများနေပါသည်။');
                return;
            }

            const payload = {
                username: currentUser.username,
                payment_method: document.getElementById('withPaymentMethod').value,
                account_name: document.getElementById('withAccountName').value,
                phone: document.getElementById('withPhone').value,
                amount: amount
            };

            try {
                const res = await fetch('/api/user/withdraw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();

                if (result.success) {
                    alert('ငွေထုတ်တောင်းဆိုမှု အောင်မြင်ပါသည်။ Admin စစ်ဆေးပြီး လွှဲပြောင်းပေးပါမည်။');
                    currentUser.balance -= amount;
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    updateUserUI();
                    withdrawModalInstance.hide();
                    document.getElementById('withdrawForm').reset();
                    loadTransactionStatement(true);
                } else {
                    alert(result.message || 'ငွေထုတ်တောင်းဆိုမှု မအောင်မြင်ပါ။');
                }
            } catch (err) {
                alert('Server အမှားအယွင်း ရှိနေပါသည်။');
            }
        }

        function startAutoRefresh() {
            setInterval(() => {
                const matchesTab = document.getElementById('pills-matches');
                if (matchesTab && matchesTab.classList.contains('show')) {
                    loadMatches(true);
                }
                const resultsTab = document.getElementById('pills-results');
                if (resultsTab && resultsTab.classList.contains('show')) {
                    loadResults(true);
                }

                if (currentUser) {
                    refreshUserBalance();
                    const historyTab = document.getElementById('pills-history');
                    if (historyTab && historyTab.classList.contains('show')) {
                        loadBetHistory(true);
                    }
                    const statementTab = document.getElementById('pills-statement');
                    if (statementTab && statementTab.classList.contains('show')) {
                        loadTransactionStatement(true);
                    }
                }
            }, 15000);
        }

        async function refreshUserBalance() {
            if (!currentUser) return;
            try {
                const res = await fetch(`/api/user/balance?username=${encodeURIComponent(currentUser.username)}`);
                const data = await res.json();
                if (data.success && data.balance !== undefined) {
                    currentUser.balance = data.balance;
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    document.getElementById('lblBalance').innerText = Number(currentUser.balance).toLocaleString();
                }
            } catch (err) {}
        }

        const MYANMAR_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;
        const DEFAULT_BET_LOCK_MINUTES = 15;

        function parseMyanmarTime(timeStr) {
            if (!timeStr) return 0;
            let raw = String(timeStr).trim().replace(' ', 'T');
            if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
                const t = new Date(raw).getTime();
                return Number.isNaN(t) ? 0 : t;
            }
            const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
            if (!m) {
                const t = new Date(raw).getTime();
                return Number.isNaN(t) ? 0 : t;
            }
            const [, y, mo, d, h, mi, sec='00'] = m;
            return Date.UTC(+y, +mo-1, +d, +h, +mi, +sec) - MYANMAR_OFFSET_MS;
        }

        function format12HourTime(timeStr) {
            const ms = parseMyanmarTime(timeStr);
            if (!ms) return timeStr || '-';
            return new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Yangon', month: 'short', day: 'numeric',
                year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
            }).format(new Date(ms));
        }

        function getMatchLockMinutes(match) {
            const n = Number(match?.betting_lock_minutes ?? match?.lock_minutes ?? match?.global_lock_minutes);
            return [2, 5, 10, 15].includes(n) ? n : DEFAULT_BET_LOCK_MINUTES;
        }

        function getBetLockAt(timeStr, lockMinutes = DEFAULT_BET_LOCK_MINUTES) {
            const kickoff = parseMyanmarTime(timeStr);
            const mins = Number(lockMinutes);
            return kickoff ? kickoff - ([2,5,10,15].includes(mins) ? mins : DEFAULT_BET_LOCK_MINUTES) * 60 * 1000 : 0;
        }

        function isBettingLocked(timeStr, lockMinutes = DEFAULT_BET_LOCK_MINUTES) {
            const lockAt = getBetLockAt(timeStr, lockMinutes);
            return lockAt > 0 && Date.now() >= lockAt;
        }

        function isKickoffPassed(timeStr) {
            const kickoff = parseMyanmarTime(timeStr);
            return kickoff > 0 && Date.now() >= kickoff;
        }

        function minutesToKickoff(timeStr) {
            const ms = parseMyanmarTime(timeStr);
            if (!ms) return null;
            return Math.ceil((ms - Date.now()) / 60000);
        }

        function updateUserUI() {
            if (currentUser) {
                document.getElementById('btnLoginModal').classList.add('d-none');
                document.getElementById('btnLogout').classList.remove('d-none');
                document.getElementById('lblUsername').innerText = currentUser.username;
                document.getElementById('lblBalance').innerText = Number(currentUser.balance || 0).toLocaleString();
                
                const nameParts = currentUser.username.trim().split(/\s+/);
                let initials = nameParts[0].substring(0, 2).toUpperCase();
                document.getElementById('userAvatar').innerText = initials;
            } else {
                document.getElementById('btnLoginModal').classList.remove('d-none');
                document.getElementById('btnLogout').classList.add('d-none');
            }
        }

        function showLoginGate() {
            document.body.classList.add('auth-required');
            document.getElementById('loginGate').style.display = 'flex';
        }

        function enterAuthenticatedView() {
            document.body.classList.remove('auth-required');
            document.getElementById('loginGate').style.display = 'none';
            updateUserUI();
            loadMatches();
            startAutoRefresh();
        }

        async function performLogin(username, password) {
            const res = await fetch('/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            return await res.json();
        }

        async function handleGateLogin(e) {
            e.preventDefault();
            const err = document.getElementById('gateError');
            err.textContent = '';
            try {
                const data = await performLogin(document.getElementById('gateUsername').value.trim(), document.getElementById('gatePassword').value);
                if (!data.success) { err.textContent = data.message || 'Login မှားယွင်းနေပါသည်။'; return; }
                currentUser = data.user;
                authToken = data.token;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                localStorage.setItem('authToken', authToken);
                enterAuthenticatedView();
                loadBetHistory();
                loadTransactionStatement();
            } catch (e) { err.textContent = 'Server ချိတ်ဆက်မှု အဆင်မပြေပါ။'; }
        }

        async function handleLogin(e) {
            e.preventDefault();
            const username = document.getElementById('loginUsername').value;
            const password = document.getElementById('loginPassword').value;

            try {
                const data = await performLogin(username, password);
                if (data.success) {
                    currentUser = data.user;
                    authToken = data.token;
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    localStorage.setItem('authToken', authToken);
                    updateUserUI();
                    bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide();
                    loadBetHistory();
                    loadTransactionStatement();
                } else {
                    alert(data.message || 'Login မှားယွင်းနေပါသည်။');
                }
            } catch (err) {
                alert('Server ချိတ်ဆက်မှု အဆင်မပြေပါ။');
            }
        }

        async function logout() {
            try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
            currentUser = null;
            authToken = null;
            localStorage.removeItem('currentUser');
            localStorage.removeItem('authToken');
            updateUserUI();
            showLoginGate();
            document.getElementById('betHistoryContainer').innerHTML = `
                <div class="text-center py-5"><p class="text-muted">လောင်းထားသော စာရင်းကြည့်ရန် Login ဝင်ပါ။</p></div>`;
            document.getElementById('statementContainer').innerHTML = `
                <div class="text-center py-5"><p class="text-muted">ငွေစာရင်းမှတ်တမ်း ကြည့်ရန် Login ဝင်ပါ။</p></div>`;
        }

        function populateLeagueFilter(matchesList) {
            const select = document.getElementById('leagueFilter');
            if (!select) return;
            const current = select.value || 'all';
            const leagues = [...new Set(matchesList.map(m => String(m.league || 'LEAGUE').trim()).filter(Boolean))]
                .sort((a,b) => a.localeCompare(b));
            select.innerHTML = '<option value="all">All Leagues</option>' +
                leagues.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
            if (leagues.includes(current)) select.value = current;
        }

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
        }

        function timeFilterMatch(match, filter) {
            if (filter === 'all') return true;
            const ms = parseMyanmarTime(match.match_time);
            if (!ms) return true;
            const now = Date.now();
            const diff = ms - now;
            if (filter === '30m') return diff >= 0 && diff <= 30 * 60 * 1000;
            if (filter === '1h') return diff >= 0 && diff <= 60 * 60 * 1000;
            if (filter === '3h') return diff >= 0 && diff <= 3 * 60 * 60 * 1000;
            if (filter === '6h') return diff >= 0 && diff <= 6 * 60 * 60 * 1000;
            if (filter === 'today') {
                const d = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Yangon', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms));
                const n = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Yangon', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
                return d === n;
            }
            return true;
        }

        function applyMatchFilters() {
            const all = window.__allMatches || [];
            const league = document.getElementById('leagueFilter')?.value || 'all';
            const time = document.getElementById('timeFilter')?.value || 'all';
            const filtered = all.filter(m => {
                if (isKickoffPassed(m.match_time)) return false;
                const l = String(m.league || 'LEAGUE').trim();
                return (league === 'all' || l === league) && timeFilterMatch(m, time);
            });
            renderMatches(filtered);
        }

        function renderMatches(matchesList) {
            const container = document.getElementById('matchesContainer');
            const countEl = document.getElementById('matchCount');
            if (countEl) countEl.textContent = `${matchesList.length} match${matchesList.length === 1 ? '' : 'es'}`;
            if (!matchesList.length) {
                container.innerHTML = `<div class="text-center py-5 text-muted">ရွေးထားသော filter အတိုင်း ပွဲစဉ်မရှိပါ။</div>`;
                return;
            }

            const newHtml = matchesList.map(m => {
                const teams = (m.match_name || '').split(/\s+vs\s+/i);
                const homeTeam = teams[0] ? teams[0].trim() : 'Home';
                const awayTeam = teams[1] ? teams[1].trim() : 'Away';
                const kickoffMs = parseMyanmarTime(m.match_time);
                const expired = kickoffMs > 0 && Date.now() >= kickoffMs;
                const lockMinutes = getMatchLockMinutes(m);
                const lockedByTime = m.betting_open === false || isBettingLocked(m.match_time, lockMinutes);
                const isClosed = (m.status !== 'Open') || expired || lockedByTime;
                const mins = minutesToKickoff(m.match_time);
                let statusText = 'Open';
                if (expired) statusText = 'Time Over';
                else if (m.status !== 'Open') statusText = m.status || 'Closed';
                else if (lockedByTime) statusText = 'Betting Closed';
                const statusClass = isClosed ? 'closed' : 'open';
                const lockInfo = !expired && mins !== null && mins <= lockMinutes
                    ? `ပွဲစရန် ${Math.max(mins, 0)} မိနစ် — ${lockMinutes} မိနစ် lock` : '';
                const disabledClass = isClosed ? 'compact-disabled' : '';
                const matchId = String(m.custom_match_id || m.id);
                const matchName = String(m.match_name || '');
                const bodyOdds = String(m.body_odds || '0=');
                const goalOdds = String(m.goal_odds || '0=');
                const clickHome = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Body", ${JSON.stringify(homeTeam)}, ${JSON.stringify(bodyOdds)})'`;
                const clickAway = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Body", ${JSON.stringify(awayTeam)}, ${JSON.stringify(bodyOdds)})'`;
                const clickOver = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Goal", "Over", ${JSON.stringify(goalOdds)})'`;
                const clickUnder = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Goal", "Under", ${JSON.stringify(goalOdds)})'`;
                return `
                    <div class="col-12 col-md-6 col-lg-4">
                        <div class="match-compact h-100">
                            <div class="match-meta">
                                <div class="match-meta-left">
                                    <span class="match-id">#${escapeHtml(matchId)}</span>
                                    <span class="match-league" title="${escapeHtml(m.league || 'LEAGUE')}">${escapeHtml(m.league || 'LEAGUE')}</span>
                                </div>
                                <span class="match-status ${statusClass}">${escapeHtml(statusText)}</span>
                            </div>
                            <div class="team-vs-row">
                                <button type="button" class="team-btn home ${disabledClass}" ${clickHome} title="${escapeHtml(homeTeam)}">${escapeHtml(homeTeam)}</button>
                                <span class="vs-mark">VS</span>
                                <button type="button" class="team-btn away ${disabledClass}" ${clickAway} title="${escapeHtml(awayTeam)}">${escapeHtml(awayTeam)}</button>
                            </div>
                            <div class="market-grid">
                                <button type="button" class="market-btn over ${disabledClass}" ${clickOver}>
                                    <span class="market-label">Over</span><span class="market-odds">${escapeHtml(goalOdds)}</span>
                                </button>
                                <button type="button" class="market-btn under ${disabledClass}" ${clickUnder}>
                                    <span class="market-label">Under</span><span class="market-odds">${escapeHtml(goalOdds)}</span>
                                </button>
                            </div>
                            <div class="d-flex justify-content-between align-items-center mt-2">
                                <span class="odds-summary body-summary">BODY <b>${escapeHtml(bodyOdds)}</b></span>
                                <span class="match-time"><i class="bi bi-clock me-1"></i>${format12HourTime(m.match_time)}</span>
                                <span class="odds-summary ou-summary">O/U <b>${escapeHtml(goalOdds)}</b></span>
                            </div>
                            ${lockInfo ? `<div class="match-lock-note"><i class="bi bi-lock-fill me-1"></i>${escapeHtml(lockInfo)}</div>` : ''}
                        </div>
                    </div>`;
            }).join('');
            container.innerHTML = newHtml;
        }

        async function loadMatches(isSilent = false) {
            const container = document.getElementById('matchesContainer');
            try {
                const res = await fetch('/api/matches');
                const result = await res.json();
                const matchesList = Array.isArray(result) ? result : (result.data || []);
                window.__allMatches = matchesList;
                window.__matchesById = {};
                matchesList.forEach(m => {
                    window.__matchesById[String(m.id)] = m;
                    if (m.custom_match_id !== undefined) window.__matchesById[String(m.custom_match_id)] = m;
                });
                populateLeagueFilter(matchesList);
                applyMatchFilters();
                if (matchesList.length === 0 && !isSilent) {
                    container.innerHTML = `<div class="text-center py-5 text-muted">ဖွင့်ထားသော ပွဲစဉ်များ မရှိသေးပါ။</div>`;
                }
            } catch (err) {
                console.error('Matches fetch error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">ပွဲစဉ်များ ရယူရာတွင် အမှားအယွင်းရှိနေပါသည်။</div>`;
            }
        }

        function openBetModal(matchId, matchName, betType, choice, oddsRate) {
            const cachedMatch = window.__matchesById ? window.__matchesById[String(matchId)] : null;
            if (cachedMatch && (cachedMatch.betting_open === false || isBettingLocked(cachedMatch.match_time, getMatchLockMinutes(cachedMatch)))) {
                alert(`ပွဲစမည့်အချိန်မတိုင်မီ ${getMatchLockMinutes(cachedMatch)} မိနစ်အလိုမှ လောင်းကြေးပိတ်ထားပါသည်။`);
                return;
            }
            if (!currentUser) {
                alert('လောင်းကြေးထပ်ရန် ဦးစွာ Login ဝင်ပါ။');
                new bootstrap.Modal(document.getElementById('loginModal')).show();
                return;
            }

            document.getElementById('modalMatchId').value = matchId;
            document.getElementById('modalMatchName').value = matchName;
            document.getElementById('modalBetType').value = betType;
            document.getElementById('modalChoice').value = choice;
            document.getElementById('modalOddsRate').value = oddsRate;

            document.getElementById('modalMatchTitle').innerText = matchName;
            document.getElementById('modalBetTypeLabel').innerText = betType;
            
            const choiceLabel = document.getElementById('modalChoiceLabel');
            choiceLabel.innerText = choice;
            if (choice === 'Over' || choice.includes('Over')) {
                choiceLabel.className = 'fw-bold text-danger';
            } else if (choice === 'Under' || choice.includes('Under')) {
                choiceLabel.className = 'fw-bold text-dark';
            } else {
                choiceLabel.className = 'fw-bold text-primary';
            }

            document.getElementById('modalOddsLabel').innerText = oddsRate;
            document.getElementById('betAmount').value = '';

            placeBetModalInstance.show();
        }

        async function handleChangePassword(e) {
            e.preventDefault();
            if (!currentUser) return;

            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newUserPassword').value;
            const confirmPassword = document.getElementById('confirmUserPassword').value;

            if (newPassword.length < 6) return alert('Password အသစ်သည် အနည်းဆုံး 6 လုံးရှိရပါမည်။');
            if (newPassword !== confirmPassword) return alert('Password အသစ်နှစ်ခု မတူပါ။');

            try {
                const res = await fetch('/api/user/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: currentUser.username,
                        current_password: currentPassword,
                        new_password: newPassword
                    })
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok || !result.success) {
                    return alert(result.message || 'Password ပြောင်း၍မရပါ။');
                }

                alert('Password ပြောင်းပြီးပါပြီ။ Login ပြန်ဝင်ပါ။');
                document.getElementById('changePasswordForm').reset();
                bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'))?.hide();
                await logout();
            } catch (err) {
                console.error('Change password error:', err);
                alert('Server အမှားအယွင်း ရှိနေပါသည်။');
            }
        }

        async function handlePlaceBet(e) {
            e.preventDefault();
            const submitBtn = e.submitter || document.querySelector('#betForm button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;
            const amount = Number(document.getElementById('betAmount').value);

            if (!Number.isFinite(amount) || amount <= 0) {
                alert('ထိုးငွေ ပမာဏ မှန်ကန်စွာ ထည့်ပါ။');
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            if (amount > currentUser.balance) {
                alert('လက်ကျန်ငွေ မလုံလောက်ပါ။');
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            const payload = {
                username: currentUser.username,
                match_id: document.getElementById('modalMatchId').value,
                match_name: document.getElementById('modalMatchName').value,
                bet_type: document.getElementById('modalBetType').value,
                choice: document.getElementById('modalChoice').value,
                amount: amount,
                odds_rate: document.getElementById('modalOddsRate').value
            };

            // Second confirmation: the first confirmation is the bet modal itself.
            const confirmMessage = [
                'လောင်းကြေးကို နောက်တစ်ကြိမ် အတည်ပြုပါ။',
                '',
                `ပွဲစဉ်: ${payload.match_name}`,
                `Market: ${payload.bet_type}`,
                `ရွေးချယ်မှု: ${payload.choice}`,
                `ကြေး: ${payload.odds_rate}`,
                `ထိုးငွေ: ${amount.toLocaleString()} Kyats`,
                '',
                'ဤလောင်းကြေးကို တင်ရန် သေချာပါသလား?'
            ].join('\n');
            if (!window.confirm(confirmMessage)) {
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            try {
                const res = await fetch('/api/user/place-bet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();

                if (result.success) {
                    alert('လောင်းကြေး အောင်မြင်စွာ တင်ပြီးပါပြီ။');
                    currentUser.balance -= amount;
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    updateUserUI();
                    placeBetModalInstance.hide();
                    loadBetHistory(true);
                    loadTransactionStatement(true);
                } else {
                    alert(result.message || 'လောင်းကြေး တင်၍မရပါ။');
                }
            } catch (err) {
                alert('Server အမှားအယွင်း ရှိနေပါသည်။');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        }

        function getBetSummary(bet) {
            const amount = Number(bet.amount) || 0;
            const status = bet.status || 'Pending';

            if (status === 'Pending') {
                return {
                    statusBadge: `<span class="badge bg-warning text-dark px-3 py-1 fw-bold"><i class="bi bi-hourglass-split"></i> PENDING</span>`,
                    returnAmount: 0,
                    netProfitOrLoss: 0,
                    profitFormatted: `-`
                };
            }

            let winFactor = 0;
            if (status === 'Won') winFactor = 1.0;
            else if (status === 'Half Won') winFactor = 0.5;
            else if (status === 'Draw') winFactor = 0.0;
            else if (status === 'Half Lost') winFactor = -0.5;
            else if (status === 'Lost') winFactor = -1.0;

            let returnAmount = Number.isFinite(Number(bet.payout)) && Number(bet.payout) > 0 ? Number(bet.payout) : 0;
            if (!returnAmount) {
                if (winFactor > 0) {
                    const grossProfit = amount * winFactor;
                    const commission = grossProfit * 0.05;
                    returnAmount = amount + Math.floor(grossProfit - commission);
                } else if (winFactor === 0) {
                    returnAmount = amount;
                } else {
                    returnAmount = Math.floor(amount * (1 + winFactor));
                }
            }

            const netProfitOrLoss = Number.isFinite(Number(bet.net_profit)) && Number(bet.net_profit) !== 0
                ? Number(bet.net_profit)
                : returnAmount - amount;

            let badgeClass = 'bg-danger';
            let profitFormatted = `${netProfitOrLoss.toLocaleString()} Kyats`;

            if (netProfitOrLoss > 0) {
                badgeClass = 'bg-success';
                profitFormatted = `+${netProfitOrLoss.toLocaleString()} Kyats`;
            } else if (netProfitOrLoss === 0) {
                badgeClass = 'bg-secondary';
                profitFormatted = `0 Kyats`;
            }

            return {
                statusBadge: `<span class="badge ${badgeClass} px-3 py-1 fw-bold">${status.toUpperCase()}</span>`,
                returnAmount,
                netProfitOrLoss,
                profitFormatted
            };
        }

        async function loadResults(isSilent = false) {
            const container = document.getElementById('resultsContainer');
            if (!container) return;
            try {
                const res = await fetch('/api/matches', { cache: 'no-store' });
                const raw = await res.json();
                const matches = Array.isArray(raw) ? raw : (raw?.data || []);
                const finished = matches.filter(m => m.home_score !== null && m.home_score !== undefined && m.away_score !== null && m.away_score !== undefined)
                    .sort((a,b) => (parseMyanmarTime(b.match_time) || 0) - (parseMyanmarTime(a.match_time) || 0));

                if (!finished.length) {
                    if (!isSilent) container.innerHTML = `<div class="col-12 text-center py-5 text-muted"><i class="bi bi-trophy fs-1 d-block mb-2"></i>No results yet.</div>`;
                    return;
                }
                container.innerHTML = finished.map(m => `
                    <div class="col-12 col-lg-8 mx-auto mb-2">
                        <div class="card statement-card shadow-sm">
                            <div class="card-body p-3">
                                <div class="d-flex justify-content-between align-items-center mb-2">
                                    <span class="small text-muted fw-semibold">Match #${m.custom_match_id || m.id}</span>
                                    <span class="badge bg-dark">FINAL</span>
                                </div>
                                <div class="d-flex align-items-center justify-content-between gap-2">
                                    <div class="fw-bold text-dark flex-grow-1">${m.match_name || 'Match'}</div>
                                    <div class="fs-5 fw-bold text-primary">${m.home_score} - ${m.away_score}</div>
                                </div>
                                <div class="small text-muted mt-2">${format12HourTime(m.match_time)}</div>
                            </div>
                        </div>
                    </div>`).join('');
            } catch (err) {
                console.error('Results load error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">Results ရယူရာတွင် အမှားအယွင်းရှိနေပါသည်။</div>`;
            }
        }

        function loadProfile() {
            const container = document.getElementById('profileContainer');
            if (!container || !currentUser) return;
            container.innerHTML = `
                <div class="card border-0 shadow-sm">
                    <div class="card-body p-4">
                        <div class="d-flex align-items-center gap-3 mb-3">
                            <div class="avatar" style="width:52px;height:52px;flex:0 0 52px;">${(currentUser.username || 'U').slice(0,2).toUpperCase()}</div>
                            <div><div class="small text-muted">ACCOUNT</div><div class="fw-bold fs-5">${currentUser.username}</div></div>
                        </div>
                        <div class="profile-item"><span class="profile-label">Username</span><span class="profile-value">${currentUser.username}</span></div>
                        <div class="profile-item"><span class="profile-label">Balance</span><span class="profile-value text-success">${Number(currentUser.balance || 0).toLocaleString()} Kyats</span></div>
                        <div class="profile-item"><span class="profile-label">Account Status</span><span class="badge bg-success">${currentUser.status || 'Active'}</span></div>
                        <button class="btn btn-dark w-100 fw-bold mt-4" data-bs-toggle="modal" data-bs-target="#changePasswordModal"><i class="bi bi-key me-1"></i> Change Password</button>
                    </div>
                </div>`;
        }

        async function loadBetHistory(isSilent = false) {
            const container = document.getElementById('betHistoryContainer');
            if (!currentUser) {
                if (!isSilent) {
                    container.innerHTML = `<div class="text-center py-5 text-muted"><i class="bi bi-person-lock fs-1 d-block mb-2 text-secondary"></i>လောင်းထားသော စာရင်းကြည့်ရန် Login ဝင်ပါ။</div>`;
                }
                return;
            }

            try {
                let betsRes = await fetch(`/api/user/bets?username=${encodeURIComponent(currentUser.username)}`);
                if (!betsRes.ok) {
                    betsRes = await fetch(`/api/bets?username=${encodeURIComponent(currentUser.username)}`);
                }

                const matchesRes = await fetch('/api/matches');
                const betsRaw = await betsRes.json().catch(() => null);
                const matchesRaw = await matchesRes.json().catch(() => null);

                let betsArray = Array.isArray(betsRaw) ? betsRaw : (betsRaw?.data || betsRaw?.bets || []);
                const userBets = betsArray.filter(b => b.username === currentUser.username || !b.username);

                const matchMap = {};
                let matchesArray = Array.isArray(matchesRaw) ? matchesRaw : (matchesRaw?.data || []);
                matchesArray.forEach(m => {
                    if (m.id !== undefined) matchMap[String(m.id)] = m;
                    if (m.custom_match_id !== undefined) matchMap[String(m.custom_match_id)] = m;
                });

                if (userBets.length === 0) {
                    if (!isSilent) {
                        container.innerHTML = `
                            <div class="col-12 col-lg-8 mx-auto text-center py-5 text-muted">
                                <i class="bi bi-inbox fs-1 d-block mb-2 text-secondary"></i>
                                သင် လောင်းထားသော စာရင်း မရှိသေးပါ။
                            </div>`;
                    }
                    return;
                }

                let totalDeposit = 0, totalPayout = 0, totalProfit = 0;

                const cardsHtml = userBets.map((bet, idx) => {
                    const summary = getBetSummary(bet);
                    totalDeposit += Number(bet.amount) || 0;
                    totalPayout += summary.returnAmount;
                    totalProfit += summary.netProfitOrLoss;

                    const matchInfo = matchMap[String(bet.match_id)];
                    let scoreBadge = '';
                    if (matchInfo && matchInfo.home_score !== null && matchInfo.home_score !== undefined) {
                        scoreBadge = `<span class="badge bg-dark text-warning ms-2">Result: ${matchInfo.home_score} - ${matchInfo.away_score}</span>`;
                    }

                    let choiceColorClass = 'text-primary';
                    if (bet.choice === 'Over' || (bet.choice && bet.choice.includes('Over'))) choiceColorClass = 'text-danger';
                    else if (bet.choice === 'Under' || (bet.choice && bet.choice.includes('Under'))) choiceColorClass = 'text-dark';

                    return `
                        <div class="card bet-card mb-3 shadow-sm">
                            <div class="card-body p-3">
                                <div class="d-flex justify-content-between align-items-center mb-2">
                                    <span class="fw-bold text-secondary">ID: ${bet.id || (idx + 1)}</span>
                                    ${summary.statusBadge}
                                </div>
                                <h5 class="fw-bold text-dark mb-1">
                                    ${bet.match_name || 'Match'} ${scoreBadge}
                                </h5>
                                <div class="text-muted small mb-2">
                                    Category: <span class="text-primary fw-bold">${bet.bet_type || 'Body'}</span> | 
                                    Selection: <span class="${choiceColorClass} fw-bold">${bet.choice || '-'}</span> 
                                    <span class="text-dark">(${bet.odds_rate || '-'})</span>
                                </div>
                                <hr class="my-2 opacity-25">
                                <div class="row g-2 text-center mt-1">
                                    <div class="col-6 col-md-4">
                                        <div class="stat-box">
                                            <div class="stat-label">Stake (ထိုးငွေ)</div>
                                            <div class="stat-value text-dark">${Number(bet.amount || 0).toLocaleString()} Kyats</div>
                                        </div>
                                    </div>
                                    <div class="col-6 col-md-4">
                                        <div class="stat-box">
                                            <div class="stat-label">Payout (ပြန်ရငွေ)</div>
                                            <div class="stat-value text-primary">${summary.returnAmount.toLocaleString()} Kyats</div>
                                        </div>
                                    </div>
                                    <div class="col-6 col-md-4">
                                        <div class="stat-box">
                                            <div class="stat-label">Net P/L (မြတ်/ရှုံး)</div>
                                            <div class="stat-value ${summary.netProfitOrLoss > 0 ? 'text-success' : (summary.netProfitOrLoss < 0 ? 'text-danger' : 'text-secondary')}">
                                                ${summary.profitFormatted}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');

                container.innerHTML = `<div class="col-12 col-lg-8 mx-auto">${cardsHtml}</div>`;
            } catch (err) {
                console.error('Bet history load error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">စာရင်းများ ရယူရာတွင် အမှားအယွင်းရှိနေပါသည်။</div>`;
            }
        }

        async function loadTransactionStatement(isSilent = false) {
            const container = document.getElementById('statementContainer');
            if (!currentUser) {
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-muted">ငွေစာရင်းမှတ်တမ်း ကြည့်ရန် Login ဝင်ပါ။</div>`;
                return;
            }

            try {
                const res = await fetch(`/api/user/transactions?username=${encodeURIComponent(currentUser.username)}`);
                const result = await res.json().catch(() => null);
                let txArray = Array.isArray(result) ? result : (result?.data || []);

                if (txArray.length === 0) {
                    if (!isSilent) {
                        container.innerHTML = `
                            <div class="col-12 col-lg-8 mx-auto text-center py-5 text-muted">
                                <i class="bi bi-receipt fs-1 d-block mb-2 text-secondary"></i>
                                ငွေသွင်း၊ ငွေထုတ် မှတ်တမ်းများ မရှိသေးပါ။
                            </div>`;
                    }
                    return;
                }

                let totalApprovedDeposit = 0, totalApprovedWithdraw = 0;
                const txListHtml = txArray.map(tx => {
                    const status = tx.status || 'Pending';
                    const type = tx.type || 'Deposit';
                    const amount = Number(tx.amount) || 0;

                    let typeBadge = '', amountSign = '', amountClass = '';
                    if (type === 'Deposit') {
                        typeBadge = `<span class="badge bg-success"><i class="bi bi-arrow-down-circle me-1"></i>ငွေသွင်း</span>`;
                        amountSign = '+'; amountClass = 'text-success';
                        if (status === 'Approved' || status === 'Completed') totalApprovedDeposit += amount;
                    } else if (type === 'Withdraw') {
                        typeBadge = `<span class="badge bg-warning text-dark"><i class="bi bi-arrow-up-circle me-1"></i>ငွေထုတ်</span>`;
                        amountSign = '-'; amountClass = 'text-danger';
                        if (status === 'Approved' || status === 'Completed') totalApprovedWithdraw += amount;
                    } else if (type === 'Bet Placed') {
                        typeBadge = `<span class="badge bg-secondary"><i class="bi bi-controller me-1"></i>လောင်းကြေး</span>`;
                        amountSign = '-'; amountClass = 'text-danger';
                    } else if (type === 'Payout') {
                        typeBadge = `<span class="badge bg-info text-dark"><i class="bi bi-trophy me-1"></i>အနိုင်ရငွေ</span>`;
                        amountSign = '+'; amountClass = 'text-primary';
                    }

                    let statusBadge = `<span class="badge bg-warning text-dark">PENDING</span>`;
                    if (['Approved', 'Completed', 'Success'].includes(status)) {
                        statusBadge = `<span class="badge bg-success">SUCCESS</span>`;
                    } else if (['Rejected', 'Failed'].includes(status)) {
                        statusBadge = `<span class="badge bg-danger">REJECTED</span>`;
                    }

                    return `
                        <div class="card statement-card mb-2 shadow-sm">
                            <div class="card-body p-3 d-flex justify-content-between align-items-center">
                                <div>
                                    <div class="d-flex align-items-center gap-2 mb-1">
                                        ${typeBadge}
                                        <small class="text-muted">${tx.payment_method || 'System'} ${tx.transaction_id ? '(' + tx.transaction_id + ')' : ''}</small>
                                    </div>
                                    <div class="small text-secondary">
                                        <i class="bi bi-clock me-1"></i>${format12HourTime(tx.created_at || tx.date)}
                                    </div>
                                </div>
                                <div class="text-end">
                                    <div class="fw-bold fs-6 ${amountClass}">
                                        ${amountSign}${amount.toLocaleString()} Ks
                                    </div>
                                    <div>${statusBadge}</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');

                container.innerHTML = `<div class="col-12 col-lg-8 mx-auto">${txListHtml}</div>`;
            } catch (err) {
                console.error('Transaction statement error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">ငွေစာရင်းမှတ်တမ်း ရယူရာတွင် အမှားအယွင်းရှိနေပါသည်။</div>`;
            }
        }
        async function loadAdminNotice() {
            try {
                const res = await fetch('/api/notice', { cache: 'no-store' });
                const data = await res.json();
                const banner = document.getElementById('adminNoticeBanner');
                const marquee = document.getElementById('adminNoticeMarquee');
                if (!banner || !marquee) return;
                const notice = String(data.notice || '').trim();
                if (data.enabled !== false && notice) {
                    marquee.textContent = 'Admin Notice: ' + notice;
                    banner.style.display = 'flex';
                } else {
                    banner.style.display = 'none';
                }
            } catch (e) { console.warn('Notice load failed', e); }
        }
        loadAdminNotice();
        setInterval(loadAdminNotice, 30000);
    