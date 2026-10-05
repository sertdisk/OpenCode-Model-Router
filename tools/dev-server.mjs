// Model Router dev sunucusu: mock ctx ile plugini standalone calistirir,
// /api/state + /api/models + /api/save + /api/apply self-testini kosar, sureci acik tutar.
// Kullanim: bun tools\dev-server.mjs   (port override: MODEL_ROUTER_PORT=39999)
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.MODEL_ROUTER_PORT || "39999";
process.env.MODEL_ROUTER_PORT = PORT;

// Gecici izole dosyalar (gercek config'e DOKUNULMAZ).
const gecici = mkdtempSync(join(tmpdir(), "model-router-dev-"));
const stateYolu = join(gecici, "state.json");
const ohmyYolu = join(gecici, "oh-my-opencode-slim.json");
const hostYolu = join(gecici, "opencode.jsonc");
const webDizini = join(gecici, "web");
process.env.MODEL_ROUTER_STATE_PATH = stateYolu;
process.env.MODEL_ROUTER_OHMY_PATH = ohmyYolu;
process.env.MODEL_ROUTER_HOST_CONFIG = hostYolu;
process.env.MODEL_ROUTER_WEB_DIR = webDizini;

mkdirSync(webDizini, { recursive: true });
writeFileSync(join(webDizini, "index.html"), "<!doctype html><html><body><h1>DEV MARKER</h1></body></html>", "utf8");
writeFileSync(join(webDizini, "app.js"), "/* dev */", "utf8");
writeFileSync(join(webDizini, "style.css"), "/* dev */", "utf8");

// oh-my taslagi: librarian'da string-dizi formati (stil aynalama testi),
// orchestrator preset'te duz string (varsayilan obje formati testi).
writeFileSync(
  ohmyYolu,
  JSON.stringify(
    {
      preset: "dev",
      presets: { dev: { orchestrator: { model: "mock-a/old-model", skills: [] } } },
      agents: { librarian: { model: ["mock-a/m1", "mock-a/m2"] } },
    },
    null,
    2
  ),
  "utf8"
);
// Host taslagi: duz JSON (yapisal yol testi). plan blogu state'te yok -> eklenmemeli.
writeFileSync(
  hostYolu,
  JSON.stringify(
    { agent: { orchestrator: { model: "mock-a/old-model" }, plan: { model: "mock-a/plan-model" } } },
    null,
    2
  ),
  "utf8"
);

// 12 ajan + mevcut atamalar (ikisi bos -> current null).
const AJANLAR = [
  "orchestrator", "explorer", "librarian", "oracle", "designer", "fixer",
  "observer", "council", "councillor", "planner", "reviewer", "researcher",
];
const MEVCUT = {
  orchestrator: "mock-a/old-model",
  explorer: "mock-b/scout",
  librarian: "mock-a/m1",
  oracle: "mock-b/think",
  designer: "mock-a/draw",
  fixer: "mock-b/fix",
  observer: "mock-a/watch",
  council: "mock-b/vote",
  councillor: "mock-b/vote2",
  planner: "mock-a/plan",
};
const MODELLER = [
  { providerID: "mock-a", id: "m-alpha", name: "Mock Alpha" },
  { providerID: "mock-a", id: "m1", name: "Mock One" },
  { providerID: "mock-a", id: "team/model-x", name: "Mock Slash" },
  { providerID: "mock-b", id: "scout", name: "Mock Scout" },
  { providerID: "mock-b", id: "think", name: "Mock Think" },
  { providerID: "mock-b", id: "fix", name: "Mock Fix" },
];

let reloadCagrildi = false;
const ctx = {
  agent: {
    transform: async (fn) =>
      fn({
        list: async () => AJANLAR.map((id) => ({ id })),
        get: async (id) => (MEVCUT[id] ? { model: MEVCUT[id] } : {}),
      }),
    reload: async () => {
      reloadCagrildi = true;
    },
  },
  command: {
    transform: async (fn) => fn({ add: () => ({ dispose() {} }) }),
  },
  session: {
    hook: async () => () => {},
  },
  model: {
    list: async () => MODELLER,
  },
};

const taban = `http://127.0.0.1:${PORT}`;
const kisa = (o, n) => {
  try {
    const s = JSON.stringify(o);
    return s.length > n ? `${s.slice(0, n)}...` : s;
  } catch {
    return "?";
  }
};

let dispose = null;
try {
  const plugin = (await import("../src/model-router.js")).default;
  dispose = await plugin.setup(ctx);
} catch (err) {
  console.log(`[dev-server] setup hatasi: ${err?.message ?? err}`);
  process.exit(1);
}

