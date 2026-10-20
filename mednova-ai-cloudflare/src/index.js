const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const LANGUAGES = new Set(["fa", "en", "es", "it", "ru", "he"]);
const SYSTEM_PROMPT = "You are MedNova AI, a medical information and learning assistant. You are not a doctor and must not present possibilities as confirmed diagnoses. Never invent sources, lab values, medical history, or clinical validations. Encourage urgent local emergency care for potentially life-threatening symptoms. Do not recommend starting, stopping, or changing prescription medicines. Be clear about uncertainty and answer in the user's requested language. This is informational support, not a substitute for qualified care.";

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
});
const err = (status, detail) => json({ detail }, status);
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromB64url = (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - str.length % 4) % 4)), c => c.charCodeAt(0));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, material, 256);
  return { salt: b64url(salt), hash: b64url(bits) };
}
async function verifyPassword(password, salt, expected) {
  const result = await hashPassword(password, salt);
  const a = fromB64url(result.hash), b = fromB64url(expected);
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function signToken(user, secret) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({ sub: String(user.id), email: user.email, language: user.language, role: user.role, exp: Math.floor(Date.now()/1000) + 43200 })));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${payload}`)));
  return `${head}.${payload}.${sig}`;
}
async function authUser(request, env) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || !env.JWT_SECRET) return null;
  try {
    const [head, payload, sig] = token.split(".");
    const key = await crypto.subtle.importKey("raw", enc.encode(env.JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(`${head}.${payload}`));
    if (!valid) return null;
    const data = JSON.parse(dec.decode(fromB64url(payload)));
    if (!data.exp || data.exp < Date.now()/1000) return null;
    return await env.DB.prepare("SELECT id,email,language,role FROM users WHERE id=?").bind(Number(data.sub)).first();
  } catch { return null; }
}
function publicUser(user) { return { id: user.id, email: user.email, language: user.language, role: user.role }; }
async function requireUser(request, env) {
  const user = await authUser(request, env);
  return user || null;
}
async function groqChat(env, messages, language) {
  if (!env.GROQ_API_KEY) throw new Error("Groq is not configured. Add GROQ_API_KEY in Cloudflare Worker secrets.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.GROQ_MODEL || DEFAULT_MODEL, temperature: 0.2,
      messages: [{ role: "system", content: `${SYSTEM_PROMPT} Response language: ${language}.` }, ...messages] })
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Groq authentication failed (HTTP 401). Check the GROQ_API_KEY secret in Cloudflare and replace it if needed.");
    if (response.status === 429) throw new Error("Groq rate limit or quota reached (HTTP 429). Check your Groq account limits.");
    const safeText = response.status === 403 ? "Groq denied access (HTTP 403). Check API key permissions and account access." : `Groq provider error (HTTP ${response.status}).`;
    throw new Error(safeText);
  }
  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("Groq returned an empty response. Try again.");
  return answer;
}
async function pubmedSearch(q, page = 1, pageSize = 10) {
  q = String(q || "").trim();
  if (!q || q.length > 300) throw new Error("Enter a search query (up to 300 characters).");
  page = Math.max(1, Number(page) || 1); pageSize = Math.min(25, Math.max(1, Number(pageSize) || 10));
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const searchUrl = new URL(base + "esearch.fcgi");
  Object.entries({ db: "pubmed", term: q, retstart: String((page-1)*pageSize), retmax: String(pageSize), retmode: "json", sort: "relevance", tool: "MedNovaAI" }).forEach(([k,v])=>searchUrl.searchParams.set(k,v));
  const sr = await fetch(searchUrl);
  if (!sr.ok) throw new Error("PubMed is temporarily unavailable. Please retry later.");
  const search = (await sr.json()).esearchresult || {};
  const ids = search.idlist || [];
  if (!ids.length) return { query:q, page, total:Number(search.count||0), results:[] };
  const summaryUrl = new URL(base + "esummary.fcgi");
  for (const [k,v] of Object.entries({db:"pubmed", id:ids.join(","), retmode:"json", tool:"MedNovaAI"})) summaryUrl.searchParams.set(k,v);
  const sumR = await fetch(summaryUrl);
  if (!sumR.ok) throw new Error("PubMed is temporarily unavailable. Please retry later.");
  const summary = (await sumR.json()).result || {};
  const abstractUrl = new URL(base + "efetch.fcgi");
  for (const [k,v] of Object.entries({db:"pubmed", id:ids.join(","), rettype:"abstract", retmode:"xml", tool:"MedNovaAI"})) abstractUrl.searchParams.set(k,v);
  let xml = "";
  try { const ar = await fetch(abstractUrl); if (ar.ok) xml = await ar.text(); } catch {}
  const abstracts = {};
  for (const block of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g)) {
    const part = block[0]; const pm = part.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    if (!pm) continue;
    const texts = [...part.matchAll(/<AbstractText\b[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(m => m[1].replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCharCode(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCharCode(Number(x))).replace(/\s+/g," ").trim());
    abstracts[pm[1]] = texts.filter(Boolean).join(" ");
  }
  const results = ids.map(id => {
    const item = summary[id] || {};
    return { pmid:id, title:item.title || "Untitled", authors:(item.authors||[]).slice(0,6).map(a=>a.name||""), journal:item.fulljournalname||item.source||"", pubdate:item.pubdate||"", doi:(item.articleids||[]).find(x=>x.idtype==="doi")?.value||null, url:`https://pubmed.ncbi.nlm.nih.gov/${id}/`, abstract:abstracts[id]||"Abstract text was not returned; open the PubMed record." };
  });
  return { query:q, page, total:Number(search.count||0), results };
}

