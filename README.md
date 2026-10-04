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
