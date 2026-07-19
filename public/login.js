let client;
let creating=false;
let currentUser=null;
const $=(id)=>document.getElementById(id);
const brl=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});

async function setup(){
  const config=await fetch('https://cdn.jsdelivr.net/gh/FrancoEvora/advent@main/public/config.json',{cache:'no-store'}).then((r)=>r.json());
  client=supabase.createClient(config.url,config.key);
  $('toggle').addEventListener('click',toggleMode);
  $('form').addEventListener('submit',submit);
  $('logout').addEventListener('click',()=>client.auth.signOut());
  $('entryForm').addEventListener('submit',saveEntry);
  const {data}=await client.auth.getSession();
  await applySession(data.session);
  client.auth.onAuthStateChange((_event,session)=>applySession(session));
}

function toggleMode(){
  creating=!creating;
  $('nameRow').hidden=!creating;
  $('title').textContent=creating?'Criar conta':'Bem-vindo';
  $('submit').textContent=creating?'Cadastrar':'Entrar';
  $('toggle').textContent=creating?'Já possuo acesso':'Criar primeiro acesso';
}

async function submit(event){
  event.preventDefault();
  $('message').textContent='';
  $('submit').disabled=true;
  const email=$('email').value.trim();
  const password=$('password').value;
  const fullName=$('name').value.trim();
  const result=creating
    ? await client.auth.signUp({email,password,options:{data:{full_name:fullName},emailRedirectTo:location.origin}})
    : await client.auth.signInWithPassword({email,password});
  $('submit').disabled=false;
  if(result.error){$('message').textContent=result.error.message;return;}
  if(creating&&!result.data.session){$('message').textContent='Cadastro realizado. Confirme o e-mail para entrar.';}
}

async function applySession(session){
  currentUser=session?.user||null;
  $('auth').hidden=Boolean(currentUser);
  $('app').hidden=!currentUser;
  if(!currentUser)return;
  $('userEmail').textContent=currentUser.email||'Administrador';
  await loadEntries();
}

async function loadEntries(){
  const {data,error}=await client.from('financial_entries').select('*').order('due_date');
  if(error){$('appMessage').textContent=error.message;return;}
  const entries=data||[];
  const incoming=entries.filter((e)=>e.type==='entrada').reduce((s,e)=>s+Number(e.amount),0);
  const outgoing=entries.filter((e)=>e.type==='saida').reduce((s,e)=>s+Number(e.amount),0);
  $('balance').textContent=brl.format(incoming-outgoing);
  $('incoming').textContent=brl.format(incoming);
  $('outgoing').textContent=brl.format(outgoing);
  $('entries').innerHTML=entries.length?entries.map((e)=>`<article><div><strong>${escapeHtml(e.description)}</strong><small>${escapeHtml(e.category)} · ${new Date(e.due_date+'T12:00:00').toLocaleDateString('pt-BR')}</small></div><b class="${e.type}">${e.type==='saida'?'-':'+'}${brl.format(Number(e.amount))}</b></article>`).join(''):'<p>Nenhum lançamento cadastrado.</p>';
}

async function saveEntry(event){
  event.preventDefault();
  $('appMessage').textContent='';
  const form=new FormData(event.currentTarget);
  const payload={user_id:currentUser.id,type:String(form.get('type')),description:String(form.get('description')),category:String(form.get('category')),amount:Number(form.get('amount')),due_date:String(form.get('due_date')),status:'pendente'};
  const {error}=await client.from('financial_entries').insert(payload);
  if(error){$('appMessage').textContent=error.message;return;}
  event.currentTarget.reset();
  await loadEntries();
}

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}

setup().catch(()=>{$('message').textContent='Não foi possível carregar a autenticação.';});
