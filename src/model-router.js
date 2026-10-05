// OpenCode Model Router (display ad) - per-agent primary/secondary/tertiary model routing
// OpenCode Model Router faz-2 (question-aracili grafik secim akisi) — kilitli kararlar ozeti:
//  1) Zincir girisi { providerID, id, variant? }; dedup anahtari providerID/id/variant — model adi tek basina yok.
//  2) Ajan kesfi YALNIZCA `await ctx.agent.transform(draft => { listed = [...draft.list()]; })` capture kalibiyla
//     (donus degeri liste sanilmaz; guard yoksa sessiz gec); elemanlar AgentV2Info objesi → `id` alani okunur,
//     string gelirse aynen kabul. Siralama: bilinen grup sabit sirada
//     (orchestrator, explorer, librarian, oracle, designer, fixer, observer, council/councillor),
//     bilinmeyenler alfabetik "diger" kovasi.
//  3) hasOhMy probe: ctx uzerinde oh-my izi veya config `agents` blogu varsa oh-my yolu, yoksa host yolu.
//  4) `/model-router` komutu: `execute: async (invocation) => ...`; once `invocation?.sessionID` ile
//     `ctx.session.prompt({ sessionID, text: TALIMAT })` (guard'li), prompt API yoksa eski fallback zinciri
//     (append/say/message) ile talimati yazar. TALIMAT: agent `question` tool ile TEK modalda 4 soru sorar
//     (ajan, primary, secondary, tertiary-atlanabilir); sonucu state dosyasina yazar; primary'yi HEMEN uygular;
//     secondary/tertiary her zaman sadece state dosyasinda durur
//     (retry steering sonraki fazda bu dosyayi okuyacak).
//  5) retry hook (`await ctx.session.hook("retry", ...)`) faz-2'de de sadece loglar, event.decision'a DOKUNMAZ
//     (steering sonraki faz). Katalog disi model/provider adi hardcode YOK; liste her zaman ctx'ten.
//     `setup` async'tir (transform/hook `await` ile kurulur); dispose senkron kalir.
// Sonraki adim: retry steering (switchModel + state dosyasi okuma).

// State dosyasi formati: { version: 1, updatedAt, chains: { <ajan>: {
//   primary: { providerID, id, variant? }, secondary: { ... }, tertiary: { ... } | null } } }
// State yolu: C:\Users\Hb\.config\opencode\model-router.json

// Bilinen ajan grubu: sabit sira. Katalogdan gelmeyen adlar alfabetik "diger" kovasina duser.
const KNOWN_ORDER = [
  "orchestrator",
  "explorer",
  "librarian",
  "oracle",
  "designer",
  "fixer",
  "observer",
  "council",
  "councillor",
];

const STATE_PATH = "C:\\Users\\Hb\\.config\\opencode\\model-router.json";

