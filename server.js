const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Supabaseヘルパー ─────────────────────────────────────
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, data: text }; }
}

// ── 患者API ──────────────────────────────────────────────
app.get("/api/patients", async (req, res) => {
  const r = await sbFetch("patients?order=created_at.desc");
  if (!r.ok) return res.status(500).json({ error: "取得失敗" });
  res.json(r.data);
});

app.post("/api/patients", async (req, res) => {
  const r = await sbFetch("patients", { method: "POST", body: JSON.stringify(req.body) });
  if (!r.ok) return res.status(500).json({ error: "保存失敗" });
  res.json(Array.isArray(r.data) ? r.data[0] : r.data);
});

// ── カルテAPI ────────────────────────────────────────────
app.get("/api/records", async (req, res) => {
  const { patient_id } = req.query;
  const path = patient_id
    ? `records?patient_id=eq.${patient_id}&order=visit_date.desc`
    : "records?order=visit_date.desc&limit=100";
  const r = await sbFetch(path);
  if (!r.ok) return res.status(500).json({ error: "取得失敗" });
  res.json(r.data);
});

app.post("/api/records", async (req, res) => {
  const r = await sbFetch("records", { method: "POST", body: JSON.stringify(req.body) });
  if (!r.ok) return res.status(500).json({ error: "保存失敗: " + JSON.stringify(r.data) });
  res.json(Array.isArray(r.data) ? r.data[0] : r.data);
});

app.delete("/api/records/:id", async (req, res) => {
  const r = await sbFetch(`records?id=eq.${req.params.id}`, { method: "DELETE" });
  res.json({ ok: true });
});

