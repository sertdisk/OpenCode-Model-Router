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

  // Faz-2 — model katalogu defansif probe.
  // Denenen alanlar: ctx.model.list | ctx.model.listModels | ctx.model.models |
  //   ctx.models.list | ctx.catalog.list | ctx.catalog.listModels | ctx.catalog.models |
  //   ctx.provider.list | ctx.provider.listModels | ctx.providers.list
  // Bulunan normalize edilip `cachedModels: [{ providerID, id }]` tutulur; bulunamazsa null kalir.
  // Bu probe asla setup'u devirmez (her aday typeof guard + try/catch icinde denenir).
  let cachedModels = null;
  try {
    const candidates = [
      ctx?.model?.list,
      ctx?.model?.listModels,
      ctx?.model?.models,
      ctx?.models?.list,
      ctx?.catalog?.list,
      ctx?.catalog?.listModels,
      ctx?.catalog?.models,
      ctx?.provider?.list,
      ctx?.provider?.listModels,
      ctx?.providers?.list,
    ];
    for (const cand of candidates) {
      if (cachedModels != null) break;
      try {
        if (typeof cand === "function") {
          const raw = await cand.call(ctx?.model ?? ctx?.catalog ?? ctx?.provider ?? ctx?.providers ?? ctx);
          const arr = Array.isArray(raw) ? raw : raw != null && Array.isArray(raw.models) ? raw.models : null;
          if (arr != null) {
            const norm = [];
            for (const m of arr) {
              if (typeof m === "string") {
                const i = m.indexOf("/");
                if (i > 0) norm.push({ providerID: m.slice(0, i), id: m.slice(i + 1) });
              } else if (m != null && typeof m === "object") {
                const providerID = m.providerID ?? m.provider ?? null;
                const id = m.id ?? m.modelID ?? m.model ?? null;
                if (typeof providerID === "string" && typeof id === "string")
                  norm.push({ providerID, id });
              }
            }
            if (norm.length > 0) cachedModels = dedupChain(norm).map((e) => ({ providerID: e.providerID, id: e.id }));
          }
        } else if (Array.isArray(cand) && cand.length > 0) {
          const norm = [];
          for (const m of cand) {
            if (m != null && typeof m === "object") {
              const providerID = m.providerID ?? m.provider ?? null;
              const id = m.id ?? m.modelID ?? m.model ?? null;
              if (typeof providerID === "string" && typeof id === "string")
                norm.push({ providerID, id });
            }
          }
          if (norm.length > 0) cachedModels = dedupChain(norm).map((e) => ({ providerID: e.providerID, id: e.id }));
        }
      } catch {
        // bu aday basarisiz — sonrakini dene
      }
    }
  } catch {
    // probe asla setup'u devirmez
  }
  try {
    console.log(`[model-router] catalog probe: ${cachedModels != null ? `${cachedModels.length} model` : "yok (agent derleyecek)"}`);
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
        ? `Model secenekleri (kesfedilen katalogdan, provider/id formatinda):\n${cachedModels.map((m) => `  - ${m.providerID}/${m.id}`).join("\n")}`
        : "Kesfedilmis model katalogu yok. Model seceneklerini `opencode models` ciktisindan ve aktif config'den derle; SADECE aktif (auth'lu) saglayici ve modelleri secenek yap. Ayni model farkli saglayicida AYRI secenektir (provider/id ciftiyle listele).";
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