async function setup(ctx) {
  console.log("[model-router] v2 setup invoked");

  // Her registration'in disposer'i burada toplanir; setup'un dondurdugu dispose hepsini calistirir.
  // track(): promise degil Registration/dispose-fn kabul eder — `await` sonrasi donen `reg` objesinde
  // `dispose` varsa `() => reg.dispose()` kaydedilir, fonksiyon ise aynen kaydedilir.
  const disposers = [];
  const track = (reg) => {
    if (typeof reg === "function") disposers.push(reg);
    else if (reg != null && typeof reg.dispose === "function")
      disposers.push(() => {
        const r = reg.dispose();
        if (r != null && typeof r.catch === "function")
          r.catch((err) => console.log("[model-router] dispose error", err?.message ?? err));
      });
  };

  // Karar 1 — zincir girisi { providerID, id, variant? }; dedup anahtari providerID/id/variant.
  const chainKey = (e) =>
    `${e?.providerID ?? ""}/${e?.id ?? ""}${e?.variant ? `#${e.variant}` : ""}`;
  const dedupChain = (list) => {
    const seen = new Set();
    const out = [];
    for (const e of list ?? []) {
      const k = chainKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  };

  // Karar 2 — ajan kesfi: `await ctx.agent.transform` + dis degiskene capture; guard yoksa sessiz gec.
  const listAgents = async () => {
    try {
      if (typeof ctx.agent?.transform !== "function") return [];
      let listed = [];
      await ctx.agent.transform(async (draft) => {
        const l = await draft.list();
        listed = Array.isArray(l) ? [...l] : [];
      });
      return listed
        .map((a) => (typeof a === "string" ? a : a?.id))
        .filter((n) => typeof n === "string" && n.length > 0);
    } catch (err) {
      console.log("[model-router] agent list failed", err?.message ?? err);
      return [];
    }
  };

  // Karar 2 — siralama: bilinenler sabit sirada, bilinmeyenler alfabetik.
  const sortAgents = (names) => {
    const rank = new Map(KNOWN_ORDER.map((n, i) => [n, i]));
    return [...names].sort((a, b) => {
      const ra = rank.has(a.toLowerCase()) ? rank.get(a.toLowerCase()) : Infinity;
      const rb = rank.has(b.toLowerCase()) ? rank.get(b.toLowerCase()) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  };

  // Karar 3 — hasOhMy tespiti: DOSYA VARLIGINDAN (runtime'da ctx.catalog/ctx.config YOK).
  // Env override (test edilebilirlik): MODEL_ROUTER_OHMY_PATH.
  // Prod sirasi: ~/.config/opencode/oh-my-opencode-slim.json, sonra .jsonc.
  // Tum dosya erisimleri dinamik import + guard'li; tespit asla setup'u devirmez.
  const evDizini = () => {
    try {
      return process.env.USERPROFILE || process.env.HOME || "";
    } catch {
      return "";
    }
  };
  const ohmyAdaylar = () => {
    const out = [];
    try {
      const p = process.env.MODEL_ROUTER_OHMY_PATH;
      if (typeof p === "string" && p.length > 0) out.push(p);
    } catch {}
    try {
      const b = evDizini();
      if (b) {
        out.push(`${b}/.config/opencode/oh-my-opencode-slim.json`);
        out.push(`${b}/.config/opencode/oh-my-opencode-slim.jsonc`);
      }
    } catch {}
    return out;
  };
  const ohmyCozumle = async () => {
    const adaylar = ohmyAdaylar();
    try {
      const fs = await import("node:fs/promises");
      for (const p of adaylar) {
        try {
          await fs.access(p);
          return { path: p, exists: true };
        } catch {}
      }
    } catch {}
    return { path: adaylar[0] || "", exists: false };
  };
  const probeOhMy = async () => {
    const signals = [];
    try {
      if (ctx?.ohMy != null || ctx?.["oh-my"] != null) signals.push("ctx oh-my key");
    } catch {
      // probe asla setup'u devirmez
    }
    try {
      const o = await ohmyCozumle();
      if (o.exists) signals.push("oh-my file");
    } catch {
      // probe asla setup'u devirmez
    }
    return { hasOhMy: signals.length > 0, signals };
  };

  // Katalog = opencode'un yukledigi aktif provider setidir (auth'suz provider katalogda
  // yoktur — bu yuzden yalnizca auth'lu saglayicilar listelenir; kural otomatik saglanir).
  // Gercek API: ctx.catalog.transform (v2 PluginContext'te model/provider/session alani yok).
  // Filtre: SADECE enabled modeller listelenir (/models secicisiyle ayni kural).
  //   - provider kaydi `disabled === true` ise o provider ATLANIR (devre-disi sayacina).
  //   - model `info?.enabled !== true` ise ATLANIR (kapali sayacina; status'e bakilmaz).
  // Faz-3 — katalog + baglanti + gorunurluk (ayarlar > modeller ekranini aynen yansitir).
  // Katalog HAM toplanir (eleme yok); eleme execute aninda uygulanir cunku korumali
  // saglayicilar (mevcut atamalar + state zincirleri) ancak orada bilinir.
  // Tum kaynaklar guard'li + fail-open; sirlar (token/deger) ASLA okunmaz ve loglanmaz.
  const ENV_SAGLAYICI = { OPENROUTER_API_KEY: "openrouter", DEEPSEEK_API_KEY: "deepseek", ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "openai", GEMINI_API_KEY: "gemini", GOOGLE_GENERATIVE_AI_API_KEY: "gemini", GROQ_API_KEY: "groq", MISTRAL_API_KEY: "mistral", XAI_API_KEY: "xai", CEREBRAS_API_KEY: "cerebras", COHERE_API_KEY: "cohere" };
  const evKlasoru = (() => { try { return process.env.USERPROFILE || process.env.HOME || ""; } catch { return ""; } })();
  const dosyaOku = async (yol) => { try { const fs = await import("node:fs/promises"); return await fs.readFile(yol, "utf8"); } catch { return null; } };
  const sqliteSorgu = async (dbYolu, sql) => {
    try {
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbYolu, { readonly: true });
        try { return db.query(sql).all(); } finally { try { db.close(); } catch {} }
      } catch {}
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbYolu);
        try { return db.prepare(sql).all(); } finally { try { db.close(); } catch {} }
      } catch {}
    } catch {}
    return null;
  };
  // Gorunurluk deposu okuma: state(name,key,value) semasi (Desktop drafts.sqlite:
  // name='opencode.global.dat', key='model'). Tablo adi sabitlenmez — name/key/value
  // kolonlu tablolar kesfedilir; bulunamazsa eski tek-sutun aramaya dusulur.
  const sqliteModelDeger = async (dbYolu) => {
    try {
      const tablolar = await sqliteSorgu(dbYolu, "SELECT name FROM sqlite_master WHERE type='table'");
      if (Array.isArray(tablolar)) {
        for (const satir of tablolar) {
          const tablo = (satir && (satir.name ?? satir.tbl_name)) || null;
          if (typeof tablo !== "string" || tablo.startsWith("sqlite_")) continue;
          const gT = tablo.replace(/"/g, "");
          let kolonlar = [];
          try {
            const bilgi = await sqliteSorgu(dbYolu, `PRAGMA table_info("${gT}")`);
            if (Array.isArray(bilgi)) kolonlar = bilgi.map((k) => k?.name).filter((k) => typeof k === "string");
          } catch { continue; }
          const alt = kolonlar.map((k) => k.toLowerCase());
          const adKolon = kolonlar[alt.indexOf("name")] ?? null;
          const anahtarKolon = kolonlar[alt.indexOf("key")] ?? null;
          const degerKolon = kolonlar[alt.indexOf("value")] ?? null;
          if (adKolon && anahtarKolon && degerKolon) {
            try {
              const kayitlar = await sqliteSorgu(dbYolu, `SELECT "${degerKolon.replace(/"/g, "")}" AS v FROM "${gT}" WHERE "${adKolon.replace(/"/g, "")}" = 'opencode.global.dat' AND "${anahtarKolon.replace(/"/g, "")}" = 'model' LIMIT 3`);
              if (Array.isArray(kayitlar)) for (const k of kayitlar) {
                if (typeof k?.v === "string" && k.v.length > 0) return k.v;
              }
            } catch {}
          }
        }
      }
      const eski = await sqliteDegerBul(dbYolu, "opencode.global.datmodel");
      if (typeof eski === "string") return eski;
    } catch {}
    return null;
  };
  const sqliteDegerBul = async (dbYolu, anahtar) => {
    const gAnahtar = String(anahtar).replace(/'/g, "''");
    try {
      const tablolar = await sqliteSorgu(dbYolu, "SELECT name FROM sqlite_master WHERE type='table'");
      if (!Array.isArray(tablolar)) return null;
      for (const satir of tablolar) {
        const tablo = (satir && (satir.name ?? satir.tbl_name)) || null;
        if (typeof tablo !== "string" || tablo.startsWith("sqlite_")) continue;
        const gTablo = tablo.replace(/"/g, "");
        let kolonlar = [];
        try {
          const bilgi = await sqliteSorgu(dbYolu, `PRAGMA table_info("${gTablo}")`);
          if (Array.isArray(bilgi)) kolonlar = bilgi.map((k) => k?.name).filter((k) => typeof k === "string");
        } catch { continue; }
        for (const kolon of kolonlar) {
          const gKolon = String(kolon).replace(/"/g, "");
          let kayitlar = null;
          try { kayitlar = await sqliteSorgu(dbYolu, `SELECT * FROM "${gTablo}" WHERE "${gKolon}" = '${gAnahtar}' LIMIT 5`); } catch { continue; }
          if (!Array.isArray(kayitlar) || kayitlar.length === 0) continue;
          for (const kayit of kayitlar) {
            let enUzun = null;
            for (const k of Object.keys(kayit)) {
              const v = kayit[k];
              if (typeof v === "string" && v !== anahtar && (enUzun == null || v.length > enUzun.length)) enUzun = v;
            }
            if (enUzun != null) return enUzun;
          }
        }
      }
    } catch {}
    return null;
  };
  // Bagli saglayici kumesi (null = tespit edilemedi, saglayici filtresi uygulanmaz).
  let bagliKume = null;
  try {
    const kume = new Set();
    try {
      const ham = evKlasoru ? await dosyaOku(`${evKlasoru}/.local/share/opencode/auth.json`) : null;
      if (ham != null) { const j = JSON.parse(ham); if (j && typeof j === "object") for (const k of Object.keys(j)) kume.add(String(k).toLowerCase()); }
    } catch {}
    try {
      const cfgSag = ctx?.config?.provider;
      if (cfgSag && typeof cfgSag === "object") for (const k of Object.keys(cfgSag)) kume.add(String(k).toLowerCase());
    } catch {}
    try {
      for (const [envAd, pid] of Object.entries(ENV_SAGLAYICI)) {
        let v = null;
        try { v = process.env[envAd]; } catch {}
        if (typeof v === "string" && v.length > 0) kume.add(pid);
      }
    } catch {}
    try {
      const dbYolu = evKlasoru ? `${evKlasoru}/.local/share/opencode/opencode.db` : null;
      if (dbYolu) {
        const tablolar = await sqliteSorgu(dbYolu, "SELECT name FROM sqlite_master WHERE type='table'");
        const cred = Array.isArray(tablolar) ? tablolar.map((t) => t?.name).find((n) => typeof n === "string" && /credential/i.test(n)) : null;
        if (cred) {
          const gT = String(cred).replace(/"/g, "");
          let kolonlar = [];
          try { const b = await sqliteSorgu(dbYolu, `PRAGMA table_info("${gT}")`); if (Array.isArray(b)) kolonlar = b.map((k) => k?.name).filter((k) => typeof k === "string"); } catch {}
          const kimlik = kolonlar.filter((k) => /provider|type|kind|slug|service|integration/i.test(k) && !/token|secret|key|auth|data|value|payload|password/i.test(k));
          for (const kolon of kimlik.slice(0, 4)) {
            try {
              const satirlar = await sqliteSorgu(dbYolu, `SELECT DISTINCT "${String(kolon).replace(/"/g, "")}" AS v FROM "${gT}" LIMIT 50`);
              if (Array.isArray(satirlar)) for (const s of satirlar) { const v = s?.v; if (typeof v === "string" && v.length > 0 && v.length < 64) kume.add(v.toLowerCase()); }
            } catch {}
          }
        }
      }
    } catch {}
    if (kume.size > 0) bagliKume = kume;
  } catch {}
  // Gizli model kumesi — ayarlar > modeller ekrani ("pid/mid" anahtarlari, null = okunamadi).
  let gizliKume = null;
  try {
    const appData = (() => { try { return process.env.APPDATA || ""; } catch { return ""; } })();
    const adaylar = [];
    if (appData) adaylar.push(`${appData}/ai.opencode.desktop/drafts.sqlite`);
    if (evKlasoru) {
      adaylar.push(`${evKlasoru}/Library/Application Support/ai.opencode.desktop/drafts.sqlite`);
      adaylar.push(`${evKlasoru}/.config/ai.opencode.desktop/drafts.sqlite`);
    }
    for (const dbYolu of adaylar) {
      if (gizliKume != null) break;
      let ham = null;
      try { ham = await sqliteModelDeger(dbYolu); } catch {}
      if (typeof ham !== "string") continue;
      try {
        const j = JSON.parse(ham);
        const dizi = Array.isArray(j?.user) ? j.user : [];
        const kume = new Set();
        for (const k of dizi) {
          if (k?.visibility === "hide" && typeof k?.providerID === "string" && typeof k?.modelID === "string") {
            kume.add(`${k.providerID.toLowerCase()}/${k.modelID.replace(/^~/, "").toLowerCase()}`);
          }
        }
        gizliKume = kume;
      } catch {}
    }
  } catch {}
  // Ham katalog (elemesiz; ad + bayraklarla birlikte tutulur).
  let katalogHam = null;
  try {
    if (typeof ctx?.catalog?.transform === "function") {
      const ham = [];
      await ctx.catalog.transform((draft) => {
        const recs = draft.provider.list();
        for (const rec of recs ?? []) {
          const pid = rec?.provider?.id;
          if (typeof pid !== "string") continue;
          let entries = [];
          try { entries = rec.models instanceof Map ? [...rec.models.entries()] : Object.entries(rec.models ?? {}); } catch { continue; }
          for (const [mid, info] of entries) {
            if (typeof mid !== "string" || mid.length === 0) continue;
            ham.push({
              providerID: pid,
              id: mid,
              name: typeof info?.name === "string" ? info.name : "",
              enabled: info?.enabled,
              status: typeof info?.status === "string" ? info.status : "",
              pDisabled: rec?.provider?.disabled === true,
            });
          }
        }
      });
      if (ham.length > 0) katalogHam = dedupChain(ham);
    }
  } catch { /* probe asla setup'u devirmez */ }
  // Execute-aninda eleme: bagli + gizli-degil + kapali-degil + deprecated-degil.
  // Korumali saglayicilar (mevcut atamalar + state zincirleri) baglanti filtresinden muaftir.
  const secenekFiltrele = (ham, bagli, gizli, korumali) => {
    const cikti = [];
    const say = { bagli: 0, gizli: 0, kapali: 0, eski: 0, sagKapali: 0 };
    for (const m of ham ?? []) {
      const pid = String(m.providerID || "").toLowerCase();
      const anahtar = `${pid}/${String(m.id || "").toLowerCase()}`;
      if (m.pDisabled === true) { say.sagKapali++; continue; }
      if (m.enabled === false) { say.kapali++; continue; }
      if (m.status === "deprecated") { say.eski++; continue; }
      if (gizli != null && gizli.has(anahtar)) { say.gizli++; continue; }
      if (bagli != null && !bagli.has(pid) && !korumali.has(pid)) { say.bagli++; continue; }
      cikti.push({ providerID: m.providerID, id: m.id, name: m.name });
    }
    let geriDonus = false;
    let liste = cikti;
    if (liste.length === 0 && (ham ?? []).length > 0) {
      liste = ham.map((m) => ({ providerID: m.providerID, id: m.id, name: m.name }));
      geriDonus = true;
    }
    return { liste, say, geriDonus };
  };
  try {
    const nHam = katalogHam != null ? katalogHam.length : 0;
    console.log(`[model-router] catalog probe: ${nHam} ham model (bagli:${bagliKume != null ? bagliKume.size : "yok"}/gizli:${gizliKume != null ? gizliKume.size : "yok"})`);
  } catch {
    // log asla setup'u devirmez
  }

  // ModelRef formatlama: { providerID, id, variant? } → "provider/id/variant"; string aynen.
  const formatModel = (m) =>
    m == null
      ? "—"
      : typeof m === "string"
        ? m
        : [m.providerID, m.id, m.variant].filter(Boolean).join("/");

  // Karar 4 — mevcut atamalarin salt-okunur okumasi (okuma transform callback ICINDE; `draft.get` await'li).
  const readAssignments = async (names) => {
    const snap = {};
    try {
      if (typeof ctx.agent?.transform === "function") {
        await ctx.agent.transform(async (draft) => {
          for (const n of names) {
            try {
              const rec = typeof draft.get === "function" ? await draft.get(n) : draft?.[n];
              snap[n] = formatModel(rec?.model ?? rec?.modelID ?? null);
            } catch {
              snap[n] = "—";
            }
          }
        });
      }
    } catch {
      // salt-okunur: hata yutulur
    }
    for (const n of names) if (!(n in snap)) snap[n] = "—";
    return snap;
  };

  // Secondary/tertiary her zaman sadece state dosyasinda durur
  // (retry steering sonraki fazda bu dosyayi okuyacak).
  const buildInstruction = (names, assign, hasOhMy, signals, secenekler) => {
    const agentLines = names.map((n) => `  - ${n} (mevcut: ${assign[n] ?? "—"})`).join("\n");
    const modelBlock =
      secenekler != null
        ? `Model secenekleri (ayarlar > modeller ekranindaki aktif kumeyle ayni kural: bagli saglayici + gizli-degil; ad parantezde):\n${secenekler.map((m) => `  - ${m.providerID}/${m.id}${m.name ? ` — ${m.name}` : ""}`).join("\n")}`
        : "Kesfedilmis model katalogu yok. Model listesini ASLA uydurma/tahmin etme. `question` ile SADECE ajan sorusunu sor, model sorularinda secenek sunma; once `opencode models` komutunun GERCEK ciktisini alip o ciktiyi kullaniciya gosterip onay iste. Onaylanan ciktidaki SADECE aktif (auth'lu) saglayici ve modelleri secenek yap. Ayni model farkli saglayicida AYRI secenektir (provider/id ciftiyle listele).";
    const applyBlock = hasOhMy
      ? "Secilen primary'yi HEMEN uygula: oh-my-oh-my slim config dosyasi (`oh-my-opencode-slim.json`) icinde `agents.<ajan>.model` alanina yaz. Boyle bir alan/blok yoksa host config'e dokunma, sadece state dosyasina yaz."
      : "Secilen primary'yi HEMEN uygula: host config dosyasi (`opencode.jsonc`) icinde `agent.<ajan>.model` alanina \"provider/id\" degeri yaz.";
    return [
      "OpenCode Model Router — ajan zinciri secimi. Asagidaki adimlari sirayla uygula:",
      "",
      "ADIM 1 — `question` tool ile TEK modalda 4 soru sor:",
      "  (1) ajan sec: secenekler = kesfedilen ajan listesi:",
      agentLines || "  (kesfedilen ajan yok)",
      "  current deger olarak her ajanin mevcut atamasini goster.",
      `  (2) primary model sec. ${modelBlock}`,
      "  (3) secondary model sec (ayni secenek kumesi).",
      "  (4) tertiary model sec; atlamaya izinli (bos birakilabilir).",
      "  Variant SORMA; her girdinin mevcut variant degeri korunur.",
      "",
      "ADIM 2 — Sonucu state dosyasina yaz:",
      `  Yol: ${STATE_PATH}`,
      "  Format: { version: 1, updatedAt, chains: { <ajan>: { primary: { providerID, id, variant? }, secondary: { ... }, tertiary: { ... } | null } } }",
      "  updatedAt = su anki zaman (ISO). Diger ajanlarin mevcut zincirlerini koru (dosya varsa once oku, sadece secilen ajani guncelle).",
      "",
      `ADIM 3 — ${applyBlock}`,
      "  Secondary/tertiary her zaman sadece state dosyasinda durur (retry steering sonraki fazda bu dosyayi okuyacak).",
      "",
      "ADIM 4 — Kullaniciya 3 satirlik ozet ver:",
      "  Satir 1: secilen ajan.",
      "  Satir 2: zincir (primary / secondary / tertiary).",
      "  Satir 3: uygulanan (primary'nin nereye yazildigi).",
      "",
      `Not: mod = ${hasOhMy ? "oh-my" : "host"}${signals.length ? ` (iz: ${signals.join(", ")})` : ""}.`,
    ].join("\n");
  };

  // Boot log: kesif + mod tespiti (yerel dizin loader dogrulamasina da sinyal verir).
  try {
    const bootAgents = sortAgents(await listAgents());
    const bootMode = await probeOhMy();
    console.log(
      `[model-router] agents=${bootAgents.length} mode=${bootMode.hasOhMy ? "oh-my" : "host"}` +
        (bootMode.signals.length ? ` (${bootMode.signals.join(", ")})` : "")
    );
  } catch {
    // boot log asla setup'u devirmez
  }

  // Karar 4 — `/model-router` komutu (guard'li; execute question-akisi TALIMAT metnini gonderir).
  try {
    if (typeof ctx.command?.transform === "function") {
      track(
        await ctx.command.transform((draft) =>
          draft.add({
            name: "model-router",
            description: "Ajan icin primary/secondary/tertiary zincir secimi (question akisi)",
            execute: async (invocation) => {
              const names = sortAgents(await listAgents());
              const { hasOhMy, signals } = await probeOhMy();
              const assign = await readAssignments(names);
              // Korumali saglayicilar: mevcut atamalar + state zincirleri (baglanti filtresinden muaf).
              const korumali = new Set();
              for (const n of names) {
                const cur = assign[n];
                if (typeof cur === "string" && cur.includes("/")) korumali.add(cur.split("/")[0].toLowerCase());
              }
              try {
                const sh = await dosyaOku(STATE_PATH);
                if (sh != null) {
                  const sj = JSON.parse(sh);
                  const ch = sj?.chains;
                  if (ch && typeof ch === "object") for (const k of Object.keys(ch)) {
                    for (const slot of ["primary", "secondary", "tertiary"]) {
                      const p = ch[k]?.[slot]?.providerID;
                      if (typeof p === "string") korumali.add(p.toLowerCase());
                    }
                  }
                }
              } catch {}
              const filtre = secenekFiltrele(katalogHam, bagliKume, gizliKume, korumali);
              try { console.log(`[model-router] secenek: ${filtre.liste.length} model (e-bagli:${filtre.say.bagli}/e-gizli:${filtre.say.gizli}/e-kapali:${filtre.say.kapali}/e-eski:${filtre.say.eski}/e-sag:${filtre.say.sagKapali}${filtre.geriDonus ? ", geri-donus" : ""})`); } catch {}
              const text = buildInstruction(names, assign, hasOhMy, signals, filtre.liste);
              const sid = invocation?.sessionID;
              // oh-my yolu: invocation.sessionID + ctx.session.prompt (guard'li).
              try {
                if (sid != null && typeof ctx.session?.prompt === "function") {
                  await ctx.session.prompt({ sessionID: sid, text });
                  return;
                }
              } catch (err) {
                console.log("[model-router] instruction write failed", err?.message ?? err);
                return;
              }
              // Host fallback'leri: talimati ayni metinle yaz.
              const targets = [invocation, ctx];
              for (const t of targets) {
                try {
                  if (t && typeof t.session?.append === "function") {
                    await t.session.append(text);
                    return;
                  }
                  if (t && typeof t.append === "function") {
                    await t.append(text);
                    return;
                  }
                  if (t && typeof t.say === "function") {
                    await t.say(text);
                    return;
                  }
                  if (t && typeof t.message === "function") {
                    await t.message(text);
                    return;
                  }
                } catch (err) {
                  console.log("[model-router] instruction write failed", err?.message ?? err);
                  return;
                }
              }
              console.log(text);
            },
          })
        )
      );
    }
  } catch (err) {
    console.log("[model-router] command register failed", err?.message ?? err);
  }

  // Karar 5 — retry hook: faz-2'de de SADECE log; event.decision'a dokunulmaz (steering sonraki faz).
  try {
    if (typeof ctx.session?.hook === "function") {
      track(
        await ctx.session.hook("retry", async (event) => {
          const canSteer = typeof ctx.session?.switchModel === "function";
          console.log(
            `[model-router] retry event (steer:${canSteer ? "ready" : "pending"})`,
            event?.agent ?? event?.agentName ?? ""
          );
          // Steering sonraki fazda; bu fazda event.decision'a dokunulmaz.
        })
      );
      if (typeof ctx.session?.switchModel !== "function")
        console.log("[model-router] switchModel yok — steering beklemede, hook yalnizca loglar");
    }
  } catch (err) {
    console.log("[model-router] retry hook failed", err?.message ?? err);
  }

  // Yerel web sunucu probe (port 37337) — feasibility: runtime port acabiliyor mu,
  // hangi veri kaynagi calisiyor. Mevcut akislara dokunmaz; hata verirse sessizce
  // gecilir, dispose sunucuyu kapatir. Tum import'lar dinamik ve guard'li.
  try {
    const WEB_PORT = (() => {
      try {
        const p = parseInt(process.env.MODEL_ROUTER_PORT || "", 10);
        if (Number.isFinite(p) && p > 0 && p < 65536) return p;
      } catch {}
      return 37337;
    })();
    const SERVER_VERSION = "0.3.0";
    // State yolu: sabit varsayilan; test override: MODEL_ROUTER_STATE_PATH.
    // (LOG_PATH'tan ONCE tanimli olmali — TDZ.)
    const stateYolu = (() => {
      try {
        const p = process.env.MODEL_ROUTER_STATE_PATH;
        if (typeof p === "string" && p.length > 0) return p;
      } catch {}
      return STATE_PATH;
    })();
    // Log dosyasi: state dosyasinin kardesi (prod: model-router-server.log).
    // Override yolu farkli biterse ASLA state dosyasinin kendisi olmaz (+ ".server.log").
    const LOG_PATH = (() => {
      try {
        if (/model-router\.json$/.test(stateYolu))
          return stateYolu.replace(/model-router\.json$/, "model-router-server.log");
        return `${stateYolu}.server.log`;
      } catch {
        return "";
      }
    })();
    const logSatir = async (satir) => {
      try {
        const fs = await import("node:fs/promises");
        await fs.appendFile(LOG_PATH, `${satir}\n`, "utf8");
      } catch { /* log asla setup'u devirmez */ }
    };
    const hataTemizle = (err, redakte) => {
      try {
        let m = String(err?.message ?? err).slice(0, 200);
        if (typeof redakte === "string" && redakte.length > 0 && m.includes(redakte))
          m = m.split(redakte).join("[redacted]");
        return m;
      } catch { return "unknown"; }
    };
    let hasBun = false;
    let hasBunServe = false;
    let nodeHttpOk = false;
    try { hasBun = typeof globalThis.Bun !== "undefined"; } catch {}
    try { hasBunServe = typeof globalThis.Bun?.serve === "function"; } catch {}
    try {
      const h = await import("node:http");
      nodeHttpOk = h != null && typeof h.createServer === "function";
    } catch {}
    let nodeSurum = "unknown";
    try { if (typeof process?.version === "string" && process.version) nodeSurum = process.version; } catch {}
    // Model listesi normalize: array ya da {data:[...]}; elemanlardan providerID + (id|modelID).
    const modelNormalize = (ham) => {
      const dizi = Array.isArray(ham) ? ham : ham != null && Array.isArray(ham.data) ? ham.data : [];
      const out = [];
      for (const m of dizi) {
        try {
          const pid = m?.providerID ?? m?.provider ?? null;
          const mid = m?.id ?? m?.modelID ?? m?.model ?? null;
          if (typeof pid === "string" && pid.length > 0 && typeof mid === "string" && mid.length > 0) {
            const rec = { providerID: pid, id: mid };
            if (typeof m?.name === "string" && m.name.length > 0) rec.name = m.name;
            out.push(rec);
          }
        } catch {}
      }
      return out;
    };
    // Model kaynagi sirasi: (a) ctx.model?.list, (b) yerel HTTP (service.json port+password).
    // Parola asla loglanmaz/yanita konmaz; hatalar sanitize edilir.
    const modelleriGetir = async () => {
      let ctxHata = null;
      try {
        if (typeof ctx.model?.list === "function") {
          const ham = await ctx.model.list();
          return { source: "ctx", models: modelNormalize(ham), error: null };
        }
      } catch (err) { ctxHata = hataTemizle(err); }
      let parola = "";
      try {
        const svcYolu = STATE_PATH.replace(/model-router\.json$/, "service.json");
        const hamSvc = await dosyaOku(svcYolu);
        if (typeof hamSvc !== "string" || hamSvc.length === 0) throw new Error("service okunamadi");
        let svc = null;
        try { svc = JSON.parse(hamSvc); } catch { throw new Error("service parse hatasi"); }
        const port = svc?.port;
        const pw = svc?.password;
        if (typeof port !== "number" && typeof port !== "string") throw new Error("service port yok");
        if (typeof pw !== "string" || pw.length === 0) throw new Error("service password yok");
        parola = pw;
        if (typeof fetch !== "function") throw new Error("fetch yok");
        let b64 = "";
        try {
          if (typeof Buffer !== "undefined" && typeof Buffer.from === "function")
            b64 = Buffer.from(`opencode:${pw}`, "utf8").toString("base64");
          else if (typeof btoa === "function") b64 = btoa(`opencode:${pw}`);
          else throw new Error("base64 yok");
        } catch { throw new Error("auth hazirlanamadi"); }
        const resp = await fetch(`http://127.0.0.1:${port}/api/model`, {
          headers: { Authorization: `Basic ${b64}` },
        });
        if (!resp.ok) throw new Error(`http ${resp.status}`);
        const j = await resp.json();
        return { source: "http", models: modelNormalize(j), error: null };
      } catch (err) {
        const m = hataTemizle(err, parola);
        if (ctxHata != null) return { source: "none", models: [], error: `${ctxHata} | ${m}`.slice(0, 200) };
        return { source: "none", models: [], error: m };
      }
    };
    // Gorunurluk: drafts.sqlite -> sqliteModelDeger -> JSON user[] icinde visibility==="hide" sayisi.
    const gorunurlukOku = async () => {
      try {
        const appData = (() => { try { return process.env.APPDATA || ""; } catch { return ""; } })();
        const adaylar = [];
        if (appData) adaylar.push(`${appData}/ai.opencode.desktop/drafts.sqlite`);
        if (evKlasoru) {
          adaylar.push(`${evKlasoru}/Library/Application Support/ai.opencode.desktop/drafts.sqlite`);
          adaylar.push(`${evKlasoru}/.config/ai.opencode.desktop/drafts.sqlite`);
        }
        for (const dbYolu of adaylar) {
          let ham = null;
          try { ham = await sqliteModelDeger(dbYolu); } catch {}
          if (typeof ham !== "string" || ham.length === 0) continue;
          try {
            const j = JSON.parse(ham);
            const dizi = Array.isArray(j?.user) ? j.user : [];
            let gizliSay = 0;
            for (const k of dizi) { try { if (k?.visibility === "hide") gizliSay++; } catch {} }
            return { source: "drafts.sqlite", hidden: gizliSay, present: true };
          } catch (err) {
            return { source: "drafts.sqlite", hidden: 0, present: true, error: hataTemizle(err) };
          }
        }
        return { source: "drafts.sqlite", hidden: 0, present: false };
      } catch (err) {
        return { source: "drafts.sqlite", hidden: 0, present: false, error: hataTemizle(err) };
      }
    };
    // Web UI yardimcilari (hepsi guard'li; sunucu asla setup'u devirmez).
    // stateYolu blok basinda tanimli (TDZ onlemi); burada tekrar tanimlanmaz.
    // Host config yolu: test override MODEL_ROUTER_HOST_CONFIG, prod ~/.config/opencode/opencode.jsonc.
    const hostYoluCozumle = () => {
      try {
        const p = process.env.MODEL_ROUTER_HOST_CONFIG;
        if (typeof p === "string" && p.length > 0) return p;
      } catch {}
      try {
        const b = evDizini();
        if (b) return `${b}/.config/opencode/opencode.jsonc`;
      } catch {}
      return "";
    };
    const jsonYanit = (o, status) => ({
      status: status || 200,
      contentType: "application/json",
      body: JSON.stringify(o),
    });
    const hataYanit = (status, msg) => jsonYanit({ ok: false, error: msg }, status);
    // State okuma: { chains } (bozuk/eksik dosya -> bos zincir, hata firlatmaz).
    const stateOku = async () => {
      try {
        const ham = await dosyaOku(stateYolu);
        if (ham == null) return { chains: {} };
        const j = JSON.parse(ham);
        const ch = j != null && typeof j === "object" && j.chains != null && typeof j.chains === "object" ? j.chains : {};
        return { chains: ch };
      } catch {
        return { chains: {} };
      }
    };
    // Zincir girdisi -> "provider/id" (gecersiz -> null).
    const refStr = (e) =>
      e != null && typeof e === "object" && typeof e.providerID === "string" && typeof e.id === "string" &&
      e.providerID.length > 0 && e.id.length > 0
        ? `${e.providerID}/${e.id}`
        : null;
    // "provider/id" -> { providerID, id }; ILK "/" uzerinden bol (id'de slash olabilir).
    const strRef = (s) => {
      try {
        if (typeof s !== "string") return null;
        const i = s.indexOf("/");
        if (i <= 0 || i >= s.length - 1) return null;
        return { providerID: s.slice(0, i), id: s.slice(i + 1) };
      } catch {
        return null;
      }
    };
    // Gorunurluk anahtari (gizliKume uretimiyle ayni normalizasyon: kucuk harf + bas `~` temizligi).
    const gizliAnahtar = (pid, mid) => {
      try {
        return `${String(pid ?? "").toLowerCase()}/${String(mid ?? "").replace(/^~/, "").toLowerCase()}`;
      } catch {
        return "/";
      }
    };
    // Katalog (ctx.model?.list) + gorunurluk filtresi: katalog - gizli = gorunur.
    const katalogGorunur = async () => {
      let sonuc = null;
      try {
        sonuc = await modelleriGetir();
      } catch (err) {
        sonuc = { source: "none", models: [], error: hataTemizle(err) };
      }
      const tum = Array.isArray(sonuc?.models) ? sonuc.models : [];
      const gorunur = [];
      let gizliSay = 0;
      for (const m of tum) {
        try {
          if (gizliKume != null && gizliKume.has(gizliAnahtar(m?.providerID, m?.id))) {
            gizliSay++;
            continue;
          }
          gorunur.push(m);
        } catch {
          try {
            gorunur.push(m);
          } catch {}
        }
      }
      const sira = (a, b) =>
        String(a?.providerID ?? "").localeCompare(String(b?.providerID ?? "")) ||
        String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
      let tumSirali = [];
      try {
        tumSirali = [...tum].sort(sira);
      } catch {
        tumSirali = tum;
      }
      let gorSirali = [];
      try {
        gorSirali = [...gorunur].sort(sira);
      } catch {
        gorSirali = gorunur;
      }
      return { source: sonuc?.source ?? "none", tum: tumSirali, gorunur: gorSirali, gizliSay, error: sonuc?.error ?? null };
    };
    // Statik web dizini: MODEL_ROUTER_WEB_DIR -> ~/.config/opencode/model-router-web/
    // -> modul dizininden ../../web (spec) -> ../web (repo duzeni yedegi). index.html varligi aranir.
    const webDiziniBul = async () => {
      const adaylar = [];
      try {
        const p = process.env.MODEL_ROUTER_WEB_DIR;
        if (typeof p === "string" && p.length > 0) adaylar.push(p);
      } catch {}
      try {
        const b = evDizini();
        if (b) adaylar.push(`${b}/.config/opencode/model-router-web`);
      } catch {}
      try {
        const mod = await import("node:url");
        const path = await import("node:path");
        const bura = path.dirname(mod.fileURLToPath(import.meta.url));
        adaylar.push(path.join(bura, "..", "..", "web"));
        adaylar.push(path.join(bura, "..", "web"));
      } catch {}
      try {
        const path = await import("node:path");
        const fs = await import("node:fs/promises");
        for (const d of adaylar) {
          try {
            await fs.access(path.join(d, "index.html"));
            return d;
          } catch {}
        }
      } catch {}
      return adaylar[0] || "";
    };
    const icerikTipi = (ad) => {
      try {
        if (ad.endsWith(".html")) return "text/html; charset=utf-8";
        if (ad.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (ad.endsWith(".css")) return "text/css; charset=utf-8";
      } catch {}
      return "application/octet-stream";
    };
    const statikSun = async (yol) => {
      try {
        if (yol === "/favicon.ico") return { status: 204, contentType: "text/plain", body: "" };
        const izinli = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
        const ad = izinli[yol];
        if (!ad) return { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) };
        const dizin = await webDiziniBul();
        let icerik = null;
        if (dizin) {
          try {
            const path = await import("node:path");
            const fs = await import("node:fs/promises");
            icerik = await fs.readFile(path.join(dizin, ad), "utf8");
          } catch {}
        }
        if (icerik == null) {
          return {
            status: 404,
            contentType: "text/html; charset=utf-8",
            body: `<h1>Model Router UI bulunamadi</h1><p>Web dosyalari henuz kurulu degil. Beklenen konum: <code>${dizin || "(bilinmiyor)"}</code></p>`,
          };
        }
        return { status: 200, contentType: icerikTipi(ad), body: icerik };
      } catch (err) {
        return { status: 500, contentType: "application/json", body: JSON.stringify({ error: hataTemizle(err) }) };
      }
    };
    // oh-my model eleman formati: mevcut kullanim birebir (dizi elemani string mi {id} objesi mi?).
    // Sira: top-level agents girdisi -> aktif preset girdisi -> diger presetler -> varsayilan "object".
    const ohmyStilBul = (cfg, ajan) => {
      try {
        const m1 = cfg?.agents?.[ajan]?.model;
        if (Array.isArray(m1) && m1.length > 0) return typeof m1[0] === "string" ? "string" : "object";
      } catch {}
      try {
        const presetler = cfg?.presets;
        const aktif = typeof cfg?.preset === "string" ? cfg.preset : null;
        if (aktif && presetler && typeof presetler === "object") {
          const m = presetler[aktif]?.[ajan]?.model;
          if (Array.isArray(m) && m.length > 0) return typeof m[0] === "string" ? "string" : "object";
        }
        if (presetler && typeof presetler === "object") {
          for (const k of Object.keys(presetler)) {
            try {
              const m = presetler[k]?.[ajan]?.model;
              if (Array.isArray(m) && m.length > 0) return typeof m[0] === "string" ? "string" : "object";
            } catch {}
          }
        }
      } catch {}
      return "object";
    };
    // Ortak istek karsilama: {status, contentType, body} doner; adapter'lar (Bun/node:http) cevirir.
    const istekKarsila = async (method, pathname, query, govdeMetni) => {
      try {
        if (method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/app.js" || pathname === "/style.css" || pathname === "/favicon.ico")) {
          return await statikSun(pathname);
        }
        if (method === "GET" && pathname === "/api/probe") {
          let agentIdler = [];
          try { agentIdler = await listAgents(); } catch {}
          if (!Array.isArray(agentIdler)) agentIdler = [];
          let modSonuc = null;
          try { modSonuc = await modelleriGetir(); } catch (err) { modSonuc = { source: "none", models: [], error: hataTemizle(err) }; }
          const modListe = Array.isArray(modSonuc?.models) ? modSonuc.models : [];
          let gor = null;
          try { gor = await gorunurlukOku(); } catch (err) { gor = { source: "drafts.sqlite", hidden: 0, present: false, error: hataTemizle(err) }; }
          let zincirVar = false;
          try { zincirVar = (await dosyaOku(STATE_PATH)) != null; } catch {}
          const govde = {
            runtime: { hasBun, hasBunServe, nodeHttp: nodeHttpOk, version: nodeSurum },
            agents: { count: agentIdler.length, sample: agentIdler.slice(0, 5) },
            models: {
              source: modSonuc.source,
              count: modListe.length,
              sample: modListe.slice(0, 5).map((m) => `${m.providerID}/${m.id}`),
              ...(modSonuc.error ? { error: modSonuc.error } : {}),
            },
            visibility: gor,
            chains: { file: STATE_PATH, exists: zincirVar },
          };
          return { status: 200, contentType: "application/json", body: JSON.stringify(govde) };
        }
        if (method === "GET" && pathname === "/api/models") {
          const kat = await katalogGorunur();
          let hepsi = false;
          try {
            const v = query?.all;
            hepsi = v === "1" || v === "true";
          } catch {}
          const liste = hepsi ? kat.tum : kat.gorunur;
          const govde = {
            source: kat.source,
            models: liste,
            counts: { catalog: kat.tum.length, visible: kat.gorunur.length, hidden: kat.gizliSay },
            ...(kat.error ? { error: kat.error } : {}),
          };
          return jsonYanit(govde);
        }
        if (method === "GET" && pathname === "/api/state") {
          let agentIdler = [];
          try {
            agentIdler = sortAgents(await listAgents());
          } catch {}
          if (!Array.isArray(agentIdler)) agentIdler = [];
          let atama = {};
          try {
            atama = await readAssignments(agentIdler);
          } catch {}
          let st = { chains: {} };
          try {
            st = await stateOku();
          } catch {}
          const kat = await katalogGorunur();
          const o = await ohmyCozumle();
          const hostYolu = hostYoluCozumle();
          const agents = agentIdler.map((id) => {
            let cur = null;
            try {
              const v = atama[id];
              if (typeof v === "string" && v !== "—" && v.includes("/")) cur = v;
            } catch {}
            let ch = null;
            try {
              const h = st.chains?.[id];
              if (h != null && typeof h === "object") ch = h;
            } catch {}
            let primary = null;
            try {
              primary = refStr(ch?.primary) ?? cur;
            } catch {}
            return {
              id,
              current: cur,
              chain: {
                primary,
                secondary: refStr(ch?.secondary),
                tertiary: refStr(ch?.tertiary),
              },
            };
          });
          const models = kat.gorunur.map((m) => {
            const r = { providerID: m?.providerID, id: m?.id };
            try {
              if (typeof m?.name === "string" && m.name.length > 0) r.name = m.name;
            } catch {}
            return r;
          });
          return jsonYanit({
            ok: true,
            server: { version: SERVER_VERSION, port: WEB_PORT },
            meta: {
              catalogCount: kat.tum.length,
              visibleCount: kat.gorunur.length,
              hiddenCount: kat.gizliSay,
              hasOhMy: o.exists,
              statePath: stateYolu,
              ohMyConfigPath: o.path,
              hostConfigPath: hostYolu,
            },
            agents,
            models,
          });
        }
        if (method === "POST" && pathname === "/api/save") {
          let gov = null;
          try {
            gov = JSON.parse(govdeMetni || "");
          } catch {
            return hataYanit(400, "gecersiz JSON govde");
          }
          const gelen =
            gov != null && typeof gov === "object" && gov.chains != null && typeof gov.chains === "object"
              ? gov.chains
              : null;
          if (gelen == null) return hataYanit(400, "govde.chains yok");
          let mevcut = null;
          try {
            const ham = await dosyaOku(stateYolu);
            mevcut = ham != null ? JSON.parse(ham) : null;
          } catch {
            return hataYanit(500, "state okunamadi");
          }
          if (mevcut == null || typeof mevcut !== "object") mevcut = {};
          if (mevcut.chains == null || typeof mevcut.chains !== "object") mevcut.chains = {};
          for (const ajan of Object.keys(gelen)) {
            try {
              if (typeof ajan !== "string" || ajan.length === 0 || ajan.length > 128)
                return hataYanit(400, `gecersiz ajan adi: ${ajan}`);
              const giris = gelen[ajan];
              if (giris == null || typeof giris !== "object") return hataYanit(400, `zincir gecersiz: ${ajan}`);
              const onceki =
                mevcut.chains[ajan] != null && typeof mevcut.chains[ajan] === "object" ? mevcut.chains[ajan] : {};
              const yeni = {};
              for (const slot of ["primary", "secondary", "tertiary"]) {
                const v = giris[slot] ?? null;
                if (v == null || v === "") {
                  yeni[slot] = null;
                  continue;
                }
                if (typeof v !== "string" || !v.includes("/")) return hataYanit(400, `gecersiz ref: ${ajan}.${slot}`);
                const ref = strRef(v);
                if (ref == null) return hataYanit(400, `gecersiz ref: ${ajan}.${slot}`);
                // Variant: model ayniyse korunur, degistiysa variantsiz yazilir.
                const eski = onceki[slot];
                if (
                  eski != null && typeof eski === "object" &&
                  eski.providerID === ref.providerID && eski.id === ref.id &&
                  typeof eski.variant === "string" && eski.variant.length > 0
                ) {
                  yeni[slot] = { providerID: ref.providerID, id: ref.id, variant: eski.variant };
                } else {
                  yeni[slot] = ref;
                }
              }
              mevcut.chains[ajan] = yeni;
            } catch {
              return hataYanit(400, `zincir islenemedi: ${ajan}`);
            }
          }
          mevcut.version = 1;
          mevcut.updatedAt = new Date().toISOString();
          try {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            try {
              await fs.mkdir(path.dirname(stateYolu), { recursive: true });
            } catch {}
            await fs.writeFile(stateYolu, JSON.stringify(mevcut, null, 2), "utf8");
          } catch {
            return hataYanit(500, "state yazilamadi");
          }
          return jsonYanit({ ok: true, statePath: stateYolu, updatedAt: mevcut.updatedAt });
        }
        if (method === "POST" && pathname === "/api/apply") {
          const notes = [];
          const backups = [];
          const uygulanan = [];
          const hostGuncel = [];
          let reload = "unsupported";
          let st = null;
          try {
            const ham = await dosyaOku(stateYolu);
            st = ham != null ? JSON.parse(ham) : null;
          } catch {
            return hataYanit(400, "state dosyasi okunamadi/parse edilemedi");
          }
          const chains =
            st != null && typeof st === "object" && st.chains != null && typeof st.chains === "object"
              ? st.chains
              : null;
          if (chains == null) return hataYanit(400, "state chains yok");
          const o = await ohmyCozumle();
          const hostYolu = hostYoluCozumle();
          if (o.exists && o.path) {
            try {
              const fs = await import("node:fs/promises");
              let ham = null;
              try {
                ham = await fs.readFile(o.path, "utf8");
              } catch {
                ham = null;
              }
              if (ham == null) {
                notes.push("oh-my dosyasi okunamadi; degistirilmedi");
              } else {
                let cfg = null;
                try {
                  cfg = JSON.parse(ham);
                } catch {
                  cfg = null;
                }
                if (cfg == null || typeof cfg !== "object") {
                  notes.push("oh-my JSON parse edilemedi; dosya degistirilmedi");
                } else {
                  if (cfg.agents == null || typeof cfg.agents !== "object") cfg.agents = {};
                  let yazilacak = 0;
                  for (const ajan of Object.keys(chains)) {
                    try {
                      const zincir = chains[ajan];
                      if (zincir == null || typeof zincir !== "object") continue;
                      const girdiler = [zincir.primary, zincir.secondary, zincir.tertiary].filter(
                        (e) => e != null && typeof e === "object" && typeof e.providerID === "string" && typeof e.id === "string"
                      );
                      if (girdiler.length === 0) continue;
                      const stil = ohmyStilBul(cfg, ajan);
                      const dizi = girdiler.map((e) => {
                        const ref = `${e.providerID}/${e.id}`;
                        if (stil === "string") return ref;
                        if (typeof e.variant === "string" && e.variant.length > 0) return { id: ref, variant: e.variant };
                        return { id: ref };
                      });
                      const onceki =
                        cfg.agents[ajan] != null && typeof cfg.agents[ajan] === "object" ? cfg.agents[ajan] : {};
                      cfg.agents[ajan] = { ...onceki, model: dizi };
                      uygulanan.push(ajan);
                      yazilacak++;
                    } catch {}
                  }
                  if (yazilacak > 0) {
                    try {
                      await fs.copyFile(o.path, `${o.path}.model-router.bak`);
                      backups.push(`${o.path}.model-router.bak`);
                    } catch {
                      return hataYanit(500, "oh-my yedegi alinamadi; dosya degistirilmedi");
                    }
                    try {
                      await fs.writeFile(o.path, JSON.stringify(cfg, null, 2), "utf8");
                    } catch {
                      notes.push("oh-my yazilamadi");
                    }
                  } else {
                    notes.push("oh-my: yazilacak zincir yok");
                  }
                }
              }
            } catch (err) {
              notes.push(`oh-my hatasi: ${hataTemizle(err)}`);
            }
          } else {
            notes.push("oh-my dosyasi yok; host yolu kullanilacak");
          }
          if (hostYolu) {
            try {
              const fs = await import("node:fs/promises");
              let hham = null;
              try {
                hham = await fs.readFile(hostYolu, "utf8");
              } catch {
                hham = null;
              }
              if (hham == null) {
                notes.push("host config bulunamadi; host guncellenmedi");
              } else {
                let hcfg = null;
                try {
                  hcfg = JSON.parse(hham);
                } catch {
                  hcfg = null;
                }
                if (hcfg != null && typeof hcfg === "object" && hcfg.agent != null && typeof hcfg.agent === "object") {
                  let degisti = false;
                  for (const ajan of Object.keys(chains)) {
                    try {
                      if (!(ajan in hcfg.agent)) continue; // yeni ajan anahtari EKLENMEZ
                      const blk = hcfg.agent[ajan];
                      if (blk == null || typeof blk !== "object") continue;
                      const prim = refStr(chains[ajan]?.primary);
                      if (!prim) continue;
                      hostGuncel.push(ajan);
                      if (blk.model !== prim) {
                        blk.model = prim;
                        degisti = true;
                      }
                    } catch {}
                  }
                  if (degisti) {
                    try {
                      await fs.copyFile(hostYolu, `${hostYolu}.model-router.bak`);
                      backups.push(`${hostYolu}.model-router.bak`);
                    } catch {
                      notes.push("host yedegi alinamadi; host degistirilmedi");
                      degisti = false;
                    }
                    if (degisti) {
                      try {
                        await fs.writeFile(hostYolu, JSON.stringify(hcfg, null, 2), "utf8");
                      } catch {
                        notes.push("host yazilamadi");
                      }
                    }
                  }
                } else {
                  // JSONC (yorumlu) dususu: blok-kapsamli regex ile sadece model degeri degisir.
                  // Yeni ajan anahtari EKLENMEZ; dogrulama hedefli geri-okumayla yapilir.
                  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                  let yeni = hham;
                  const dokunulan = [];
                  for (const ajan of Object.keys(chains)) {
                    try {
                      const prim = refStr(chains[ajan]?.primary);
                      if (!prim) continue;
                      const blokRe = new RegExp(`"${esc(ajan)}"\\s*:\\s*\\{[^}]*?"model"\\s*:\\s*"[^"]*"`);
                      const m = yeni.match(blokRe);
                      if (!m) continue; // blok yoksa EKLEME
                      yeni = yeni.replace(blokRe, (b) => {
                        try {
                          return b.replace(/("model"\s*:\s*")[^"]*(")/, `$1${prim}$2`);
                        } catch {
                          return b;
                        }
                      });
                      dokunulan.push(ajan);
                    } catch {}
                  }
                  // Dogrulama: her dokunulan blokta model degeri beklenen primary mi?
                  let gecerli = true;
                  for (const ajan of dokunulan) {
                    try {
                      const prim = refStr(chains[ajan]?.primary);
                      const blokRe = new RegExp(`"${esc(ajan)}"\\s*:\\s*\\{[^}]*?"model"\\s*:\\s*"([^"]*)"`);
                      const m = yeni.match(blokRe);
                      if (!m || m[1] !== prim) {
                        gecerli = false;
                        break;
                      }
                    } catch {
                      gecerli = false;
                      break;
                    }
                  }
                  if (dokunulan.length > 0 && gecerli) {
                    try {
                      await fs.copyFile(hostYolu, `${hostYolu}.model-router.bak`);
                      backups.push(`${hostYolu}.model-router.bak`);
                    } catch {
                      notes.push("host yedegi alinamadi; host degistirilmedi");
                      gecerli = false;
                    }
                    if (gecerli) {
                      try {
                        await fs.writeFile(hostYolu, yeni, "utf8");
                        for (const a of dokunulan) hostGuncel.push(a);
                      } catch {
                        notes.push("host yazilamadi");
                      }
                    }
                  } else if (dokunulan.length > 0) {
                    notes.push("host regex dogrulamasi basarisiz; dosya degistirilmedi");
                  }
                }
              }
            } catch (err) {
              notes.push(`host hatasi: ${hataTemizle(err)}`);
            }
          }
          try {
            if (typeof ctx.agent?.reload === "function") {
              await ctx.agent.reload();
              reload = "ok";
            } else {
              reload = "unsupported";
            }
          } catch {
            reload = "failed";
          }
          let target = "host";
          try {
            if (o.exists) target = hostGuncel.length > 0 ? "both" : "oh-my";
          } catch {}
          return jsonYanit({ ok: true, target, agents: uygulanan, hostUpdated: hostGuncel, reload, backups, notes });
        }
        return { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) };
      } catch (err) {
        return { status: 500, contentType: "application/json", body: JSON.stringify({ error: hataTemizle(err) }) };
      }
    };
    // Bind sirasi: once Bun.serve, olmazsa node:http. Basarisizsa logla ve gec (baska port denenmez).
    let sunucu = null;
    let baglanti = "";
    try {
      if (typeof globalThis.Bun?.serve === "function") {
        try {
          sunucu = globalThis.Bun.serve({
            hostname: "127.0.0.1",
            port: WEB_PORT,
            fetch: async (req) => {
              let pathname = "/";
              let method = "GET";
              let query = {};
              let govde = "";
              try {
                const u = new URL(req.url);
                pathname = u.pathname || "/";
                method = req.method || "GET";
                query = Object.fromEntries(u.searchParams.entries());
                if (method === "POST") {
                  try {
                    govde = await req.text();
                  } catch {}
                }
              } catch {}
              const yanit = await istekKarsila(method, pathname, query, govde);
              try { await logSatir(`${new Date().toISOString()} ${method} ${pathname} ${yanit.status}`); } catch {}
              return new Response(yanit.body, {
                status: yanit.status,
                headers: { "Content-Type": yanit.contentType || "application/json" },
              });
            },
          });
          baglanti = "Bun.serve";
        } catch (err) {
          sunucu = null;
          try { await logSatir(`${new Date().toISOString()} bind hata (Bun.serve): ${err?.code ?? ""} ${hataTemizle(err)}`); } catch {}
        }
      }
    } catch (err) {
      sunucu = null;
      try { await logSatir(`${new Date().toISOString()} bind hata (Bun.serve): ${hataTemizle(err)}`); } catch {}
    }
    if (sunucu == null) {
      try {
        const http = await import("node:http");
        const srv = http.createServer((req, res) => {
          (async () => {
            let pathname = "/";
            let query = {};
            try {
              const u = new URL(req.url || "/", "http://127.0.0.1");
              pathname = u.pathname || "/";
              query = Object.fromEntries(u.searchParams.entries());
            } catch {}
            const method = req.method || "GET";
            let govde = "";
            if (method === "POST") {
              try {
                govde = await new Promise((resolve) => {
                  let b = "";
                  let asim = false;
                  try {
                    req.on("data", (c) => {
                      try {
                        if (!asim) {
                          b += String(c);
                          if (b.length > 1048576) asim = true;
                        }
                      } catch {}
                    });
                    req.on("end", () => resolve(asim ? "" : b));
                    req.on("error", () => resolve(""));
                  } catch {
                    resolve("");
                  }
                });
              } catch {}
            }
            const yanit = await istekKarsila(method, pathname, query, govde);
            try { await logSatir(`${new Date().toISOString()} ${method} ${pathname} ${yanit.status}`); } catch {}
            res.writeHead(yanit.status, { "Content-Type": yanit.contentType || "application/json" });
            res.end(yanit.body);
          })().catch((err) => {
            try {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: hataTemizle(err) }));
            } catch {}
          });
        });
        await new Promise((resolve, reject) => {
          const onHata = (err) => {
            try { srv.removeListener("listening", onDinle); } catch {}
            reject(err);
          };
          const onDinle = () => {
            try { srv.removeListener("error", onHata); } catch {}
            resolve();
          };
          srv.once("error", onHata);
          srv.once("listening", onDinle);
          srv.listen(WEB_PORT, "127.0.0.1");
        });
        sunucu = srv;
        baglanti = "node:http";
      } catch (err) {
        sunucu = null;
        try { await logSatir(`${new Date().toISOString()} bind hata (node:http): ${err?.code ?? ""} ${hataTemizle(err)}`); } catch {}
      }
    }
    if (sunucu != null) {
      try { await logSatir(`${new Date().toISOString()} web dinliyor ${baglanti} 127.0.0.1:${WEB_PORT}`); } catch {}
      try { console.log(`[model-router] web http 127.0.0.1:${WEB_PORT} (${baglanti})`); } catch {}
      track(() => {
        try { if (typeof sunucu.close === "function") sunucu.close(); } catch {}
        try { if (typeof sunucu.stop === "function") sunucu.stop(); } catch {}
      });
    }
  } catch { /* probe asla setup'u devirmez */ }

  // Dispose: tum registration'lar tek noktadan cozulur (senkron).
  return () => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch (err) {
        console.log("[model-router] dispose error", err?.message ?? err);
      }
    }
  };
}

export default { id: "opencode-model-router", setup };
