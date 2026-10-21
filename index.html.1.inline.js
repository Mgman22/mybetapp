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
        let betFinalConfirmModalInstance = null;
        let betLimitModalInstance = null;
        let profileModalInstance = null;
        let pendingBetPayload = null;
        let pendingBetDeduction = 0;
        let pendingBetLegs = [];
        let lastBetLimitError = null;
        let finalBetSubmitting = false;
        let depositModalInstance = null;
        let withdrawModalInstance = null;
        let withdrawConfirmModalInstance = null;
        let pendingWithdrawalAmount = null;
        let withdrawalSubmitting = false;
        let bettorRefreshTimer = null;

        const adminPaymentAccounts = {
            'KPay': { phone: '09791234567', name: 'KBZPay: Football Bet Admin' },
            'AYA Pay': { phone: '09798765432', name: 'AYA Pay: Football Bet Admin' }
        };

        document.addEventListener('DOMContentLoaded', () => {
            placeBetModalInstance = new bootstrap.Modal(document.getElementById('placeBetModal'));
            betFinalConfirmModalInstance = new bootstrap.Modal(document.getElementById('betFinalConfirmModal'));
            betLimitModalInstance = new bootstrap.Modal(document.getElementById('betLimitModal'));
            profileModalInstance = new bootstrap.Modal(document.getElementById('profileModal'));
            depositModalInstance = new bootstrap.Modal(document.getElementById('depositModal'));
            withdrawModalInstance = new bootstrap.Modal(document.getElementById('withdrawModal'));
            withdrawConfirmModalInstance = new bootstrap.Modal(document.getElementById('withdrawConfirmModal'));
            document.getElementById('withdrawConfirmModal').addEventListener('hidden.bs.modal', () => {
                if (pendingWithdrawalAmount !== null && !withdrawalSubmitting) {
                    // Closing/cancelling the second dialog returns to the amount form, without sending an Admin alert.
                    window.setTimeout(() => withdrawModalInstance.show(), 120);
                }
            });
            document.getElementById('withdrawForm').addEventListener('submit', handleWithdrawSubmit);

            updateUserUI();
            syncServerTime();
            setInterval(syncServerTime, 30000);
            const rulesCheck = document.getElementById('loginRulesAgreeCheck');
            if (rulesCheck) rulesCheck.addEventListener('change', () => {
                const btn = document.getElementById('acceptLoginRulesBtn');
                if (btn) btn.disabled = !rulesCheck.checked;
            });

            document.getElementById('loginForm').addEventListener('submit', handleLogin);
            document.getElementById('gateLoginForm').addEventListener('submit', handleGateLogin);
            if (currentUser && authToken) {
                fetch('/api/me').then(r => r.json().then(data => ({ok:r.ok, data}))).then(({ok, data}) => {
                    if (!ok || !data.success || data.user.role !== 'user') throw new Error('session');
                    currentUser = data.user;
                    // Keep the existing valid token: /api/me returns user info, not a new token.
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    enterAuthenticatedView();
                }).catch(() => showLoginGate());
            } else {
                showLoginGate();
            }
            document.getElementById('betForm').addEventListener('submit', handlePlaceBet);
            document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
            document.getElementById('depositForm').addEventListener('submit', handleDepositSubmit);
            document.getElementById('betAmount').addEventListener('input', updateBetStakeSummary);
        });

        async function handleDepositSubmit(e) {
            e.preventDefault();
            if (!currentUser) return;
            const amount = Number(document.getElementById('depAmount').value);
            if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
            try {
                const res = await fetch('/api/user/deposit', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount })
                });
                const result = await res.json();
                if (!res.ok || !result.success) throw new Error(result.message || 'Deposit request failed');
                alert('Deposit request submitted successfully.');
                depositModalInstance.hide();
                document.getElementById('depositForm').reset();
                loadTransactionStatement(true);
            } catch (err) { alert(err.message || 'Deposit request failed.'); }
        }

        async function handleWithdrawSubmit(e) {
            e.preventDefault();
            if (!currentUser) return;
            const amount = Number(document.getElementById('withAmount').value);
            if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
            if (amount > Number(currentUser.balance || 0)) { alert('Insufficient balance.'); return; }

            // Step 1: validate the amount, then show the agent-contact confirmation.
            // No API call or Admin notification is created at this stage.
            pendingWithdrawalAmount = amount;
            document.getElementById('confirmWithdrawAmount').textContent = amount.toLocaleString() + ' units';
            const amountModalEl = document.getElementById('withdrawModal');
            amountModalEl.addEventListener('hidden.bs.modal', function showAgentPrompt() {
                amountModalEl.removeEventListener('hidden.bs.modal', showAgentPrompt);
                if (pendingWithdrawalAmount !== null) withdrawConfirmModalInstance.show();
            }, { once: true });
            withdrawModalInstance.hide();
        }

        async function confirmWithdrawalRequest() {
            if (!currentUser || pendingWithdrawalAmount === null || withdrawalSubmitting) return;
            const amount = Number(pendingWithdrawalAmount);
            if (!Number.isFinite(amount) || amount <= 0) return;
            if (amount > Number(currentUser.balance || 0)) { alert('Insufficient balance. Please reopen the withdrawal form.'); return; }

            const confirmBtn = document.getElementById('confirmWithdrawFinalBtn');
            withdrawalSubmitting = true;
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Submitting...';
            try {
                // Step 2: this is the only place that sends the request, so Admin alerts
                // are created only after the user explicitly confirms the agent message.
                const res = await fetch('/api/user/withdraw', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount, agent_confirmation: true })
                });
                const result = await res.json();
                if (!res.ok || !result.success) throw new Error(result.message || 'Withdraw request failed');

                currentUser.balance = Math.max(0, Number(currentUser.balance || 0) - amount);
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                pendingWithdrawalAmount = null;
                withdrawConfirmModalInstance.hide();
                document.getElementById('withdrawForm').reset();
                updateUserUI();
                loadTransactionStatement(true);
                alert('Withdrawal request submitted. Please confirm with your agent via Viber, Telegram or phone.');
            } catch (err) {
                alert(err.message || 'Withdraw request failed.');
            } finally {
                withdrawalSubmitting = false;
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="bi bi-check2-circle me-1"></i>Confirm & Notify Admin';
            }
        }

        function updateUserUI() {
            if (currentUser) {
                document.getElementById('btnLoginModal').classList.add('d-none');
                document.getElementById('btnLogout').classList.remove('d-none');
                const usernameEl = document.getElementById('lblUsername');
                if (usernameEl) usernameEl.innerText = currentUser.username;
                const balanceEl = document.getElementById('lblBalance');
                if (balanceEl) balanceEl.innerText = Number(currentUser.balance || 0).toLocaleString();
                const accountNameEl = document.getElementById('accountMenuUsername');
                if (accountNameEl) accountNameEl.textContent = 'Signed in as ' + currentUser.username;
                const accountWrap = document.getElementById('accountDropdownWrap');
                if (accountWrap) accountWrap.classList.remove('d-none');
                const nameParts = String(currentUser.username || 'ST').trim().split(/\s+/);
                const initials = (nameParts[0] || 'ST').substring(0, 2).toUpperCase();
                const avatarEl = document.getElementById('userAvatar');
                if (avatarEl) avatarEl.innerText = initials;
            } else {
                document.getElementById('btnLoginModal').classList.remove('d-none');
                const accountWrap = document.getElementById('accountDropdownWrap');
                if (accountWrap) accountWrap.classList.add('d-none');
                document.getElementById('btnLogout').classList.add('d-none');
            }
        }

        function showLoginGate() {
            document.body.classList.remove('rules-required');
            const rulesGate = document.getElementById('loginRulesGate');
            if (rulesGate) rulesGate.style.display = 'none';
            document.body.classList.add('auth-required');
            document.getElementById('loginGate').style.display = 'flex';
        }

        async function enterAuthenticatedView() {
            if (!currentUser || !authToken) { showLoginGate(); return; }
            try {
                const response = await fetch('/api/user/rules-status', { cache:'no-store' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) throw new Error(data.message || 'Unable to verify current rules.');
                if (data.enabled && !data.accepted) {
                    pendingLoginRulesVersion = String(data.version || '');
                    const content = document.getElementById('loginRulesContent');
                    const check = document.getElementById('loginRulesAgreeCheck');
                    const btn = document.getElementById('acceptLoginRulesBtn');
                    const error = document.getElementById('loginRulesError');
                    if (content) content.innerHTML = String(data.rules || '').split(/\r?\n/).map(line => `<div>${escapeHtml(line)}</div>`).join('') || '<div>No rules have been configured.</div>';
                    if (check) check.checked = false;
                    if (btn) btn.disabled = true;
                    if (error) error.textContent = '';
                    document.body.classList.remove('auth-required');
                    document.body.classList.add('rules-required');
                    document.getElementById('loginGate').style.display = 'none';
                    document.getElementById('loginRulesGate').style.display = 'flex';
                    updateUserUI();
                    return;
                }
            } catch (err) {
                pendingLoginRulesVersion = '';
                // If the session expired while checking rules, return to Login instead of leaving both gates visible.
                if (!localStorage.getItem('authToken')) {
                    currentUser = null; authToken = null;
                    document.body.classList.remove('rules-required');
                    showLoginGate();
                    return;
                }
                document.body.classList.remove('auth-required');
                document.body.classList.add('rules-required');
                document.getElementById('loginGate').style.display = 'none';
                document.getElementById('loginRulesGate').style.display = 'flex';
                const content = document.getElementById('loginRulesContent');
                if (content) content.innerHTML = '<div>Current rules could not be loaded. Please retry before entering the Bettor Panel.</div>';
                const error = document.getElementById('loginRulesError');
                if (error) error.textContent = err.message || 'Unable to verify the rules.';
                const btn = document.getElementById('acceptLoginRulesBtn');
                if (btn) { btn.disabled = false; btn.textContent = 'Retry'; btn.onclick = retryLoginRules; }
                const check = document.getElementById('loginRulesAgreeCheck');
                if (check) check.closest('label').style.display = 'none';
                return;
            }
            finishAuthenticatedView();
        }

        let pendingLoginRulesVersion = '';
        async function retryLoginRules() {
            const btn = document.getElementById('acceptLoginRulesBtn');
            if (btn) { btn.textContent = 'I Agree & Continue'; btn.onclick = acceptLoginRules; btn.disabled = true; }
            const check = document.getElementById('loginRulesAgreeCheck');
            if (check) { check.closest('label').style.display = ''; check.checked = false; }
            await enterAuthenticatedView();
        }

        async function acceptLoginRules() {
            const check = document.getElementById('loginRulesAgreeCheck');
            const btn = document.getElementById('acceptLoginRulesBtn');
            const error = document.getElementById('loginRulesError');
            if (!pendingLoginRulesVersion || !check?.checked || !btn || btn.textContent === 'Retry') return;
            btn.disabled = true; btn.textContent = 'Saving...';
            if (error) error.textContent = '';
            try {
                const response = await fetch('/api/user/accept-rules', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({version:pendingLoginRulesVersion})
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) {
                    if (data.code === 'RULES_UPDATED') {
                        await enterAuthenticatedView();
                        return;
                    }
                    throw new Error(data.message || 'Could not save rules acceptance.');
                }
                pendingLoginRulesVersion = '';
                finishAuthenticatedView();
            } catch (err) {
                if (error) error.textContent = err.message || 'Could not save rules acceptance.';
                btn.disabled = false; btn.textContent = 'I Agree & Continue';
            }
        }

        function declineLoginRules() { logout(); }

        function finishAuthenticatedView() {
            document.body.classList.remove('auth-required', 'rules-required');
            document.getElementById('loginGate').style.display = 'none';
            document.getElementById('loginRulesGate').style.display = 'none';
            updateUserUI();
            loadMatches();
            loadBetHistory(true);
            loadTransactionStatement(true);
            loadRules(true);
            loadAdminNotice();
            loadResults(true);
            startAutoRefresh();
        }

        function startAutoRefresh() {
            if (bettorRefreshTimer) return;
            bettorRefreshTimer = window.setInterval(() => {
                if (!currentUser || document.body.classList.contains('rules-required')) return;
                loadMatches(true);
                loadAdminNotice();
            }, 30000);
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
                if (!data.success) { err.textContent = data.message || 'Invalid username or password.'; return; }
                currentUser = data.user;
                authToken = data.token;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                localStorage.setItem('authToken', authToken);
                enterAuthenticatedView();
            } catch (e) { err.textContent = 'Could not connect to the server. Please try again.'; }
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
                    bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide();
                    enterAuthenticatedView();
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
            document.body.classList.remove('rules-required');
            document.getElementById('loginRulesGate').style.display = 'none';
            document.getElementById('acceptLoginRulesBtn').textContent = 'I Agree & Continue';
            document.getElementById('acceptLoginRulesBtn').onclick = acceptLoginRules;
            document.getElementById('loginRulesAgreeCheck').closest('label').style.display = '';
            showLoginGate();
            document.getElementById('betHistoryContainer').innerHTML = `
                <div class="text-center py-5"><p class="text-muted">Please login to view your bets.</p></div>`;
            document.getElementById('statementContainer').innerHTML = `
                <div class="text-center py-5"><p class="text-muted">Please login to view transactions.</p></div>`;
        }

        const MYANMAR_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;
        const DEFAULT_BET_LOCK_MINUTES = 15;
        let serverClockOffsetMs = 0;
        let serverClockSyncedAt = 0;
        function nowMs(){ return Date.now() + serverClockOffsetMs; }

        async function syncServerTime(){
            try {
                const t0 = Date.now();
                const r = await fetch('/api/time', {cache:'no-store'});
                const d = await r.json();
                const t1 = Date.now();
                if (d && d.success && Number.isFinite(Number(d.server_now_ms))) {
                    serverClockOffsetMs = Number(d.server_now_ms) - Math.round((t0+t1)/2);
                    serverClockSyncedAt = t1;
                }
            } catch(e) {}
        }

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

        function formatDbUtcTime(timeStr) {
            if (!timeStr) return '-';
            const raw = String(timeStr).trim().replace(' ', 'T') + 'Z';
            const ms = Date.parse(raw);
            if (Number.isNaN(ms)) return timeStr;
            return new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Yangon', month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true }).format(new Date(ms)) + ' (GMT+6:30)';
        }

        function format12HourTime(timeStr) {
            const ms = parseMyanmarTime(timeStr);
            if (!ms) return timeStr || '-';
            return new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Yangon', month: 'short', day: 'numeric',
                year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
            }).format(new Date(ms));
        }

        // Format the exact betting closing time using the match's effective lock setting.
        // Kickoff values stored as Myanmar-local timestamps are parsed explicitly above.
        function formatClosingTime(timeStr, lockMinutes = DEFAULT_BET_LOCK_MINUTES) {
            const lockAtMs = getBetLockAt(timeStr, lockMinutes);
            if (!lockAtMs || !Number.isFinite(lockAtMs)) return '-';
            return new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Yangon',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            }).format(new Date(lockAtMs));
        }

        function getMatchLockMinutes(match) {
            const n = String(match?.lock_mode || 'global').toLowerCase() === 'override' ? Number(match?.lock_minutes) : Number(match?.global_lock_minutes ?? match?.betting_lock_minutes);
            return [2, 5, 10, 15].includes(n) ? n : DEFAULT_BET_LOCK_MINUTES;
        }

        function getBetLockAt(timeStr, lockMinutes = DEFAULT_BET_LOCK_MINUTES) {
            const kickoff = parseMyanmarTime(timeStr);
            const mins = Number(lockMinutes);
            return kickoff ? kickoff - ([2,5,10,15].includes(mins) ? mins : DEFAULT_BET_LOCK_MINUTES) * 60 * 1000 : 0;
        }

        function isBettingLocked(timeStr, lockMinutes = DEFAULT_BET_LOCK_MINUTES) {
            const lockAt = getBetLockAt(timeStr, lockMinutes);
            return lockAt > 0 && nowMs() >= lockAt;
        }

        function isKickoffPassed(timeStr) {
            const kickoff = parseMyanmarTime(timeStr);
            return kickoff > 0 && nowMs() >= kickoff;
        }

        function minutesToKickoff(timeStr) {
            const ms = parseMyanmarTime(timeStr);
            if (!ms) return null;
            return Math.ceil((ms - nowMs()) / 60000);
        }


        function populateTimeFilter(matchesList) {
            const select = document.getElementById('timeFilter');
            if (!select) return;
            const current = select.value || 'all';
            const entries = [];
            const seen = new Set();
            for (const m of matchesList || []) {
                const ms = parseMyanmarTime(m.match_time);
                if (!ms || seen.has(ms)) continue;
                seen.add(ms);
                entries.push({ ms, label: new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Yangon',hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(ms)) });
            }
            entries.sort((a,b)=>a.ms-b.ms);
            select.innerHTML = '<option value="all">All Kickoff Times</option>' + entries.map(x=>`<option value="${x.ms}">${x.label}</option>`).join('');
            if (entries.some(x=>String(x.ms)===current)) select.value=current;
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
            return !!ms && String(ms) === String(filter);
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
                const actualHomeTeam = teams[0] ? teams[0].trim() : 'Home';
                const actualAwayTeam = teams[1] ? teams[1].trim() : 'Away';
                const favoredSide = String(m.body_favored_side || 'home').toLowerCase() === 'away' ? 'away' : 'home';
                const favoredTeam = favoredSide === 'away' ? actualAwayTeam : actualHomeTeam;
                const nonFavoredTeam = favoredSide === 'away' ? actualHomeTeam : actualAwayTeam;
                const kickoffMs = parseMyanmarTime(m.match_time);
                const expired = kickoffMs > 0 && nowMs() >= kickoffMs;
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
                const clickFavored = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Body", ${JSON.stringify(favoredTeam)}, ${JSON.stringify(bodyOdds)})'`;
                const clickNonFavored = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Body", ${JSON.stringify(nonFavoredTeam)}, ${JSON.stringify(bodyOdds)})'`;
                const nonFavoredLabel = (favoredSide === 'away' && nonFavoredTeam === actualHomeTeam) ? `${nonFavoredTeam} (H)` : nonFavoredTeam;
                const clickOver = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Goal", "Over", ${JSON.stringify(goalOdds)})'`;
                const clickUnder = isClosed ? '' : `onclick='openBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, "Goal", "Under", ${JSON.stringify(goalOdds)})'`;
                const clickBothOver = isClosed ? '' : `onclick='openBothBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, ${JSON.stringify(favoredTeam)}, ${JSON.stringify(bodyOdds)}, ${JSON.stringify(goalOdds)}, "Over")'`;
                const clickBothUnder = isClosed ? '' : `onclick='openBothBetModal(${JSON.stringify(matchId)}, ${JSON.stringify(matchName)}, ${JSON.stringify(favoredTeam)}, ${JSON.stringify(bodyOdds)}, ${JSON.stringify(goalOdds)}, "Under")'`;
                return `
                    <div class="col-12 col-md-6 col-lg-4">
                        <div class="match-compact h-100">
                            <div class="match-meta">
                                <div class="match-meta-left">
                                    <span class="match-id">#${escapeHtml(matchId)}</span>
                                    <span class="match-league" title="${escapeHtml(m.league || 'LEAGUE')}"><i class="bi bi-trophy-fill me-1"></i>${escapeHtml(m.league || 'LEAGUE')}</span>
                                </div>
                                <div class="d-flex align-items-center gap-2">
                                    <span class="match-time small">Close ${formatClosingTime(m.match_time, lockMinutes)}</span>
                                    <span class="match-status ${statusClass}">${escapeHtml(statusText)}</span>
                                </div>
                            </div>
                            <div class="team-stack">
                                <button type="button" class="team-btn favored ${disabledClass}" ${clickFavored} title="Favored team: ${escapeHtml(favoredTeam)}">${escapeHtml(favoredTeam)}</button>
                                <button type="button" class="team-btn nonfavored ${disabledClass}" ${clickNonFavored} title="Other side: ${escapeHtml(nonFavoredTeam)}">${escapeHtml(nonFavoredLabel)}</button>
                            </div>
                            <div class="market-grid">
                                <button type="button" class="market-btn over ${disabledClass}" ${clickOver}>
                                    <span class="market-label">Over</span><span class="market-odds">${escapeHtml(goalOdds)}</span>
                                </button>
                                <button type="button" class="market-btn under ${disabledClass}" ${clickUnder}>
                                    <span class="market-label">Under</span><span class="market-odds">${escapeHtml(goalOdds)}</span>
                                </button>
                            </div>
                            <div class="market-grid market-grid-both">
                                <button type="button" class="market-btn both-over ${disabledClass}" ${clickBothOver}>
                                    <span class="both-label">Both Over</span><span class="market-odds">2 Bets</span>
                                </button>
                                <button type="button" class="market-btn both-under ${disabledClass}" ${clickBothUnder}>
                                    <span class="both-label">Both Under</span><span class="market-odds">2 Bets</span>
                                </button>
                            </div>
                            <div class="d-flex justify-content-between align-items-center mt-2">
                                <span class="odds-summary body-summary">Body odds <b>${escapeHtml(bodyOdds)}</b></span>
                                <span class="match-time"><i class="bi bi-clock me-1"></i>${format12HourTime(m.match_time)}</span>
                                <span class="odds-summary ou-summary">GP odds <b>${escapeHtml(goalOdds)}</b></span>
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
                if (!Array.isArray(result) && Number.isFinite(Number(result.server_now_ms))) serverClockOffsetMs = Number(result.server_now_ms) - Date.now();
                window.__allMatches = matchesList;
                loadFinalScores(matchesList);
                window.__matchesById = {};
                matchesList.forEach(m => {
                    window.__matchesById[String(m.id)] = m;
                    if (m.custom_match_id !== undefined) window.__matchesById[String(m.custom_match_id)] = m;
                });
                populateLeagueFilter(matchesList);
                populateTimeFilter(matchesList);
                applyMatchFilters();
                if (matchesList.length === 0 && !isSilent) {
                    container.innerHTML = `<div class="text-center py-5 text-muted">ဖွင့်ထားသော ပွဲစဉ်များ မရှိသေးပါ။</div>`;
                }
            } catch (err) {
                console.error('Matches load/render error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">Could not load matches. Please refresh the page. If the problem continues, check the server logs.</div>`;
            }
        }

        function canOpenBetModal(matchId) {
            const cachedMatch = window.__matchesById ? window.__matchesById[String(matchId)] : null;
            if (cachedMatch && (cachedMatch.betting_open === false || isBettingLocked(cachedMatch.match_time, getMatchLockMinutes(cachedMatch)))) {
                alert(`Betting closes ${getMatchLockMinutes(cachedMatch)} minutes before kickoff.`);
                return false;
            }
            if (!currentUser) {
                alert('Please login before placing a bet.');
                new bootstrap.Modal(document.getElementById('loginModal')).show();
                return false;
            }
            return true;
        }

        function renderModalLegPreview(legs) {
            const box = document.getElementById('modalLegsPreview');
            if (!box) return;
            if (!Array.isArray(legs) || legs.length < 2) {
                box.classList.add('d-none');
                box.innerHTML = '';
                return;
            }
            box.classList.remove('d-none');
            box.innerHTML = legs.map(leg => `
                <div class="modal-leg-preview">
                    <div><span class="text-white-50 me-1">${/body/i.test(leg.bet_type) ? 'Body' : 'GP'}</span><strong>${escapeHtml(leg.choice)}</strong></div>
                    <div class="text-end"><div class="text-white-50" style="font-size:9px">Odds</div><strong>${escapeHtml(leg.odds_rate)}</strong></div>
                </div>`).join('');
        }

        function openBetModal(matchId, matchName, betType, choice, oddsRate) {
            if (!canOpenBetModal(matchId)) return false;
            const cachedMatch = window.__matchesById ? window.__matchesById[String(matchId)] : null;
            const bodyOdds = cachedMatch ? String(cachedMatch.body_odds || oddsRate || '') : String(oddsRate || '');
            const goalOdds = cachedMatch ? String(cachedMatch.goal_odds || oddsRate || '') : String(oddsRate || '');
            const isBody = /body|ဘော်ဒီ/i.test(String(betType));
            window.__pendingBetLegs = [{
                match_id:String(matchId), match_name:String(matchName),
                bet_type:String(betType), choice:String(choice), odds_rate:String(oddsRate)
            }];

            document.getElementById('modalMatchId').value = matchId;
            document.getElementById('modalMatchName').value = matchName;
            document.getElementById('modalBetType').value = betType;
            document.getElementById('modalChoice').value = choice;
            document.getElementById('modalOddsRate').value = oddsRate;
            document.getElementById('modalMatchTitle').innerText = matchName;
            document.getElementById('modalBetTypeLabel').innerText = betType;
            const choiceLabel = document.getElementById('modalChoiceLabel');
            choiceLabel.innerText = choice;
            if (/over/i.test(choice)) choiceLabel.className = 'fw-bold text-danger';
            else if (/under/i.test(choice)) choiceLabel.className = 'fw-bold text-primary';
            else if (cachedMatch) {
                const teams = String(cachedMatch.match_name || '').split(/\s+vs\s+/i).map(x => x.trim());
                const favored = String(cachedMatch.body_favored_side || 'home').toLowerCase() === 'away' ? (teams[1] || '') : (teams[0] || '');
                choiceLabel.className = choice === favored ? 'fw-bold text-danger' : 'fw-bold text-primary';
            } else choiceLabel.className = 'fw-bold text-primary';
            document.getElementById('modalOddsLabel').innerText = oddsRate;
            renderModalLegPreview(window.__pendingBetLegs);
            document.getElementById('betAmountLabel').textContent = 'Stake';
            document.getElementById('betAmountHint').classList.add('d-none');
            document.getElementById('betTotalDeductionPreview').classList.add('d-none');
            document.getElementById('betTotalDeductionPreview').textContent = '';

            const amountInput = document.getElementById('betAmount');
            const capNote = document.getElementById('late-bet-cap-note');
            amountInput.value = '';
            amountInput.removeAttribute('max');
            capNote.classList.add('d-none');
            capNote.textContent = '';
            const lockMinutes = getMatchLockMinutes(cachedMatch || {});
            const lateEnabled = String(cachedMatch?.late_bet_cap_enabled || '0') === '1';
            const lateWindow = Number(cachedMatch?.late_bet_cap_window_minutes || 0);
            const lateAmount = Number(cachedMatch?.late_bet_cap_amount || 0);
            const kickoffMs = cachedMatch ? parseMyanmarTime(cachedMatch.match_time) : 0;
            const now = nowMs();
            const hardLockAt = kickoffMs - lockMinutes*60*1000;
            const lateCapAt = kickoffMs - lateWindow*60*1000;
            if (lateEnabled && lateWindow > 0 && lateAmount > 0 && now >= lateCapAt && now < hardLockAt) {
                amountInput.max = String(lateAmount);
                capNote.textContent = `Final 5-minute limit: maximum stake ${lateAmount.toLocaleString()}.`;
                capNote.classList.remove('d-none');
            }
            placeBetModalInstance.show();
            return true;
        }

        function openBothBetModal(matchId, matchName, favoredTeam, bodyOdds, goalOdds, goalChoice) {
            // Reuse the established slip, then add a second independent stake at the same amount.
            if (!openBetModal(matchId, matchName, 'Body', favoredTeam, bodyOdds)) return;
            window.__pendingBetLegs = [
                { match_id:String(matchId), match_name:String(matchName), bet_type:'Body', choice:String(favoredTeam), odds_rate:String(bodyOdds) },
                { match_id:String(matchId), match_name:String(matchName), bet_type:'Goal', choice:String(goalChoice), odds_rate:String(goalOdds) }
            ];
            document.getElementById('modalBetType').value = `Both ${goalChoice}`;
            document.getElementById('modalChoice').value = `Both ${goalChoice}`;
            document.getElementById('modalOddsRate').value = '';
            document.getElementById('modalBetTypeLabel').innerText = 'Both · 2 selections';
            const choiceLabel = document.getElementById('modalChoiceLabel');
            choiceLabel.innerText = `${favoredTeam} + ${goalChoice}`;
            choiceLabel.className = 'fw-bold text-white';
            document.getElementById('modalOddsLabel').innerText = `Body ${bodyOdds} · GP ${goalOdds}`;
            document.getElementById('betAmountLabel').textContent = 'Stake per selection';
            document.getElementById('betAmountHint').classList.remove('d-none');
            updateBetStakeSummary();
            renderModalLegPreview(window.__pendingBetLegs);
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

        function updateBetStakeSummary() {
            const box = document.getElementById('betTotalDeductionPreview');
            const amount = Number(document.getElementById('betAmount')?.value || 0);
            const legs = Array.isArray(window.__pendingBetLegs) ? window.__pendingBetLegs.length : 0;
            if (!box) return;
            if (legs > 1 && amount > 0) {
                box.textContent = `Stake each: ${amount.toLocaleString()} · Total wallet deduction: ${(amount * legs).toLocaleString()}`;
                box.classList.remove('d-none');
            } else {
                box.textContent = '';
                box.classList.add('d-none');
            }
        }

        async function handlePlaceBet(e) {
            e.preventDefault();
            const amount = Number(document.getElementById('betAmount').value);
            if (!Number.isFinite(amount) || amount <= 0) return alert('Enter a valid stake.');
            const legsTemplate = Array.isArray(window.__pendingBetLegs) ? window.__pendingBetLegs : [];
            if (!legsTemplate.length) return alert('No selection in this bet slip.');
            pendingBetLegs = legsTemplate.map(leg => ({ ...leg, amount }));
            pendingBetDeduction = pendingBetLegs.reduce((sum,leg) => sum + Number(leg.amount || 0), 0);
            if (pendingBetDeduction > Number(currentUser?.balance || 0)) return alert('Insufficient balance. This slip requires ' + pendingBetDeduction.toLocaleString() + '.');

            const selectedMatch = window.__matchesById ? window.__matchesById[String(pendingBetLegs[0].match_id)] : null;
            if (selectedMatch) {
                const lockMinutes = getMatchLockMinutes(selectedMatch);
                const lateEnabled = String(selectedMatch.late_bet_cap_enabled || '0') === '1';
                const lateWindow = Number(selectedMatch.late_bet_cap_window_minutes || 0);
                const lateAmount = Number(selectedMatch.late_bet_cap_amount || 0);
                const kickoffMs = parseMyanmarTime(selectedMatch.match_time);
                const n = nowMs();
                if (lateEnabled && lateWindow > 0 && lateAmount > 0 && n >= kickoffMs - lateWindow*60000 && n < kickoffMs - lockMinutes*60000 && pendingBetLegs.some(leg => Number(leg.amount) > lateAmount)) {
                    alert(`Final 5-minute limit: each stake must not exceed ${lateAmount.toLocaleString()}.`);
                    return;
                }
            }

            pendingBetPayload = { bets:pendingBetLegs, is_parlay:false, total_amount:pendingBetDeduction };
            document.getElementById('betFinalConfirmLines').innerHTML = pendingBetLegs.map(leg => `
                <div class="bet-final-row">
                    <div><div class="bet-final-muted">Selection</div><div class="bet-final-value">${escapeHtml(leg.choice)}</div></div>
                    <div><div class="bet-final-muted">Odds</div><div class="bet-final-value">${escapeHtml(leg.odds_rate)}</div></div>
                    <div class="text-end"><div class="bet-final-muted">Amt</div><div class="bet-final-value">${Number(leg.amount).toLocaleString()}</div></div>
                </div>`).join('');
            finalBetSubmitting = false;
            document.getElementById('betFinalConfirmBtn').disabled = false;
            placeBetModalInstance.hide();
            window.setTimeout(() => betFinalConfirmModalInstance.show(), 350);
        }

        function cancelFinalBetConfirm() {
            if (finalBetSubmitting) return;
            betFinalConfirmModalInstance.hide();
            window.setTimeout(() => placeBetModalInstance.show(), 350);
        }

        function showBetLimitModal(details) {
            lastBetLimitError = details || null;
            document.getElementById('bet-limit-message').textContent = details?.message || 'This side has reached its configured bet limit.';
            document.getElementById('bet-limit-match').textContent = `${details?.match_id || '-'} · ${details?.match_name || ''}`;
            document.getElementById('bet-limit-market').textContent = `${details?.limit_label || 'Bet'} · ${details?.choice || ''}`;
            document.getElementById('bet-limit-cap').textContent = Number(details?.limit || 0).toLocaleString();
            document.getElementById('bet-limit-used').textContent = Number(details?.used || 0).toLocaleString();
            document.getElementById('bet-limit-remaining').textContent = Number(details?.remaining || 0).toLocaleString();
            const btn = document.getElementById('requestBetLimitBtn');
            btn.disabled = false; btn.textContent = 'Request Limit Increase';
            betLimitModalInstance.show();
        }

        async function requestBetLimitIncrease() {
            if (!lastBetLimitError) return;
            const btn = document.getElementById('requestBetLimitBtn');
            btn.disabled = true; btn.textContent = 'Sending...';
            try {
                const r = await fetch('/api/user/bet-limit-request', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({
                        match_id:lastBetLimitError.match_id, limit_type:lastBetLimitError.limit_type,
                        limit:lastBetLimitError.limit, used:lastBetLimitError.used, requested:lastBetLimitError.requested,
                        bet_type:lastBetLimitError.bet_type, choice:lastBetLimitError.choice
                    })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok || !data.success) throw new Error(data.message || 'Could not send request.');
                betLimitModalInstance.hide();
                alert(data.message || 'Request sent to Admin. Please wait for approval.');
                lastBetLimitError = null;
            } catch (err) {
                alert(err.message || 'Could not send request.');
            } finally {
                btn.disabled = false; btn.textContent = 'Request Limit Increase';
            }
        }

        async function confirmFinalBet() {
            if (!pendingBetPayload || finalBetSubmitting) return;
            const btn = document.getElementById('betFinalConfirmBtn');
            finalBetSubmitting = true;
            btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Confirming';
            try {
                const res = await fetch('/api/user/place-bet', {
                    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pendingBetPayload)
                });
                const result = await res.json().catch(() => ({}));
                if (result.success) {
                    currentUser.balance = Math.max(0, Number(currentUser.balance || 0) - Number(result.total_deduction ?? pendingBetDeduction));
                    localStorage.setItem('currentUser', JSON.stringify(currentUser));
                    updateUserUI();
                    betFinalConfirmModalInstance.hide();
                    placeBetModalInstance.hide();
                    pendingBetPayload = null; pendingBetLegs = []; pendingBetDeduction = 0;
                    loadBetHistory(true); loadTransactionStatement(true);
                    alert('Bet placed successfully.');
                    return;
                }
                if (result.code === 'BET_LIMIT_REACHED') {
                    betFinalConfirmModalInstance.hide();
                    window.setTimeout(() => showBetLimitModal(result), 350);
                    return;
                }
                if (result.code === 'ODDS_CHANGED') {
                    betFinalConfirmModalInstance.hide();
                    pendingBetPayload = null; pendingBetLegs = []; pendingBetDeduction = 0;
                    window.setTimeout(() => { alert(result.message || 'Odds changed. Select the market again to reload the current odds.'); loadMatches(true); }, 350);
                    return;
                }
                alert(result.message || 'Unable to place bet.');
            } catch (err) {
                alert(err.message || 'Server connection error.');
            } finally {
                finalBetSubmitting = false;
                btn.disabled = false; btn.textContent = 'Confirm';
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
            let profitFormatted = `${netProfitOrLoss.toLocaleString()}`;

            if (netProfitOrLoss > 0) {
                badgeClass = 'bg-success';
                profitFormatted = `+${netProfitOrLoss.toLocaleString()}`;
            } else if (netProfitOrLoss === 0) {
                badgeClass = 'bg-secondary';
                profitFormatted = `0`;
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
                const resultMatches = matches.sort((a,b) => (parseMyanmarTime(b.match_time) || 0) - (parseMyanmarTime(a.match_time) || 0));

                if (!resultMatches.length) {
                    if (!isSilent) container.innerHTML = `<div class="col-12 text-center py-5 text-muted"><i class="bi bi-trophy fs-1 d-block mb-2"></i>No matches yet.</div>`;
                    return;
                }
                container.innerHTML = resultMatches.map(m => `
                    <div class="col-12 col-lg-8 mx-auto mb-2">
                        <div class="card statement-card shadow-sm">
                            <div class="card-body p-3">
                                <div class="d-flex justify-content-between align-items-center mb-2">
                                    <span class="small text-muted fw-semibold">Match #${m.custom_match_id || m.id}</span>
                                    <span class="badge bg-dark">${m.home_score !== null && m.home_score !== undefined && m.away_score !== null && m.away_score !== undefined ? "FINAL" : "PENDING"}</span>
                                </div>
                                <div class="d-flex align-items-center justify-content-between gap-2">
                                    <div class="fw-bold text-dark flex-grow-1">${m.match_name || 'Match'}</div>
                                    <div class="fs-5 fw-bold text-primary">${m.home_score !== null && m.home_score !== undefined && m.away_score !== null && m.away_score !== undefined ? `${m.home_score} - ${m.away_score}` : "-"}</div>
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

        async function loadRules(isSilent = false) {
            const container = document.getElementById('rulesContainer');
            if (!container) return;
            try {
                const res = await fetch('/api/rules', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.message || 'Rules load failed');
                const text = String(data.rules || '').trim();
                if (data.enabled === false || !text) {
                    container.innerHTML = '<div class="py-4 text-center text-muted">Rules are currently unavailable.</div>';
                    return;
                }
                container.innerHTML = text.split(/\r?\n/).map(line => `<div class="mb-2">${escapeHtml(line || '')}</div>`).join('');
            } catch (err) {
                console.error('Rules load error:', err);
                if (!isSilent) container.innerHTML = '<div class="py-4 text-center text-danger">Unable to load rules.</div>';
            }
        }

        function loadProfile() {
            if (!currentUser) return;
            const html = `
                <div class="card border-0 shadow-sm">
                    <div class="card-body p-3">
                        <div class="d-flex align-items-center gap-3 mb-3">
                            <div class="avatar" style="width:44px;height:44px;flex:0 0 44px;">${escapeHtml((currentUser.username || 'U').slice(0,2).toUpperCase())}</div>
                            <div><div class="small text-muted">ACCOUNT</div><div class="fw-bold">${escapeHtml(currentUser.username)}</div></div>
                        </div>
                        <div class="profile-item"><span class="profile-label">Username</span><span class="profile-value">${escapeHtml(currentUser.username)}</span></div>
                        <div class="profile-item"><span class="profile-label">Balance</span><span class="profile-value text-success">${Number(currentUser.balance || 0).toLocaleString()}</span></div>
                        <div class="profile-item"><span class="profile-label">Account Status</span><span class="badge bg-success">${escapeHtml(currentUser.status || 'Active')}</span></div>
                        <button class="btn btn-dark w-100 fw-bold mt-3" data-bs-toggle="modal" data-bs-target="#changePasswordModal"><i class="bi bi-key me-1"></i> Change Password</button>
                    </div>
                </div>`;
            const pane = document.getElementById('profileContainer');
            const modal = document.getElementById('profileModalContainer');
            if (pane) pane.innerHTML = html;
            if (modal) modal.innerHTML = html;
        }

        function openProfileModal() {
            if (!currentUser) { alert('Please login first.'); return; }
            loadProfile();
            profileModalInstance.show();
        }

        async function loadBetHistory(isSilent = false) {
            const container = document.getElementById('betHistoryContainer');
            if (!currentUser) {
                if (!isSilent) {
                    container.innerHTML = `<div class="text-center py-5 text-muted"><i class="bi bi-person-lock fs-1 d-block mb-2 text-secondary"></i>Please login to view your bets.</div>`;
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
                                သင် No bets yet.
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
                                            <div class="stat-label">Stake</div>
                                            <div class="stat-value text-dark">${Number(bet.amount || 0).toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div class="col-6 col-md-4">
                                        <div class="stat-box">
                                            <div class="stat-label">Payout</div>
                                            <div class="stat-value text-primary">${summary.returnAmount.toLocaleString()}</div>
                                        </div>
                                    </div>
                                    <div class="col-6 col-md-4">
                                        <div class="stat-box">
                                            <div class="stat-label">Net P/L</div>
                                            <div class="stat-value ${summary.netProfitOrLoss > 0 ? 'text-success' : (summary.netProfitOrLoss < 0 ? 'text-danger' : 'text-secondary')}">
                                                ${summary.profitFormatted.replace(/\s*Kyats/g, "")}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');

                container.innerHTML = `<div class="col-12 col-lg-6 col-xl-5 mx-auto">${cardsHtml}</div>`;
            } catch (err) {
                console.error('Bet history load error:', err);
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-danger">စာရင်းများ ရယူရာတွင် အမှားအယွင်းရှိနေပါသည်။</div>`;
            }
        }

        async function loadTransactionStatement(isSilent = false) {
            const container = document.getElementById('statementContainer');
            if (!currentUser) {
                if (!isSilent) container.innerHTML = `<div class="text-center py-5 text-muted">Please login to view transactions.</div>`;
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
                                No transactions yet.
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
                        typeBadge = `<span class="badge bg-success"><i class="bi bi-arrow-down-circle me-1"></i>Deposit</span>`;
                        amountSign = '+'; amountClass = 'text-success';
                        if (status === 'Approved' || status === 'Completed') totalApprovedDeposit += amount;
                    } else if (type === 'Withdraw') {
                        typeBadge = `<span class="badge bg-warning text-dark"><i class="bi bi-arrow-up-circle me-1"></i>Withdraw</span>`;
                        amountSign = '-'; amountClass = 'text-danger';
                        if (status === 'Approved' || status === 'Completed') totalApprovedWithdraw += amount;
                    } else if (type === 'Bet Placed') {
                        typeBadge = `<span class="badge bg-secondary"><i class="bi bi-controller me-1"></i>Bet Stake</span>`;
                        amountSign = '-'; amountClass = 'text-danger';
                    } else if (type === 'Payout') {
                        typeBadge = `<span class="badge bg-info text-dark"><i class="bi bi-trophy me-1"></i>Payout</span>`;
                        amountSign = '+'; amountClass = 'text-primary';
                    }

                    let statusBadge = `<span class="badge bg-warning text-dark">PENDING</span>`;
                    if (['Approved', 'Completed', 'Success'].includes(status)) {
                        statusBadge = `<span class="badge bg-success">SUCCESS</span>`;
                    } else if (['Rejected', 'Failed'].includes(status)) {
                        statusBadge = `<span class="badge bg-danger">REJECTED</span>`;
                    }

                    return `
                        <div class="card statement-card tx-card mb-2 shadow-sm">
                            <div class="card-body p-3 d-flex justify-content-between align-items-center">
                                <div>
                                    <div class="d-flex align-items-center gap-2 mb-1">
                                        ${typeBadge}
                                        <small class="text-muted">${tx.payment_method || 'System'} ${tx.transaction_id ? '(' + tx.transaction_id + ')' : ''}</small>
                                    </div>
                                    <div class="small text-secondary">
                                        <i class="bi bi-clock me-1"></i>${formatDbUtcTime(tx.created_at || tx.date)}
                                    </div>
                                </div>
                                <div class="text-end">
                                    <div class="fw-bold fs-6 ${amountClass}">
                                        ${amountSign}${amount.toLocaleString()}
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
        async function loadFinalScores() {
            const ticker = document.getElementById('finalScoreMarquee');
            if (!ticker) return;
            try {
                const response = await fetch('/api/final-scores', { cache:'no-store' });
                const data = await response.json();
                const finals = Array.isArray(data.data) ? data.data : [];
                if (!response.ok || !data.success || !finals.length) {
                    ticker.innerHTML = '<span class="score-chip">No published final scores yet</span>';
                    ticker.style.animationDuration = '0s'; ticker.style.paddingLeft = '0';
                    return;
                }
                ticker.style.animationDuration = Math.max(22, finals.length * 3.6) + 's';
                ticker.style.paddingLeft = '100%';
                ticker.innerHTML = finals.map(m => {
                    const teams = String(m.match_name || 'Match').split(/\s+vs\s+/i);
                    const home = teams[0] ? teams[0].trim() : 'Home';
                    const away = teams[1] ? teams[1].trim() : 'Away';
                    const matchId = m.custom_match_id || m.id || '';
                    return `<span class="score-chip"><span class="score-id">#${escapeHtml(matchId)}</span><span class="score-teams">${escapeHtml(home)}</span><span class="score-number">${escapeHtml(m.home_score)} - ${escapeHtml(m.away_score)}</span><span class="score-teams">${escapeHtml(away)}</span><span class="score-ft">FT</span></span>`;
                }).join('');
            } catch (err) {
                ticker.innerHTML = '<span class="score-chip">Final scores temporarily unavailable</span>';
                ticker.style.animationDuration = '0s'; ticker.style.paddingLeft = '0';
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