async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/api/health" && method === "GET") return json({ status:"ok", service:"MedNova AI", ai_configured:!!env.GROQ_API_KEY, evidence_provider:"PubMed E-utilities", clinical_validation:false, hosting:"Cloudflare Workers" });
  if (!env.DB) return err(500, "Database binding DB is missing. Create a D1 database, run schema.sql, and bind it as DB in wrangler.jsonc.");
  if (path === "/api/auth/register" && method === "POST") {
    let data; try { data=await request.json(); } catch { return err(400,"Invalid JSON body"); }
    const email=String(data.email||"").trim().toLowerCase(), password=String(data.password||""), language=String(data.language||"en"), role=String(data.role||"general");
    if (email.length<5 || email.length>320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(422,"Enter a valid email address");
    if (password.length<10 || password.length>128) return err(422,"Password must be 10–128 characters");
    if (!LANGUAGES.has(language)) return err(422,"Unsupported language");
    if (!["general","student","professional"].includes(role)) return err(422,"Unsupported role");
    if (role==="professional") return err(403,"Professional access requires a verification workflow, which is not enabled in this starter");
    const existing=await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return err(409,"An account with this email already exists");
    const pw=await hashPassword(password);
    try {
      const result=await env.DB.prepare("INSERT INTO users (email,password_hash,password_salt,language,role,created_at) VALUES (?,?,?,?,?,?)").bind(email,pw.hash,pw.salt,language,role,new Date().toISOString()).run();
      const user={id:Number(result.meta.last_row_id),email,language,role};
      return json({access_token:await signToken(user,env.JWT_SECRET),token_type:"bearer",user},201);
    } catch(e) { return err(500,"Could not create account. Check the D1 schema and bindings."); }
  }
  if (path === "/api/auth/login" && method === "POST") {
    let data; try { data=await request.json(); } catch { return err(400,"Invalid JSON body"); }
    const email=String(data.email||"").trim().toLowerCase(), password=String(data.password||"");
    const user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!user || !(await verifyPassword(password,user.password_salt,user.password_hash))) return err(401,"Incorrect email or password");
    return json({access_token:await signToken(user,env.JWT_SECRET),token_type:"bearer",user:publicUser(user)});
  }
  const user=await requireUser(request,env);
  if (path === "/api/auth/me" && method === "GET") return user ? json(publicUser(user)) : err(401,"Please sign in again");
  if (path === "/api/auth/language" && method === "POST") {
    if (!user) return err(401,"Please sign in again");
    const data=await request.json().catch(()=>({})); const language=String(data.language||"");
    if (!LANGUAGES.has(language)) return err(422,"Unsupported language");
    await env.DB.prepare("UPDATE users SET language=? WHERE id=?").bind(language,user.id).run();
    return json({language});
  }
  if (path === "/api/chat" && method === "POST") {
    if (!user) return err(401,"Please sign in to chat");
    const data=await request.json().catch(()=>null);
    if (!data || typeof data.message!=="string" || !data.message.trim() || data.message.length>12000) return err(422,"Message must be 1–12000 characters");
    const language=LANGUAGES.has(data.language)?data.language:user.language;
    let conv;
    if (data.conversation_id) conv=await env.DB.prepare("SELECT * FROM conversations WHERE id=? AND user_id=?").bind(Number(data.conversation_id),user.id).first();
    if (data.conversation_id && !conv) return err(404,"Conversation not found");
    if (!conv) {
      const now=new Date().toISOString();
      const result=await env.DB.prepare("INSERT INTO conversations (user_id,title,language,created_at,updated_at) VALUES (?,?,?,?,?)").bind(user.id,data.message.slice(0,70),language,now,now).run();
      conv={id:Number(result.meta.last_row_id),user_id:user.id,title:data.message.slice(0,70),language};
    }
    await env.DB.prepare("INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)").bind(conv.id,"user",data.message,new Date().toISOString()).run();
    const history=await env.DB.prepare("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 20").bind(conv.id).all();
    let answer;
    try { answer=await groqChat(env,(history.results||[]).reverse(),language); }
    catch(e) { return err(502,e.message||"AI provider error"); }
    await env.DB.prepare("INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)").bind(conv.id,"assistant",answer,new Date().toISOString()).run();
    await env.DB.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(new Date().toISOString(),conv.id).run();
    return json({conversation_id:conv.id,answer,language,disclaimer:"AI-generated information can be inaccurate; this is not a diagnosis or a substitute for professional care."});
  }
  if (path === "/api/conversations" && method === "GET") {
    if (!user) return err(401,"Please sign in");
    const rows=await env.DB.prepare("SELECT id,title,language,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 100").bind(user.id).all();
    return json((rows.results||[]).map(c=>({...c,updated_at:c.updated_at})));
  }
  const convMatch=path.match(/^\/api\/conversations\/(\d+)$/);
  if (convMatch && user) {
    const id=Number(convMatch[1]);
    if (method==="GET") {
      const c=await env.DB.prepare("SELECT * FROM conversations WHERE id=? AND user_id=?").bind(id,user.id).first();
      if (!c) return err(404,"Conversation not found");
      const msgs=await env.DB.prepare("SELECT id,role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id").bind(id).all();
      return json({...c,messages:msgs.results||[]});
    }
    if (method==="DELETE") {
      const c=await env.DB.prepare("SELECT id FROM conversations WHERE id=? AND user_id=?").bind(id,user.id).first();
      if (!c) return err(404,"Conversation not found");
      await env.DB.prepare("DELETE FROM conversations WHERE id=?").bind(id).run();
      return json({deleted:true});
    }
  }
  if (path === "/api/evidence/pubmed" && method === "GET") {
    if (!user) return err(401,"Please sign in");
    try { return json(await pubmedSearch(url.searchParams.get("q"),url.searchParams.get("page"),url.searchParams.get("page_size"))); }
    catch(e) { return err(502,e.message||"PubMed is temporarily unavailable. Please retry later."); }
  }
  if (path === "/api/documents" && method === "POST") {
    if (!user) return err(401,"Please sign in");
    let form; try { form=await request.formData(); } catch { return err(400,"Upload a UTF-8 .txt file"); }
    const file=form.get("file");
    if (!file || typeof file==="string") return err(422,"Choose a text file");
    if (file.size>10*1024*1024) return err(413,"File exceeds the 10 MB limit");
    const name=String(file.name||"document.txt").split(/[\\/]/).pop().slice(0,255);
    if (!(file.type==="text/plain" || name.toLowerCase().endsWith(".txt"))) return err(415,"This Cloudflare edition currently supports UTF-8 .txt files. PDF extraction is not enabled in this deployment.");
    const raw=await file.arrayBuffer();
    let text; try { text=dec.decode(raw); } catch { return err(422,"Text file must be UTF-8 encoded"); }
    if (text.includes("\u0000")) return err(422,"File does not look like a UTF-8 text document");
    text=text.slice(0,500000);
    const result=await env.DB.prepare("INSERT INTO documents (user_id,filename,content_type,extracted_text,created_at) VALUES (?,?,?,?,?)").bind(user.id,name,"text/plain",text,new Date().toISOString()).run();
    return json({id:Number(result.meta.last_row_id),filename:name,content_type:"text/plain",characters_extracted:text.length,preview:text.slice(0,1200),note:"Text extraction only; not OCR and not clinically validated."},201);
  }
  if (path === "/api/documents" && method === "GET") {
    if (!user) return err(401,"Please sign in");
    const rows=await env.DB.prepare("SELECT id,filename,content_type,extracted_text,created_at FROM documents WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(user.id).all();
    return json((rows.results||[]).map(d=>({id:d.id,filename:d.filename,content_type:d.content_type,characters_extracted:(d.extracted_text||"").length,created_at:d.created_at})));
  }
  if (path.startsWith("/api/")) return err(404,"API endpoint not found");
  return env.ASSETS.fetch(request);
}
export default { async fetch(request, env) {
  try {
    const url=new URL(request.url);
    if (request.method==="OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null,{status:204,headers:{"access-control-allow-origin":url.origin,"access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"Authorization,Content-Type","access-control-max-age":"86400"}});
    return await handle(request,env);
  } catch (e) {
    return json({detail:"Unexpected server error. Check Worker logs for details."},500);
  }
}};
