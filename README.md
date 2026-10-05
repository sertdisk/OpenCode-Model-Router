# OpenCode Model Router

Per-agent 3'lu zincir (primary/secondary/tertiary) model yonlendirme:
provider-nitelikli ref (`{ providerID, id, variant? }`), oh-my stratejisi
(oh-my varsa `agents.<ajan>.model`, yoksa host `agent.<ad>.model` + state).

## Kurulum (dev)

1. Repoyu klonla.
2. `tools\install-dev.ps1` calistir (repo -> `C:\Users\Hb\.config\opencode\plugins\model-router.js` kopyalar).
3. Opencode'u restart et.
4. `/model-router` komutunu calistir, acilan sorulari yanitla (ajan + primary/secondary/tertiary).

## Akis (faz-2, question-aracili)

`/model-router`, agent'a Turkce bir TALIMAT metni gonderir. Agent:

1. `question` tool ile TEK modalda 4 soru sorar: ajan secimi (kesfedilen liste +
   mevcut atamalar), primary, secondary, tertiary (tertiary atlanabilir).
2. Model secenekleri: katalog probe'u bulduysa kesfedilen listedir
   (`provider/id` formatinda, ayni model farkli saglayicida ayri secenek);
   bulunamadiysa agent `opencode models` ciktisindan ve aktif config'den derler —
   SADECE aktif (auth'lu) saglayici + modeller secenek olur. Variant sorulmaz.
3. Sonucu state dosyasina yazar, primary'yi HEMEN uygular
   (oh-my ise `oh-my-opencode-slim.json` icinde `agents.<ajan>.model`,
   degilse host `opencode.jsonc` icinde `agent.<ajan>.model="provider/id"`).
   Secondary/tertiary sadece state dosyasinda durur.
4. Kullaniciya 3 satirlik ozet verir (ajan, zincir, uygulanan).

## State dosyasi

Yol: `C:\Users\Hb\.config\opencode\model-router.json`

Format:

```json
{
  "version": 1,
  "updatedAt": "<ISO zaman>",
  "chains": {
    "<ajan>": {
      "primary": { "providerID": "<p>", "id": "<m>", "variant": "<v, opsiyonel>" },
      "secondary": { "providerID": "<p>", "id": "<m>" },
      "tertiary": { "providerID": "<p>", "id": "<m>" }
    }
  }
}
```

`tertiary` atlandiysa `null` olur. Retry steering (sonraki faz) bu dosyayi okuyacak.

## Gereksinim

- Model secenekleri icin `opencode models` komutu calisabilir olmali
  (katalog probe'u bos donerse agent bu ciktiya basvurur).

## Test adimi

1. Opencode'u restart et.
2. `/model-router` calistir.
3. Acilan 4 soruyu yanitla (ajan, primary, secondary, tertiary/atla).
4. State dosyasinin yazildigini ve primary'nin uygulandigini dogrula.

## Durum (faz-2)

- Question-aracili grafik secim akisi (`/model-router` -> TALIMAT -> sorular -> state + primary uygula).
- Retry hook hala log-only (steering sonraki faz).

## Dogrulama

```sh
node --check src/model-router.js
npm run check
```

## Web UI (yerel sunucu)

Plugin, `127.0.0.1:37337` portunda bir web sunucusu acar
(override: `MODEL_ROUTER_PORT` ortam degiskeni).

- Tarayicida ac: `http://127.0.0.1:37337`
- `GET /api/state`: ajanlar (mevcut atama + zincir), gorunur modeller, sayaçlar
  (`catalogCount` / `visibleCount` / `hiddenCount`), oh-my varligi ve dosya yollari.
- `GET /api/models`: gorunur modeller; `?all=1` ile filtresiz katalog (debug).
- `POST /api/save` (`{ chains: { "<ajan>": { primary, secondary, tertiary } } }`,
  degerler `"provider/id"` ya da `null`): state dosyasina birlestirerek yazar
  (diger ajanlar korunur; model degismediyse variant korunur).
- `POST /api/apply` (govdesiz): state zincirlerini gercek config'lere uygular —
  oh-my varsa `oh-my-opencode-slim.json` icinde top-level `agents.<ajan>.model`
  dizisi (eleman formati dosyadaki mevcut kullanimla ayni: `{id}` objesi ya da
  string; diger alanlar/presetler korunur), host `opencode.jsonc` icinde ZATEN
  var olan `agent.<ajan>` bloklarinin `model` degeri primary ile guncellenir
  (yeni ajan anahtari eklenmez). Her dosyadan once `<dosya>.model-router.bak`
  yedegi alinir. Sonunda `ctx.agent.reload` guard'li denenir.

Statik UI dosyalari (`index.html`, `app.js`, `style.css`) su sirada aranir:
`MODEL_ROUTER_WEB_DIR` -> `~/.config/opencode/model-router-web/`
(`install-dev.ps1` buraya kopyalar) -> repo `web/` yedegi.

Test path override'lari (prod varsayilanlari parantezde):
`MODEL_ROUTER_STATE_PATH` (state dosyasi), `MODEL_ROUTER_OHMY_PATH`
(`~/.config/opencode/oh-my-opencode-slim.json`), `MODEL_ROUTER_HOST_CONFIG`
(`~/.config/opencode/opencode.jsonc`), `MODEL_ROUTER_WEB_DIR`.

## Dev sunucusu (mock ctx)

```sh
bun tools\dev-server.mjs
```

Mock ctx (12 ajan + ornek modeller) ile plugini standalone calistirir,
`/api/state`, `/api/models`, `/api/save`, `/api/apply` self-testini gecici
dosyalar uzerinde kosar (gercek config'e dokunmaz), sonucu konsola yazar ve
sureci acik tutar (kapatmak icin Ctrl+C).
