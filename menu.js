const drawer=document.getElementById('sideDrawer'),backdrop=document.getElementById('drawerBackdrop');function closeMenu(){drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');backdrop.hidden=true;}document.getElementById('menuOpen').addEventListener('click',()=>{drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');backdrop.hidden=false;});document.getElementById('menuClose').addEventListener('click',closeMenu);backdrop.addEventListener('click',closeMenu);
const adminLogin=document.getElementById('adminLogin'),adminLink=document.getElementById('adminRequestsLink'),adminLogout=document.getElementById('adminLogout');
async function refreshAdmin(){
 try{
  const r=await fetch('/api/admin/status',{cache:'no-store'}),d=await r.json(),yes=!!d.admin;
  if(adminLink)adminLink.hidden=!yes;
  if(adminLogout)adminLogout.hidden=!yes;
  if(adminLogin)adminLogin.hidden=yes;
  const adminConnect=document.getElementById('adminConnectLink');
  const connection=document.getElementById('connection');
  if(adminConnect)adminConnect.hidden=!yes;
  if(connection)connection.hidden=!yes;
  const panel=document.getElementById('adminRequests');
  if(panel)panel.hidden=!yes;
  const dashboard=document.getElementById('adminDashboard');
  if(dashboard)dashboard.hidden=!yes;
  if(yes&&window.refreshAdminMode)await window.refreshAdminMode();
  if(yes&&window.loadAdminStats)await window.loadAdminStats();
  await refreshConnectionNotice(yes);
 }catch{}
}
async function refreshConnectionNotice(isAdmin){
 const modal=document.getElementById('connectModal');
 if(!modal||location.pathname==='/pair')return;
 try{
  const r=await fetch('/api/status',{cache:'no-store'}),s=await r.json();
  const connection=document.getElementById('connection');
  if(connection){connection.textContent=s.connected?'● WhatsApp conectado':'⌁ Conectar WhatsApp';connection.classList.toggle('ready',!!s.connected);}
  if(s.connected){modal.hidden=true;localStorage.removeItem('stickersom-maintenance-notice-until');return;}
  const until=Number(localStorage.getItem('stickersom-maintenance-notice-until')||0);
  if(!isAdmin&&until>Date.now())return;
  const title=document.getElementById('connectTitle'),message=document.getElementById('connectMessage'),action=document.getElementById('connectAction');
  if(title)title.textContent=isAdmin?'Conecte o WhatsApp':'WhatsApp em manutenção';
  if(message)message.textContent=isAdmin?'Conecte o WhatsApp do StickerSom para habilitar os envios e testar a conexão.':'O WhatsApp do StickerSom está temporariamente em manutenção. Tente novamente em 30 minutos.';
  if(action){action.hidden=!isAdmin;action.textContent='Conectar WhatsApp ↗';}
  modal.hidden=false;
 }catch{}
}
function closeConnectionNotice(){
 const modal=document.getElementById('connectModal');if(modal)modal.hidden=true;
 if(!document.getElementById('adminConnectLink')||document.getElementById('adminConnectLink').hidden)
  localStorage.setItem('stickersom-maintenance-notice-until',String(Date.now()+30*60*1000));
}
document.getElementById('closeConnect')?.addEventListener('click',closeConnectionNotice);
document.getElementById('laterConnect')?.addEventListener('click',closeConnectionNotice);
document.getElementById('connectModal')?.addEventListener('click',e=>{if(e.target.classList.contains('connect-backdrop'))closeConnectionNotice();});
document.querySelectorAll('.side-drawer a[href^="/"]').forEach(a=>a.addEventListener('click',closeMenu));
adminLogin?.addEventListener('click',async()=>{const password=prompt('Senha do administrador:');if(password===null)return;try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});const d=await r.json();if(!r.ok)throw Error(d.error||'Não foi possível entrar.');closeMenu();await refreshAdmin();}catch(e){alert(e.message);}});
adminLogout?.addEventListener('click',async()=>{await fetch('/api/admin/logout',{method:'POST'});await refreshAdmin();closeMenu();});
adminLink?.addEventListener('click',()=>{closeMenu();});
refreshAdmin();
