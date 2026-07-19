let client;
let creating=false;
const $=(id)=>document.getElementById(id);

async function setup(){
  const config=await fetch('/config.json',{cache:'no-store'}).then((r)=>r.json());
  client=supabase.createClient(config.url,config.key);
  $('toggle').addEventListener('click',()=>{
    creating=!creating;
    $('nameRow').hidden=!creating;
    $('title').textContent=creating?'Criar conta':'Bem-vindo';
    $('submit').textContent=creating?'Cadastrar':'Entrar';
    $('toggle').textContent=creating?'Já possuo acesso':'Criar primeiro acesso';
  });
  $('form').addEventListener('submit',submit);
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
  if(creating&&!result.data.session){$('message').textContent='Cadastro realizado. Confirme o e-mail para entrar.';return;}
  location.reload();
}

setup().catch(()=>{$('message').textContent='Não foi possível carregar a autenticação.';});
