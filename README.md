# OpenCode Model Router

Per-agent 3'lu zincir (primary/secondary/tertiary) model yonlendirme:
provider-nitelikli ref (`{ providerID, id, variant? }`), oh-my stratejisi
(oh-my varsa `agents.<ajan>.model`, yoksa host `agent.<ad>.model` + state).

## Kurulum (dev)

1. Repoyu klonla.
2. `tools\install-dev.ps1` calistir (repo -> `C:\Users\Hb\.config\opencode\plugins\model-router.js` kopyalar).
3. Opencode'u restart et.
4. `/model-router` komutuyla salt-okunur ozeti gor.

## Durum (iskelet v0.1.0)

- Salt-okunur ozet (`/model-router`) + log-only retry hook.
- Picker UI / yazma (oh-my/host) / retry steering sirada.

## Dogrulama

```sh
node --check src/model-router.js
npm run check
```