// Sunucu hazir olana kadar bekle.
let hazir = false;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`${taban}/api/probe`);
    if (r.ok) {
      hazir = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
if (!hazir) {
  console.log("[dev-server] sunucu acilmadi");
  process.exit(1);
}
console.log(`[dev-server] hazir ${taban} (gecici: ${gecici})`);

try {
  // 1) statik
  const kok = await fetch(`${taban}/`);
  const kokMetin = await kok.text();
  console.log(`[test] GET / -> ${kok.status} marker=${kokMetin.includes("DEV MARKER") ? "var" : "YOK"}`);
  const fav = await fetch(`${taban}/favicon.ico`);
  console.log(`[test] GET /favicon.ico -> ${fav.status} (beklenen 204)`);

  // 2) state
  const st = await (await fetch(`${taban}/api/state`)).json();
  console.log(
    `[test] GET /api/state -> ok=${st.ok} version=${st.server?.version} port=${st.server?.port} ` +
      `agents=${st.agents?.length} models=${st.models?.length} ` +
      `catalog=${st.meta?.catalogCount} visible=${st.meta?.visibleCount} hidden=${st.meta?.hiddenCount} ` +
      `hasOhMy=${st.meta?.hasOhMy}`
  );
  console.log(`[test] state ornek ajan: ${kisa(st.agents?.[0], 220)}`);

  // 3) models (+all=1 ayni donmeli; mock kumede gizli yok)
  const m1 = await (await fetch(`${taban}/api/models`)).json();
  const m2 = await (await fetch(`${taban}/api/models?all=1`)).json();
  console.log(
    `[test] GET /api/models -> source=${m1.source} n=${m1.models?.length} counts=${kisa(m1.counts, 80)}`
  );
  console.log(`[test] GET /api/models?all=1 -> n=${m2.models?.length}`);

  // 4) save (id'de slash: ilk "/" bolunur)
  const saveGovde = {
    chains: {
      orchestrator: { primary: "mock-a/team/model-x", secondary: "mock-b/think", tertiary: null },
      librarian: { primary: "mock-a/m1", secondary: null, tertiary: null },
    },
  };
  const sv = await (
    await fetch(`${taban}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saveGovde),
    })
  ).json();
  console.log(`[test] POST /api/save -> ${kisa(sv, 200)}`);
  const st2 = await (await fetch(`${taban}/api/state`)).json();
  const ork = (st2.agents || []).find((a) => a.id === "orchestrator");
  console.log(`[test] state zincir dogrulama (orchestrator): ${kisa(ork?.chain, 160)}`);

  // 5) apply (yapisal host yolu)
  const ap = await (await fetch(`${taban}/api/apply`, { method: "POST" })).json();
  console.log(`[test] POST /api/apply -> ${kisa(ap, 400)} reloadCagrildi=${reloadCagrildi}`);
  const ohmySon = JSON.parse(readFileSync(ohmyYolu, "utf8"));
  const hostSon = JSON.parse(readFileSync(hostYolu, "utf8"));
  console.log(`[test] ohmy agents.orchestrator.model: ${kisa(ohmySon.agents?.orchestrator?.model, 200)}`);
  console.log(`[test] ohmy agents.librarian.model (string stil korunmali): ${kisa(ohmySon.agents?.librarian?.model, 200)}`);
  console.log(`[test] ohmy preset korundu mu: ${typeof ohmySon.presets?.dev?.orchestrator?.model === "string" ? "evet" : "HAYIR"}`);
  console.log(`[test] host orchestrator.model: ${hostSon.agent?.orchestrator?.model} plan.model: ${hostSon.agent?.plan?.model} librarian eklendi mi: ${"librarian" in (hostSon.agent || {}) ? "HAYIR-EKLENMIS" : "hayir"}`);

  // 6) apply regex dususu: host'a yorum ekle (JSON.parse basarisiz) ve tekrar uygula
  writeFileSync(hostYolu, `{\n  // yorum: regex dususu testi\n  "agent": {\n    "orchestrator": {\n      "model": "mock-a/old-model"\n    }\n  }\n}\n`, "utf8");
  const ap2 = await (await fetch(`${taban}/api/apply`, { method: "POST" })).json();
  const hostHam = readFileSync(hostYolu, "utf8");
  const rx = /"orchestrator"\s*:\s*\{[^}]*?"model"\s*:\s*"([^"]*)"/.exec(hostHam);
  console.log(`[test] regex dususu apply -> target=${ap2.target} hostUpdated=${kisa(ap2.hostUpdated, 60)} model=${rx?.[1]} notes=${kisa(ap2.notes, 160)}`);

  // 7) hatali save (400 beklenir)
  const kotu = await fetch(`${taban}/api/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chains: { x: { primary: "slashsiz" } } }),
  });
  console.log(`[test] POST /api/save (hatali) -> status=${kotu.status} (beklenen 400)`);
} catch (err) {
  console.log(`[dev-server] self-test hatasi: ${err?.message ?? err}`);
}

console.log(`[dev-server] self-test bitti; sunucu acik (${taban}). Kapatmak icin Ctrl+C.`);
setInterval(() => {}, 1 << 30);
const kapat = () => {
  try {
    if (typeof dispose === "function") dispose();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", kapat);
process.on("SIGTERM", kapat);