// ── multer ───────────────────────────────────────────────
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── 音声アップロードAPI ──────────────────────────────────
app.post("/api/upload-audio", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが必要です" });
  try {
    const mime = req.file.mimetype || "audio/mp4";
    const ext = mime.includes("mp4") || mime.includes("m4a") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
    const filename = `${Date.now()}.${ext}`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/audio/${filename}`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: req.file.buffer,
    });
    if (!uploadRes.ok) throw new Error(await uploadRes.text());
    res.json({ audio_url: `${SUPABASE_URL}/storage/v1/object/public/audio/${filename}` });
  } catch (e) {
    console.error("Audio upload error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── 文字起こしAPI ────────────────────────────────────────
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "音声ファイルが必要です" });
  try {
    const { OpenAI, toFile } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mime = req.file.mimetype || "";
    let ext = "webm";
    if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("mpeg")) ext = "mp4";
    else if (mime.includes("ogg")) ext = "ogg";
    else if (mime.includes("wav")) ext = "wav";
    const file = await toFile(req.file.buffer, `audio.${ext}`, { type: mime || "audio/mp4" });
    const result = await openai.audio.transcriptions.create({ file, model: "whisper-1", language: "ja" });
    res.json({ text: result.text });
  } catch (e) {
    console.error("Transcribe error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── SOAP生成API ──────────────────────────────────────────
app.post("/api/soap", async (req, res) => {
  const { transcript, patientContext } = req.body;
  if (!transcript) return res.status(400).json({ error: "テキストが必要です" });
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `あなたは歯科医師のカルテ作成支援AIです。
以下の患者情報と診療内容をもとに、SOAP形式のカルテを作成してください。

${patientContext ? "【患者情報】\n" + patientContext + "\n\n" : ""}【診療内容】
${transcript}

歯科SOAP形式で整理してください：
- S：患者の主訴・自覚症状
- O：診察所見・検査結果・X線所見
- A：診断・評価
- P：治療計画・処置内容・投薬

JSONのみで返答（前後のテキスト不要）：
{"S":"...","O":"...","A":"...","P":"..."}`;
    const msg = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content.map(b => b.text || "").join("");
    const soap = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json({ soap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── フロントエンド ────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="歯科カルテAI">
<title>歯科 SOAP カルテ AI</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@600&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--accent:#2d6a4f;--bg:#f5f3ee;--surface:#fff;--surface2:#f0ede6;--border:#ddd9d0;--border2:#c8c3b8;--text:#1a1916;--muted:#7a7468;--rec:#c62828;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:'Noto Sans JP',sans-serif;font-size:14px;}
header{background:var(--accent);color:white;padding:0 20px;height:52px;display:flex;align-items:center;position:sticky;top:0;z-index:100;box-shadow:0 2px 10px rgba(0,0,0,.2);}
.logo{font-family:'Noto Serif JP',serif;font-size:16px;font-weight:600;}
nav{background:var(--surface);border-bottom:2px solid var(--border);padding:0 16px;display:flex;overflow-x:auto;}
.tab{padding:12px 18px;font-size:13px;font-weight:500;color:var(--muted);border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-2px;cursor:pointer;white-space:nowrap;min-height:44px;font-family:inherit;}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);}
.badge{background:var(--accent);color:white;border-radius:10px;padding:1px 7px;font-size:10px;margin-left:4px;}
main{padding:16px;max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:16px;padding-bottom:40px;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.08);overflow:hidden;}
.card-hdr{padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface2);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);}
.card-body{padding:16px 20px;}
.fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:12px;margin-bottom:14px;}
.fg .w{grid-column:1/-1;}
.fl{font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;display:block;margin-bottom:4px;}
input,select,textarea{background:var(--surface);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:16px;font-family:inherit;color:var(--text);width:100%;-webkit-appearance:none;}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,106,79,.1);}
.tooth-chart{border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--surface2);}
.tc-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:10px;}
.tc-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.jaw{display:flex;align-items:center;gap:2px;margin-bottom:4px;min-width:max-content;}
.jl{font-size:10px;color:var(--muted);width:18px;text-align:center;flex-shrink:0;}
.jd{width:1px;height:24px;background:var(--border2);margin:0 4px;flex-shrink:0;}
.tooth{width:28px;height:28px;border:1px solid var(--border2);border-radius:4px;background:white;cursor:pointer;font-size:8px;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:monospace;}
.tooth.affected{background:#fff3e0;border-color:#b5541a;color:#b5541a;font-weight:700;}
.tooth.treated{background:#e8f5e9;border-color:#2d6a4f;color:#2d6a4f;font-weight:700;}
.tooth.missing{background:#fce4ec;border-color:#e91e63;color:#e91e63;font-weight:700;}
.tc-legend{display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;}
.li{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);}
.ld{width:12px;height:12px;border-radius:2px;border:1px solid;}
.vc{display:flex;align-items:center;gap:16px;padding:16px 20px;border-bottom:1px solid var(--border);}
.rb{width:64px;height:64px;border-radius:50%;border:2px solid var(--accent);background:rgba(45,106,79,.06);color:var(--accent);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s;}
.rb.rec{border-color:var(--rec);background:rgba(198,40,40,.08);color:var(--rec);animation:pulse 1.5s ease-in-out infinite;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(198,40,40,.3)}70%{box-shadow:0 0 0 12px rgba(198,40,40,0)}100%{box-shadow:0 0 0 0 rgba(198,40,40,0)}}
.vs{font-size:14px;font-weight:500;margin-bottom:4px;}
.vs.r{color:var(--rec);}
.vt{font-family:monospace;font-size:22px;letter-spacing:.05em;}
.uz{display:block;border:2px dashed var(--border2);border-radius:8px;padding:16px;text-align:center;cursor:pointer;margin:0 20px 16px;}
.uz p{font-size:13px;color:var(--muted);margin-bottom:2px;}
.uz small{font-size:11px;color:#a09890;}
.ts{padding:0 20px 20px;}
textarea#ta{min-height:130px;line-height:1.8;resize:vertical;margin-bottom:14px;}
.abtn{width:100%;padding:14px;background:var(--accent);color:white;border:none;border-radius:8px;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;}
.abtn:disabled{opacity:.5;cursor:not-allowed;}
.sbtn{padding:10px 20px;background:white;color:var(--accent);border:2px solid var(--accent);border-radius:8px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;min-height:44px;}
.sp{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;animation:spin .7s linear infinite;}
.sp2{width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg)}}
.err{color:var(--rec);font-size:13px;margin-top:10px;}
.ok{color:var(--accent);font-size:13px;margin-top:10px;}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
@media(max-width:600px){.sg{grid-template-columns:1fr}}
.sc{border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.sc.ss .sh{background:#e3f2fd;border-bottom:1px solid #bbdefb;}
.sc.so .sh{background:#e8f5e9;border-bottom:1px solid #c8e6c9;}
.sc.sa .sh{background:#fff3e0;border-bottom:1px solid #ffe0b2;}
.sc.sph .sh{background:#f3e5f5;border-bottom:1px solid #e1bee7;}
.sh{padding:10px 14px;display:flex;align-items:center;gap:10px;}
.sl{width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:18px;font-weight:700;color:white;flex-shrink:0;}
.sl.s{background:#1565c0}.sl.o{background:#2e7d32}.sl.a{background:#e65100}.sl.p{background:#6a1b9a}
.sn{font-size:12px;font-weight:700;}
.sc.ss .sn{color:#1565c0}.sc.so .sn{color:#2e7d32}.sc.sa .sn{color:#e65100}.sc.sph .sn{color:#6a1b9a}
.sn2{font-size:10px;color:var(--muted);}
.sb2{padding:14px;min-height:80px;}
.scont{font-size:13px;line-height:1.9;color:var(--text);white-space:pre-wrap;font-family:inherit;}
.sa2{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
.bsm{padding:8px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border2);background:white;color:var(--muted);font-family:inherit;min-height:36px;}
.bsm:hover{border-color:var(--accent);color:var(--accent);}
.danger:hover{border-color:var(--rec)!important;color:var(--rec)!important;}
.hh{padding:12px 16px;background:var(--surface2);border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;}
.hd{font-family:monospace;font-size:12px;color:var(--accent);font-weight:500;margin-right:8px;}
.hn{font-size:14px;font-weight:700;}
.hm{display:block;font-size:11px;color:var(--muted);margin-top:2px;}
.hb{margin-left:auto;display:flex;gap:6px;flex-shrink:0;}
.hsoap{padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
@media(max-width:500px){.hsoap{grid-template-columns:1fr}}
.hsi-l{font-family:monospace;font-size:11px;font-weight:700;margin-bottom:3px;}
.hsi-l.s{color:#1565c0}.hsi-l.o{color:#2e7d32}.hsi-l.a{color:#e65100}.hsi-l.p{color:#6a1b9a}
.hsi-t{font-size:12px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.empty{text-align:center;padding:60px 20px;color:var(--muted);}
.srch{display:flex;gap:8px;margin-bottom:12px;}
.srch input{flex:1;}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2d6a4f;color:white;padding:10px 20px;border-radius:24px;font-size:13px;z-index:9999;max-width:90vw;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;}
.toast.err{background:var(--rec);}
.page{display:none;}
.page.active{display:block;}
.loading{text-align:center;padding:40px;color:var(--muted);}
</style>
</head>
<body>
<header><span class="logo">歯科 SOAP カルテ AI</span></header>
<nav>
  <button class="tab active" onclick="showTab('input',this)">新規カルテ</button>
  <button class="tab" onclick="showTab('history',this)">カルテ履歴 <span class="badge" id="hbadge">0</span></button>
  <button class="tab" onclick="showTab('patients',this)">患者管理</button>
</nav>

<!-- 新規カルテ -->
<div class="page active" id="page-input">
<main>
  <div class="card">
    <div class="card-hdr">患者情報</div>
    <div class="card-body">
      <div class="fg">
        <div><label class="fl">患者氏名</label><input type="text" id="pName" placeholder="山田 太郎"></div>
        <div><label class="fl">生年月日</label><input type="date" id="pDob"></div>
        <div><label class="fl">性別</label><select id="pGender"><option value="">——</option><option>男性</option><option>女性</option><option>その他</option></select></div>
        <div><label class="fl">患者ID</label><input type="text" id="pId" placeholder="PT-0001"></div>
        <div><label class="fl">診療日</label><input type="date" id="pDate"></div>
        <div><label class="fl">担当医</label><input type="text" id="pDoc"></div>
        <div><label class="fl">保険種別</label><select id="pIns"><option value="">——</option><option>社会保険</option><option>国民健康保険</option><option>後期高齢者医療</option><option>労災</option><option>自費</option></select></div>
        <div class="w"><label class="fl">既往歴・アレルギー</label><input type="text" id="pHist" placeholder="例：高血圧、ペニシリンアレルギー"></div>
      </div>
      <div class="tooth-chart">
        <div class="tc-label">歯式チャート（タップでマーク）</div>
        <div class="tc-scroll" id="tcArea"></div>
        <div class="tc-legend">
          <span class="li"><span class="ld" style="background:#fff3e0;border-color:#b5541a"></span>患部</span>
          <span class="li"><span class="ld" style="background:#e8f5e9;border-color:#2d6a4f"></span>処置済</span>
          <span class="li"><span class="ld" style="background:#fce4ec;border-color:#e91e63"></span>欠損</span>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hdr">音声入力</div>
    <div class="vc">
      <button class="rb" id="recBtn" onclick="toggleRec()">
        <svg id="micSvg" viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1.5 14.93A7 7 0 0 1 5 9H3a9 9 0 0 0 8 8.94V21H9v2h6v-2h-2v-2.07z"/></svg>
      </button>
      <div>
        <div class="vs" id="vStatus">タップして録音開始</div>
        <div class="vt" id="vTimer">00:00</div>
      </div>
    </div>
    <label class="uz">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#7a7468" style="display:block;margin:0 auto 6px"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
      <p>音声ファイルをアップロード</p><small>MP3 / WAV / M4A 対応</small>
      <input type="file" accept="audio/*" onchange="uploadAudioFile(event)" style="display:none">
    </label>
    <div id="audioWrap" style="padding:0 20px 12px;display:none">
      <audio id="audioEl" controls style="width:100%;border-radius:6px"></audio>
    </div>
    <div class="ts">
      <label class="fl" style="display:block;margin-bottom:8px">文字起こし / 診療メモ（編集可能）</label>
      <textarea id="ta" rows="8" placeholder="録音後ここに文字起こしが表示されます。または直接入力してください。&#10;&#10;例：患者は右下6番が3日前から痛いと来院。咬合痛あり。打診痛+。X線にて根尖部透過像確認。"></textarea>
      <button class="abtn" id="aBtn" onclick="analyze()">SOAP形式でAI分析・カルテ生成</button>
      <div class="err" id="errMsg"></div>
    </div>
  </div>

  <div class="card" id="soapCard" style="display:none">
    <div class="card-hdr">SOAP カルテ出力</div>
    <div class="card-body">
      <div class="sg">
        <div class="sc ss"><div class="sh"><span class="sl s">S</span><div><div class="sn">Subjective</div><div class="sn2">主訴・主観的情報</div></div></div><div class="sb2"><div id="sc-s" class="scont"></div></div></div>
        <div class="sc so"><div class="sh"><span class="sl o">O</span><div><div class="sn">Objective</div><div class="sn2">客観的情報・所見</div></div></div><div class="sb2"><div id="sc-o" class="scont"></div></div></div>
        <div class="sc sa"><div class="sh"><span class="sl a">A</span><div><div class="sn">Assessment</div><div class="sn2">評価・診断</div></div></div><div class="sb2"><div id="sc-a" class="scont"></div></div></div>
        <div class="sc sph"><div class="sh"><span class="sl p">P</span><div><div class="sn">Plan</div><div class="sn2">治療計画</div></div></div><div class="sb2"><div id="sc-p" class="scont"></div></div></div>
      </div>
      <div class="sa2">
        <button class="abtn" id="saveBtn" onclick="saveRecord()" style="flex:1">💾 カルテを保存（クラウド）</button>
        <button class="sbtn" onclick="printSoap()">🖨️ PDF</button>
      </div>
      <div id="saveMsg"></div>
    </div>
  </div>
</main>
</div>

<!-- カルテ履歴 -->
<div class="page" id="page-history">
<main>
  <div class="srch">
    <input type="text" id="searchInput" placeholder="患者名・日付・診断名で検索..." oninput="filterHistory()">
  </div>
  <div id="histList"><div class="loading"><span class="sp2"></span> 読み込み中...</div></div>
</main>
</div>

<!-- 患者管理 -->
<div class="page" id="page-patients">
<main>
  <div id="patList"><div class="loading"><span class="sp2"></span> 読み込み中...</div></div>
</main>
</div>

<div class="toast" id="toast"></div>

<script>
document.getElementById('pDate').value=new Date().toISOString().slice(0,10);

// 歯式
const UPPER=[18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
const LOWER=[48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];
const TS=['','affected','treated','missing'];
const toothSt={};
function buildChart(){
  const area=document.getElementById('tcArea');
  [UPPER,LOWER].forEach((row,ri)=>{
    const d=document.createElement('div');d.className='jaw';
    const lbl=document.createElement('span');lbl.className='jl';lbl.textContent=ri===0?'上':'下';d.appendChild(lbl);
    row.slice(0,8).forEach(n=>d.appendChild(mkTooth(n)));
    const dv=document.createElement('span');dv.className='jd';d.appendChild(dv);
    row.slice(8).forEach(n=>d.appendChild(mkTooth(n)));
    area.appendChild(d);
  });
}
function mkTooth(n){
  const t=document.createElement('div');t.className='tooth';t.textContent=n;t.id='t'+n;
  t.onclick=()=>{const c=toothSt[n]||'';const nx=TS[(TS.indexOf(c)+1)%TS.length];toothSt[n]=nx;t.className='tooth'+(nx?' '+nx:'');};
  return t;
}
buildChart();
function getTeeth(){return Object.entries(toothSt).filter(([,v])=>v).map(([k,v])=>k+'('+(v==='affected'?'患部':v==='treated'?'処置済':'欠損')+')').join(', ');}

// タブ
function showTab(t,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+t).classList.add('active');
  el.classList.add('active');
  if(t==='history')loadHistory();
  if(t==='patients')loadPatients();
}

// 録音
let mr=null,chunks=[],recOn=false,timerInt=null,sec=0,currentAudioBlob=null;
function toggleRec(){recOn?stopRec():startRec();}
async function startRec(){
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||'';
    mr=new MediaRecorder(stream,mime?{mimeType:mime}:{});
    chunks=[];currentAudioBlob=null;
    mr.ondataavailable=e=>{if(e.data?.size>0)chunks.push(e.data);};
    mr.onstop=async()=>{
      const blob=new Blob(chunks,{type:chunks[0]?.type||'audio/mp4'});
      currentAudioBlob=blob;
      document.getElementById('audioEl').src=URL.createObjectURL(blob);
      document.getElementById('audioWrap').style.display='block';
      await sendWhisper(blob);
    };
    mr.start(1000);recOn=true;sec=0;
    timerInt=setInterval(()=>{sec++;const m=String(Math.floor(sec/60)).padStart(2,'0'),s=String(sec%60).padStart(2,'0');document.getElementById('vTimer').textContent=m+':'+s;},1000);
    document.getElementById('recBtn').classList.add('rec');
    document.getElementById('vStatus').textContent='録音中… タップで停止';
    document.getElementById('vStatus').className='vs r';
    document.getElementById('micSvg').innerHTML='<path d="M6 6h12v12H6z"/>';
  }catch(e){
    toast(e.name==='NotAllowedError'?'マイクの使用を許可してください':'録音できません。テキストを直接入力してください。','err');
  }
}
function stopRec(){
  mr?.stop();mr?.stream.getTracks().forEach(t=>t.stop());
  clearInterval(timerInt);recOn=false;
  document.getElementById('recBtn').classList.remove('rec');
  document.getElementById('vStatus').textContent='文字起こし中...';
  document.getElementById('vStatus').className='vs';
  document.getElementById('micSvg').innerHTML='<path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1.5 14.93A7 7 0 0 1 5 9H3a9 9 0 0 0 8 8.94V21H9v2h6v-2h-2v-2.07z"/>';
}
async function uploadAudioFile(e){
  const f=e.target.files[0];if(!f)return;
  currentAudioBlob=f;
  document.getElementById('audioEl').src=URL.createObjectURL(f);
  document.getElementById('audioWrap').style.display='block';
  document.getElementById('vStatus').textContent='文字起こし中...';
  await sendWhisper(f);
}
async function sendWhisper(blob){
  const ext=(blob.type||'').includes('mp4')?'mp4':(blob.type||'').includes('ogg')?'ogg':'webm';
  const fd=new FormData();fd.append('audio',blob,'rec.'+ext);
  try{
    const r=await fetch('/api/transcribe',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    const ta=document.getElementById('ta');
    ta.value=(ta.value?ta.value+'\\n':'')+d.text;
    toast('文字起こし完了');
  }catch(e){toast('文字起こし失敗: '+e.message,'err');}
  document.getElementById('vStatus').textContent='タップして録音開始';
  document.getElementById('vStatus').className='vs';
}

// SOAP分析
let currentSoap=null;
async function analyze(){
  const tr=document.getElementById('ta').value.trim();
  if(!tr){toast('テキストを入力してください','err');return;}
  const btn=document.getElementById('aBtn');
  btn.disabled=true;btn.innerHTML='<div class="sp"></div> AIが分析中...';
  document.getElementById('errMsg').textContent='';
  document.getElementById('soapCard').style.display='none';
  const ctx=[
    document.getElementById('pName').value&&'患者名：'+document.getElementById('pName').value,
    document.getElementById('pDob').value&&'年齢：'+calcAge(document.getElementById('pDob').value),
    document.getElementById('pGender').value&&'性別：'+document.getElementById('pGender').value,
    getTeeth()&&'歯式：'+getTeeth(),
    document.getElementById('pHist').value&&'既往歴：'+document.getElementById('pHist').value,
  ].filter(Boolean).join('\\n');
  try{
    const r=await fetch('/api/soap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:tr,patientContext:ctx})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    currentSoap=d.soap;
    ['s','o','a','p'].forEach(k=>{document.getElementById('sc-'+k).textContent=d.soap[k.toUpperCase()]||'記録なし';});
    document.getElementById('soapCard').style.display='block';
  }catch(e){document.getElementById('errMsg').textContent='エラー: '+e.message;}
  btn.disabled=false;btn.textContent='SOAP形式でAI分析・カルテ生成';
}

// カルテ保存
async function saveRecord(){
  if(!currentSoap){toast('先にSOAPを生成してください','err');return;}
  const btn=document.getElementById('saveBtn');
  const msg=document.getElementById('saveMsg');
  btn.disabled=true;btn.innerHTML='<div class="sp"></div> 保存中...';
  msg.textContent='';msg.className='';
  try{
    let audio_url=null;
    if(currentAudioBlob){
      const ext=(currentAudioBlob.type||'').includes('mp4')?'mp4':(currentAudioBlob.type||'').includes('ogg')?'ogg':'webm';
      const fd=new FormData();fd.append('audio',currentAudioBlob,'rec.'+ext);
      const ar=await fetch('/api/upload-audio',{method:'POST',body:fd});
      if(ar.ok){const ad=await ar.json();audio_url=ad.audio_url;}
    }
    const pr=await fetch('/api/patients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      name:document.getElementById('pName').value||'（未入力）',
      dob:document.getElementById('pDob').value||null,
      gender:document.getElementById('pGender').value,
      patient_id:document.getElementById('pId').value,
      insurance:document.getElementById('pIns').value,
      history:document.getElementById('pHist').value,
    })});
    const pat=await pr.json();
    const rr=await fetch('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      patient_id:pat.id,
      visit_date:document.getElementById('pDate').value||new Date().toISOString().slice(0,10),
      doctor:document.getElementById('pDoc').value,
      teeth_chart:toothSt,
      transcript:document.getElementById('ta').value,
      soap_s:currentSoap.S,soap_o:currentSoap.O,soap_a:currentSoap.A,soap_p:currentSoap.P,
      audio_url,
    })});
    if(!rr.ok)throw new Error('カルテの保存に失敗しました');
    toast('カルテを保存しました！');
    msg.textContent='✓ クラウドに保存されました';msg.className='ok';
  }catch(e){
    toast('保存失敗: '+e.message,'err');
  }
  btn.disabled=false;btn.innerHTML='💾 カルテを保存（クラウド）';
}

// 履歴
let allRecords=[];
async function loadHistory(){
  document.getElementById('histList').innerHTML='<div class="loading"><span class="sp2"></span> 読み込み中...</div>';
  try{
    const r=await fetch('/api/records');
    allRecords=await r.json();
    document.getElementById('hbadge').textContent=allRecords.length;
    renderHistory(allRecords);
  }catch(e){document.getElementById('histList').innerHTML='<div class="empty">読み込みに失敗しました</div>';}
}
function filterHistory(){
  const q=document.getElementById('searchInput').value.toLowerCase();
  renderHistory(q?allRecords.filter(e=>(e.patient_name||'').toLowerCase().includes(q)||(e.visit_date||'').includes(q)||(e.soap_a||'').toLowerCase().includes(q)):allRecords);
}
function renderHistory(records){
  const el=document.getElementById('histList');
  if(!records.length){el.innerHTML='<div class="card"><div class="empty">カルテがありません</div></div>';return;}
  el.innerHTML=records.map(e=>\`
<div class="card" style="margin-bottom:12px">
  <div class="hh">
    <div>
      <span class="hd">\${e.visit_date||'——'}</span>
      <span class="hn">\${e.patient_name||'（名前なし）'}</span>
      \${e.doctor?'<span class="hm">担当: '+e.doctor+'</span>':''}
    </div>
    <div class="hb">
      \${e.audio_url?'<a href="'+e.audio_url+'" target="_blank" class="bsm">🔊</a>':''}
      <button class="bsm" onclick='doPrint(\${JSON.stringify(JSON.stringify(e))})'>🖨️</button>
      <button class="bsm danger" onclick="delRecord('\${e.id}')">削除</button>
    </div>
  </div>
  <div class="hsoap">
    \${['s','o','a','p'].map(l=>\`<div><div class="hsi-l \${l}">\${l.toUpperCase()}</div><div class="hsi-t">\${e['soap_'+l]||'——'}</div></div>\`).join('')}
  </div>
</div>\`).join('');
}
function doPrint(jsonStr){
  const e=JSON.parse(jsonStr);
  printEntry({name:e.patient_name||'',date:e.visit_date||'',doctor:e.doctor||'',insurance:'',teeth:'',soap:{S:e.soap_s,O:e.soap_o,A:e.soap_a,P:e.soap_p}});
}
async function delRecord(id){
  if(!confirm('このカルテを削除しますか？'))return;
  await fetch('/api/records/'+id,{method:'DELETE'});
  loadHistory();toast('削除しました');
}

// 患者管理
async function loadPatients(){
  document.getElementById('patList').innerHTML='<div class="loading"><span class="sp2"></span> 読み込み中...</div>';
  try{
    const r=await fetch('/api/patients');
    const patients=await r.json();
    if(!patients.length){
      document.getElementById('patList').innerHTML='<div class="card"><div class="empty">患者データがありません<br><small>カルテを保存すると登録されます</small></div></div>';return;
    }
    document.getElementById('patList').innerHTML=patients.map(p=>\`
<div class="card" style="margin-bottom:12px">
  <div class="hh">
    <div>
      <span class="hn">\${p.name||'——'}</span>
      \${p.dob?'<span class="hm">'+calcAge(p.dob)+'</span>':''}
      \${p.gender?'<span class="hm">'+p.gender+'</span>':''}
      \${p.patient_id?'<span class="hm">ID: '+p.patient_id+'</span>':''}
      \${p.history?'<span class="hm">既往歴: '+p.history+'</span>':''}
    </div>
    <div class="hb">
      <button class="bsm" onclick="loadPatRec('\${p.id}','\${(p.name||'').replace(/'/g,'')}\')">カルテ一覧</button>
    </div>
  </div>
</div>\`).join('');
  }catch(e){document.getElementById('patList').innerHTML='<div class="empty">読み込みに失敗しました</div>';}
}
async function loadPatRec(pid,name){
  document.getElementById('patList').innerHTML='<div class="loading"><span class="sp2"></span> 読み込み中...</div>';
  const r=await fetch('/api/records?patient_id='+pid);
  const records=await r.json();
  allRecords=[...allRecords,...records];
  document.getElementById('patList').innerHTML=\`
<button class="bsm" onclick="loadPatients()" style="margin-bottom:12px">← 患者一覧に戻る</button>
<div style="font-size:16px;font-weight:700;margin-bottom:12px">\${name} のカルテ一覧（\${records.length}件）</div>
\${records.length?records.map(e=>\`
<div class="card" style="margin-bottom:12px">
  <div class="hh">
    <div><span class="hd">\${e.visit_date||'——'}</span>\${e.doctor?'<span class="hm">担当: '+e.doctor+'</span>':''}</div>
    <div class="hb">
      \${e.audio_url?'<a href="'+e.audio_url+'" target="_blank" class="bsm">🔊 音声再生</a>':''}
      <button class="bsm" onclick='doPrint(\${JSON.stringify(JSON.stringify(e))})'>🖨️ PDF</button>
    </div>
  </div>
  <div class="hsoap">
    \${['s','o','a','p'].map(l=>\`<div><div class="hsi-l \${l}">\${l.toUpperCase()}</div><div class="hsi-t">\${e['soap_'+l]||'——'}</div></div>\`).join('')}
  </div>
</div>\`).join(''):'<div class="card"><div class="empty">カルテがありません</div></div>'}
\`;
}

// PDF出力
function printSoap(){
  printEntry({name:document.getElementById('pName').value,dob:document.getElementById('pDob').value,gender:document.getElementById('pGender').value,date:document.getElementById('pDate').value,doctor:document.getElementById('pDoc').value,insurance:document.getElementById('pIns').value,teeth:getTeeth(),soap:currentSoap});
}
function printEntry(e){
  const html=\`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>歯科診療録</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@600&family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
<style>body{font-family:'Noto Sans JP',sans-serif;font-size:11pt;color:#111;margin:15mm}h1{font-family:'Noto Serif JP',serif;font-size:15pt;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:6px;margin-bottom:12px}.meta{font-size:10pt;color:#555;margin-bottom:18px}.meta div{margin-bottom:3px}.si{border:1px solid #ccc;border-radius:6px;margin-bottom:12px;overflow:hidden;page-break-inside:avoid}.sh{padding:6px 12px;font-weight:700;font-size:10pt}.ss .sh{background:#e3f2fd;color:#1565c0}.so .sh{background:#e8f5e9;color:#2e7d32}.sa .sh{background:#fff3e0;color:#e65100}.sp .sh{background:#f3e5f5;color:#6a1b9a}.sb{padding:10px 12px;line-height:1.8;white-space:pre-wrap}</style>
</head><body>
<h1>歯科診療録</h1>
<div class="meta">
<div><b>患者氏名：</b>\${e.name||'—'}\${e.dob?' / '+calcAge(e.dob):''}\${e.gender?' / '+e.gender:''}</div>
<div><b>診療日：</b>\${e.date||'—'}</div>
\${e.doctor?'<div><b>担当医：</b>'+e.doctor+'</div>':''}
\${e.insurance?'<div><b>保険：</b>'+e.insurance+'</div>':''}
\${e.teeth?'<div><b>歯式：</b>'+e.teeth+'</div>':''}
</div>
\${[['S','主訴・主観的情報','ss'],['O','客観的情報・所見','so'],['A','評価・診断','sa'],['P','治療計画','sp']].map(([l,n,c])=>\`<div class="si \${c}"><div class="sh">\${l} — \${n}</div><div class="sb">\${e.soap?.[l]||'記録なし'}</div></div>\`).join('')}
</body></html>\`;
  const blob=new Blob([html],{type:'text/html'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.target='_blank';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}

// ユーティリティ
function calcAge(dob){
  if(!dob)return'';
  const b=new Date(dob),t=new Date();
  let a=t.getFullYear()-b.getFullYear();
  if(t.getMonth()-b.getMonth()<0||(t.getMonth()===b.getMonth()&&t.getDate()<b.getDate()))a--;
  return a+'歳';
}
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='toast'+(type?' '+type:'');
  el.style.display='block';clearTimeout(el._t);
  el._t=setTimeout(()=>el.style.display='none',type?5000:2500);
}
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
