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
  // Guvenlik agi: filtre sonucu bossa filtre yok sayilip tumu alinir (bos picker'dan iyidir).
  // Bu probe asla setup'u devirmez (guard + try/catch).
  let cachedModels = null;
  let probeDevreDisi = 0;
  let probeKapali = 0;
  let probeFallback = false;
  try {
    if (typeof ctx?.catalog?.transform === "function") {
      const found = [];
      const foundAll = [];
      let elendiDevreDisi = 0;
      let elendiKapali = 0;
      await ctx.catalog.transform((draft) => {
        const recs = draft.provider.list(); // readonly CatalogProviderRecord[]: { provider: {id, disabled?, ...}, models: ReadonlyMap<id, ModelV2Info & {enabled}> }
        for (const rec of recs ?? []) {
          const pid = rec?.provider?.id;
          if (typeof pid !== "string") continue;
          let entries = [];
          try { entries = rec.models instanceof Map ? [...rec.models.entries()] : Object.entries(rec.models ?? {}); } catch { continue; }
          if (rec?.provider?.disabled === true) {
            for (const [mid] of entries) {
              if (typeof mid !== "string" || mid.length === 0) continue;
              foundAll.push({ providerID: pid, id: mid });
              elendiDevreDisi += 1;
            }
            continue;
          }
          for (const [mid, info] of entries) {
            if (typeof mid !== "string" || mid.length === 0) continue;
            foundAll.push({ providerID: pid, id: mid });
            if (info?.enabled !== true) {
              elendiKapali += 1;
              continue;
            }
            found.push({ providerID: pid, id: mid });
          }
        }
      });
      let picked = found;
      if (picked.length === 0 && foundAll.length > 0) {
        picked = foundAll;
        probeFallback = true;
      }
      probeDevreDisi = elendiDevreDisi;
      probeKapali = elendiKapali;
      if (picked.length > 0) cachedModels = dedupChain(picked).map((e) => ({ providerID: e.providerID, id: e.id }));
    }
  } catch { /* probe asla setup'u devirmez */ }
  try {
    const nProv = cachedModels != null ? new Set(cachedModels.map((m) => m.providerID)).size : 0;
    if (cachedModels != null) {
      console.log(`[model-router] catalog probe: ${cachedModels.length} model / ${nProv} provider (${probeDevreDisi} elendi-devre-disi/${probeKapali} elendi-kapali${probeFallback ? ", filtre-bos-fallback" : ""})`);
    } else {
      console.log("[model-router] catalog probe: katalog okunamadi");
    }
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
  const buildInstruction = (names, assign, hasOhMy, signals) => {
    const agentLines = names.map((n) => `  - ${n} (mevcut: ${assign[n] ?? "—"})`).join("\n");
    const modelBlock =
      cachedModels != null
        ? `Model secenekleri (kesfedilen katalogdan, provider/id formatinda; liste = opencode katalogundaki enabled modeller):\n${cachedModels.map((m) => `  - ${m.providerID}/${m.id}`).join("\n")}`
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
              const text = buildInstruction(names, assign, hasOhMy, signals);
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
