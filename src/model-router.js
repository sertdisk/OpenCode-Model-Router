// OpenCode Model Router (display ad) - per-agent primary/secondary/tertiary model routing
// model-ata (v2 plugin) — kilitli kararlar özeti:
//  1) Zincir girişi { providerID, id, variant? }; dedup anahtarı providerID/id/variant — model adı tek başına yok.
//  2) Ajan keşfi YALNIZCA `await ctx.agent.transform(draft => { listed = [...draft.list()]; })` capture kalıbıyla
//     (dönüş değeri liste sanılmaz; guard yoksa sessiz geç); elemanlar AgentV2Info objesi → `id` alanı okunur,
//     string gelirse aynen kabul. Sıralama: bilinen grup sabit sırada
//     (orchestrator, explorer, librarian, oracle, designer, fixer, observer, council/councillor),
//     bilinmeyenler alfabetik "diğer" kovası.
//  3) hasOhMy probe: ctx üzerinde oh-my izi veya config `agents` bloğu varsa oh-my yolu, yoksa host yolu —
//     ŞİMDİ sadece tespit + log, yazma YOK.
//  4) `/model-ata` komutu: `execute: async (invocation) => ...`; önce `invocation?.sessionID` varsa
//     `ctx.session.prompt({ sessionID, text: summary })`, yoksa host fallback'leri; içerik SALT-OKUNUR özet
//     (picker sonraki adım).
//  5) retry hook (`await ctx.session.hook("retry", ...)`) şimdilik sadece loglar, event.decision'a DOKUNMAZ
//     (steering sonraki adım). Katalog dışı model/provider adı hardcode YOK; liste her zaman ctx'ten.
//     `setup` async'tir (transform/hook `await` ile kurulur); dispose senkron kalır.
// Sonraki adımlar: picker UI → oh-my/host yazma (agents.<ajan>.model / agent.<ad>.model + state) → retry steering (switchModel).

// Bilinen ajan grubu: sabit sıra. Katalogdan gelmeyen adlar alfabetik "diğer" kovasına düşer.
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

async function setup(ctx) {
  console.log("[model-router] v2 setup invoked");

  // Her registration'ın disposer'ı burada toplanır; setup'un döndürdüğü dispose hepsini çalıştırır.
  // track(): promise değil Registration/dispose-fn kabul eder — `await` sonrası dönen `reg` objesinde
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

  // Karar 1 — zincir girişi { providerID, id, variant? }; dedup anahtarı providerID/id/variant.
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

  // Karar 2 — ajan keşfi: `await ctx.agent.transform` + dış değişkene capture; guard yoksa sessiz geç.
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

  // Karar 2 — sıralama: bilinenler sabit sırada, bilinmeyenler alfabetik.
  const sortAgents = (names) => {
    const rank = new Map(KNOWN_ORDER.map((n, i) => [n, i]));
    return [...names].sort((a, b) => {
      const ra = rank.has(a.toLowerCase()) ? rank.get(a.toLowerCase()) : Infinity;
      const rb = rank.has(b.toLowerCase()) ? rank.get(b.toLowerCase()) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  };

  // Karar 3 — hasOhMy probe (SADECE tespit + log, yazma yok).
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

  // ModelRef formatlama: { providerID, id, variant? } → "provider/id/variant"; string aynen.
  const formatModel = (m) =>
    m == null
      ? "—"
      : typeof m === "string"
        ? m
        : [m.providerID, m.id, m.variant].filter(Boolean).join("/");

  // Karar 4 — mevcut atamaların salt-okunur okuması (okuma transform callback İÇİNDE; `draft.get` await'li).
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

  const buildSummary = async () => {
    const names = sortAgents(await listAgents());
    const { hasOhMy, signals } = probeOhMy();
    const assign = await readAssignments(names);
    const lines = [
      "## model-ata (salt-okunur özet)",
      `- mod: ${hasOhMy ? "oh-my (ileride agents.<ajan>.model=[p,s,t])" : "host (ileride agent.<ad>.model=primary + state dosyası)"}${signals.length ? ` — iz: ${signals.join(", ")}` : ""}`,
      `- ajanlar (${names.length}):`,
      ...names.map((n) => `  - ${n}: ${assign[n] ?? "—"}`),
      "- not: picker fazı sonraki adım; bu komut yazma yapmaz.",
    ];
    return lines.join("\n");
  };

  // Boot log: keşif + mod tespiti (yerel dizin loader doğrulamasına da sinyal verir).
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

  // Karar 4 — `/model-ata` komutu (guard'lı; execute şimdilik salt-okunur özet yazar).
  try {
    if (typeof ctx.command?.transform === "function") {
      track(
        await ctx.command.transform((draft) =>
          draft.add({
            name: "model-ata",
            description: "Ajan→model atamalarının salt-okunur özeti (picker sonraki adım)",
            execute: async (invocation) => {
              const summary = await buildSummary();
              // oh-my yolu: invocation.sessionID + ctx.session.prompt (guard'lı).
              try {
                const sid = invocation?.sessionID;
                if (sid != null && typeof ctx.session?.prompt === "function") {
                  await ctx.session.prompt({ sessionID: sid, text: summary });
                  return;
                }
              } catch (err) {
                console.log("[model-router] summary write failed", err?.message ?? err);
                return;
              }
              // Host fallback'leri.
              const targets = [invocation, ctx];
              for (const t of targets) {
                try {
                  if (t && typeof t.session?.append === "function") {
                    await t.session.append(summary);
                    return;
                  }
                  if (t && typeof t.append === "function") {
                    await t.append(summary);
                    return;
                  }
                  if (t && typeof t.say === "function") {
                    await t.say(summary);
                    return;
                  }
                  if (t && typeof t.message === "function") {
                    await t.message(summary);
                    return;
                  }
                } catch (err) {
                  console.log("[model-router] summary write failed", err?.message ?? err);
                  return;
                }
              }
              console.log(summary);
            },
          })
        )
      );
    }
  } catch (err) {
    console.log("[model-router] command register failed", err?.message ?? err);
  }

  // Karar 5 — retry hook: şimdilik SADECE log; event.decision'a dokunulmaz (steering sonraki adım).
  try {
    if (typeof ctx.session?.hook === "function") {
      track(
        await ctx.session.hook("retry", async (event) => {
          const canSteer = typeof ctx.session?.switchModel === "function";
          console.log(
            `[model-router] retry event (steer:${canSteer ? "ready" : "pending"})`,
            event?.agent ?? event?.agentName ?? ""
          );
          // Steering sonraki adımda; bu fazda event.decision'a dokunulmaz.
        })
      );
      if (typeof ctx.session?.switchModel !== "function")
        console.log("[model-router] switchModel yok — steering beklemede, hook yalnızca loglar");
    }
  } catch (err) {
    console.log("[model-router] retry hook failed", err?.message ?? err);
  }

  // Dispose: tüm registration'lar tek noktadan çözülür (senkron).
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
