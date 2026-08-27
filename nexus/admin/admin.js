(() => {
  const auth = window.ONEAPP_AUTH;
  const permissionCatalog = [
    ['foundation.read','기준정보 조회'],['foundation.write','기준정보 변경'],['foundation.replace','Master·History 전체 교체'],
    ['customer.read','거래처 조회'],['customer.write','거래처 변경'],['shipping.read','출고·발주 조회'],['shipping.write','출고·발주 변경'],
    ['merchops.read','가격·시세 조회'],['merchops.write','가격·시세 변경'],
    ['dataops.read','DataOps 조회'],['dataops.write','재고 갱신'],['dataops.publish','V2 발행'],['dataops.close','일마감'],
    ['orderq.read','ORDER Q 조회'],['orderq.write','ORDER Q 변경'],['orderq.admin','ORDER Q 관리'],['smartinput.use','스마트입력']
  ];
  const state = { users: [], editingUserId: '' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[character]));
  const message = (id, value, success = false) => {
    const element = document.getElementById(id); element.textContent = value || ''; element.classList.toggle('is-success', success);
  };
  const roleLabel = role => ({OWNER_MASTER:'마스터',FULL_ACCESS:'전체 사용',VIEWER:'조회 전용',CUSTOM:'직접 선택'}[role] || role);
  const statusLabel = status => ({ACTIVE:'사용 중',INVITED:'초대 대기',DELETED:'삭제·복구 가능',PURGED:'영구 삭제'}[status] || status);
  const renderPermissionChecks = (containerId, selected = []) => {
    document.getElementById(containerId).innerHTML = permissionCatalog.map(([key,label]) => `<label><input type="checkbox" value="${key}" ${selected.includes(key) ? 'checked' : ''}> ${label}</label>`).join('');
  };
  const selectedPermissions = containerId => [...document.querySelectorAll(`#${containerId} input:checked`)].map(input => input.value);
  const applyProfileState = (selectId, checksId) => {
    const custom = document.getElementById(selectId).value === 'CUSTOM';
    document.querySelectorAll(`#${checksId} input`).forEach(input => { input.disabled = !custom; });
  };

  function renderUsers() {
    const rows = state.users.map(user => {
      const active = user.status === 'ACTIVE';
      const immutable = user.role === 'OWNER_MASTER';
      let actions = immutable ? '<span class="status-pill">보호됨</span>' : `<button class="admin-button" type="button" data-edit-user="${escapeHtml(user.userId)}">권한</button>`;
      if (!immutable && user.status === 'DELETED') actions += `<button class="admin-button" type="button" data-recover-user="${escapeHtml(user.userId)}">복구</button>`;
      else if (!immutable) actions += `<button class="admin-button danger" type="button" data-delete-user="${escapeHtml(user.userId)}">삭제</button>`;
      return `<tr><td><strong>${escapeHtml(user.displayName)}</strong><br><small>${escapeHtml(user.loginId)}</small></td><td>${roleLabel(user.role)}</td><td><span class="status-pill ${active ? 'active' : ''}">${statusLabel(user.status)}</span></td><td>${escapeHtml(user.updatedAt || user.createdAt || '-')}</td><td><div class="admin-table-actions">${actions}</div></td></tr>`;
    });
    document.getElementById('usersBody').innerHTML = rows.join('') || '<tr><td colspan="5" class="empty-state">등록된 사용자가 없습니다.</td></tr>';
  }

  async function loadUsers() {
    document.getElementById('refreshUsers').disabled = true;
    try { state.users = await auth.admin.users(); renderUsers(); }
    catch (error) { document.getElementById('usersBody').innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(error.message)}</td></tr>`; }
    finally { document.getElementById('refreshUsers').disabled = false; }
  }

  function openPermissionEditor(userId) {
    const user = state.users.find(item => item.userId === userId);
    if (!user) return;
    state.editingUserId = userId;
    document.getElementById('permissionUserTitle').textContent = `${user.displayName} 권한 편집`;
    document.getElementById('permissionRole').value = user.role;
    renderPermissionChecks('permissionChecks', user.permissions || []);
    applyProfileState('permissionRole','permissionChecks');
    document.getElementById('permissionEditor').hidden = false;
    document.getElementById('permissionEditor').scrollIntoView({ behavior:'smooth', block:'center' });
  }

  async function loadServiceStatus() {
    const labels = {upstream:'업무 서버',foundationRead:'Foundation READ',foundationWrite:'Foundation WRITE',dataOpsRead:'DataOps READ',dataOpsWrite:'DataOps WRITE',orderQRead:'ORDER Q READ',orderQWrite:'ORDER Q WRITE',shippingRead:'Shipping READ',shippingWrite:'Shipping WRITE'};
    try {
      const status = await auth.admin.serviceStatus();
      document.getElementById('serviceStatus').innerHTML = Object.entries(labels).map(([key,label]) => `<span><b>${label}</b> <i class="${status[key] ? 'ready' : 'missing'}">${status[key] ? '연결됨' : '미연결'}</i></span>`).join('');
    } catch (error) { document.getElementById('serviceStatus').textContent = error.message; }
  }

  async function loadAudit() {
    document.getElementById('refreshAudit').disabled = true;
    try {
      const rows = await auth.admin.audit(120);
      document.getElementById('auditList').innerHTML = rows.length ? rows.map(row => {
        const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
        const operation = [detail.appId, detail.operationId].filter(Boolean).join(' · ');
        const failure = detail.safeError ? ` · ${detail.safeError}` : '';
        return `<article class="audit-row"><time>${escapeHtml(row.at)}</time><strong>${escapeHtml(row.action)}</strong><span>${escapeHtml(row.result)} · actor ${escapeHtml(detail.loginId || row.actorUserId || '-')} · app/operation ${escapeHtml(operation || '-')} · target ${escapeHtml(row.targetUserId || '-')}${escapeHtml(failure)}</span></article>`;
      }).join('') : '<div class="empty-state">감사 기록이 없습니다.</div>';
    } catch (error) { document.getElementById('auditList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
    finally { document.getElementById('refreshAudit').disabled = false; }
  }

  document.querySelectorAll('[data-panel-target]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-panel-target]').forEach(item => item.classList.toggle('is-active', item === button));
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.panelTarget; });
    if (button.dataset.panelTarget === 'services') loadServiceStatus();
    if (button.dataset.panelTarget === 'audit') loadAudit();
  }));
  document.getElementById('refreshUsers').addEventListener('click', loadUsers);
  document.getElementById('refreshAudit').addEventListener('click', loadAudit);
  document.getElementById('logoutButton').addEventListener('click', () => auth.logout());
  document.getElementById('closePermissionEditor').addEventListener('click', () => { document.getElementById('permissionEditor').hidden = true; state.editingUserId = ''; });
  document.getElementById('permissionRole').addEventListener('change', () => applyProfileState('permissionRole','permissionChecks'));
  document.getElementById('inviteRole').addEventListener('change', () => applyProfileState('inviteRole','invitePermissionChecks'));

  document.getElementById('usersBody').addEventListener('click', async event => {
    const edit = event.target.closest('[data-edit-user]'); if (edit) return openPermissionEditor(edit.dataset.editUser);
    const remove = event.target.closest('[data-delete-user]');
    if (remove) {
      const user = state.users.find(item => item.userId === remove.dataset.deleteUser);
      if (!user || !confirm(`${user.displayName} 사용자를 삭제하시겠습니까? 즉시 로그아웃되며 30일 동안 복구할 수 있습니다.`)) return;
      remove.disabled = true;
      try { await auth.admin.deleteUser(user.userId); await loadUsers(); } catch (error) { alert(error.message); }
      return;
    }
    const recover = event.target.closest('[data-recover-user]');
    if (recover) { recover.disabled = true; try { await auth.admin.recoverUser(recover.dataset.recoverUser); await loadUsers(); } catch (error) { alert(error.message); } }
  });

  document.getElementById('permissionEditor').addEventListener('submit', async event => {
    event.preventDefault();
    const role = document.getElementById('permissionRole').value;
    message('permissionMessage','저장 중…',true);
    try { await auth.admin.permissions({ userId:state.editingUserId, role, permissions:selectedPermissions('permissionChecks') }); message('permissionMessage','저장했습니다. 해당 사용자의 기존 세션은 종료되었습니다.',true); await loadUsers(); }
    catch (error) { message('permissionMessage',error.message); }
  });

  document.getElementById('inviteForm').addEventListener('submit', async event => {
    event.preventDefault();
    const role = document.getElementById('inviteRole').value;
    message('inviteMessage','초대 코드 발급 중…',true);
    try {
      const result = await auth.admin.invite({ loginId:document.getElementById('inviteLoginId').value, displayName:document.getElementById('inviteDisplayName').value, role, permissions:selectedPermissions('invitePermissionChecks') });
      document.getElementById('issuedInviteCode').value = result.inviteCode;
      document.getElementById('inviteResult').hidden = false;
      message('inviteMessage','초대 사용자를 등록했습니다.',true); await loadUsers();
    } catch (error) { message('inviteMessage',error.message); }
  });
  document.getElementById('copyInviteCode').addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById('issuedInviteCode').value);
    document.getElementById('copyInviteCode').textContent = '복사됨';
  });

  renderPermissionChecks('invitePermissionChecks',[]); applyProfileState('inviteRole','invitePermissionChecks');
  auth.ready.then(session => { if (session?.user?.role === 'OWNER_MASTER') loadUsers(); });
})();
