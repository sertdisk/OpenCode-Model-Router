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

  // Karar 3 — hasOhMy probe (tespit; yazma karari execute fazinda agent tarafindan uygulanir).
  const probeOhMy = () => {
    const signals = [];
    try {
      if (ctx?.ohMy != null || ctx?.["oh-my"] != null) signals.push("ctx oh-my key");
      const cfg = ctx?.config;
      if (cfg != null && typeof cfg === "object" && cfg.agents != null && typeof cfg.agents === "object")
        signals.push("config.agents");
      const pc = ctx?.project?.config ?? ctx?.projectConfig;
      if (pc != null && typeof pc === "object" && pc.agents != null && typeof pc.agents === "object")
        signals.push("project config.agents");
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
      try { ham = await sqliteDegerBul(dbYolu, "opencode.global.datmodel"); } catch {}
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
    const bootMode = probeOhMy();
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
              const { hasOhMy, signals } = probeOhMy();
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
