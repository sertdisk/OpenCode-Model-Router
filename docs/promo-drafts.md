# Promo Drafts — OpenCode Model Router

All facts below are limited to the verified product facts (MIT, v0.3.1, repo: https://github.com/sertdisk/OpenCode-Model-Router). No usage numbers, stars, downloads, or benchmarks are claimed.

---

## 1. Blog showcase article (English)

# OpenCode Model Router: per-agent model fallback chains with a local web UI

Long sessions tend to end the same way: the primary model starts returning rate-limit errors, or the provider goes quiet mid-task. The work is half done, the context is fully loaded, and the fix is either to wait or to switch models by hand and hope continuity survives. If you run more than one provider — OpenRouter, DeepSeek, and others — you already have somewhere to fail over to. What is usually missing is a way to declare "this agent tries A, then B, then C" and have that applied automatically when A stops answering. Waiting out a rate limit is fine once; doing it repeatedly, across agents and providers, is what gets old.

[OpenCode Model Router](https://github.com/sertdisk/OpenCode-Model-Router) is an OpenCode plugin that adds exactly that. Every OpenCode agent gets its own model fallback chain: a primary, a secondary, and a tertiary model. When the primary model fails or does not respond, the plugin fails over to the second step, and then to the third. The project is MIT-licensed and currently at v0.3.1.

## Per-agent chains

A chain is an ordered list of model refs in the form `{providerID, id, variant?}`. The provider is part of a step's identity: the same model served by two different providers counts as two separate steps. That matters because the failure you are often defending against is the provider, not the model itself — a chain like "model X on provider A, model X on provider B, model Y on provider C" keeps the same model behavior for as long as possible and only changes model when both routes to it are gone.

Chains are per agent because agents do different work. A long-running coding agent and a short review agent do not need the same ordering, and one global fallback list forces a compromise between them. Each agent keeps its own three slots.

A step can carry an optional `variant`, so two builds of the same model id can be ordered as distinct steps. Three slots is the whole model: primary, secondary, tertiary — enough to cover a provider outage plus a second degraded route in the same session, and short enough that keeping chains correct stays a small task.

The model picker only offers models and providers that you have already added and enabled in OpenCode. It mirrors the visibility configured under Settings > Models, reading that state from `drafts.sqlite`. Nothing is discovered or enabled behind your back; if a model is not part of your OpenCode setup, it does not appear in the picker, and every step you configure is something your installation can actually call.

## The web UI

Chains are managed from a small web UI that the plugin serves itself at http://127.0.0.1:37337. The listener binds to 127.0.0.1 only, so it is not exposed to the network. The UI is dark-themed and plain: an agent list, a three-slot chain editor, and a provider-grouped, searchable model drawer with keyboard navigation. Saving and applying writes the configuration and leaves a backup of the file it changes. If you would rather not leave the terminal, a `/model-router` command provides a fallback path to the same management.

## oh-my-opencode-slim, natively

If you run oh-my-opencode-slim, the plugin writes chains as native `agents.<agent>.model` arrays into the oh-my configuration, where its failover engine picks them up directly. On a plain OpenCode setup, the plugin writes the host configuration instead. Only one of the two is written at a time — the oh-my file or the host config, never both — so the two cannot drift apart. Each write also produces a `.model-router.bak` backup next to the target file, which makes reverting a bad change a copy operation.

## Install

```
git clone https://github.com/sertdisk/OpenCode-Model-Router
powershell -ExecutionPolicy Bypass -File tools/install-dev.ps1
```

The plugin has zero dependencies. The README covers setup in both English and Turkish.

## Limitations

Two constraints are worth stating plainly. First, the plugin orders and fails over between models you already have; it does not provision anything. The models you want in the secondary and tertiary slots must be added and enabled in OpenCode first, or the picker will not show them. Second, the management UI is local-only. It binds to 127.0.0.1, there is no remote management surface, and chains are configured from the machine running OpenCode. If you need to edit chains from another machine, this plugin does not do that.

Beyond that, the scope is narrow on purpose: three slots per agent, one writer for the config, and a backup on every write. If that matches how you run multiple providers, the repository is at https://github.com/sertdisk/OpenCode-Model-Router.

---

## 2. Reddit post for r/opencode

**Title:** I built OpenCode Model Router: per-agent primary/secondary/tertiary model fallback chains with a local web UI

**Body:**

Every long session eventually hits a rate limit or a provider outage on the primary model, right when the context is fully loaded. I kept switching models by hand and losing the thread, so I built a plugin for it.

OpenCode Model Router gives every OpenCode agent its own model fallback chain: primary, secondary, tertiary. If the primary fails or does not respond, it fails over to the second, then the third. A chain step is a model ref `{providerID, id, variant?}`, and the same model on two different providers counts as two steps, which helps when the provider is the thing going down.

The model picker only shows models and providers already added and enabled in OpenCode (it mirrors Settings > Models via drafts.sqlite), so a chain only contains things my setup can actually call.

Chains are managed from a local web UI the plugin serves at http://127.0.0.1:37337 (bound to 127.0.0.1 only), with a /model-router terminal command as fallback. For oh-my-opencode-slim users, chains are written as native agents.<agent>.model arrays into the oh-my config and picked up by its failover engine; plain OpenCode host config works too. Only one target is written at a time, with a .model-router.bak backup on every write. Zero dependencies.

Repo: https://github.com/sertdisk/OpenCode-Model-Router

Feedback is welcome, especially from oh-my-opencode-slim users.

---

## 3. Show HN submission

Title: Show HN: OpenCode Model Router – per-agent model fallback chains

URL: https://github.com/sertdisk/OpenCode-Model-Router

Text: I built OpenCode Model Router, an OpenCode plugin that gives every agent its own model fallback chain: primary, secondary, tertiary. When the primary model fails or stops responding, requests fail over to the second step, then the third. Each step is a model ref (providerID, id, optional variant), and the same model on two different providers counts as separate steps, so a chain can ride out a provider outage without changing models.

The management UI is a web UI because editing per-agent chains in JSON gets old fast. The plugin serves a small dark-themed UI at http://127.0.0.1:37337, bound to 127.0.0.1 only, with a three-slot chain editor and a provider-grouped model drawer; there is a /model-router terminal command as fallback. Zero dependencies. For oh-my-opencode-slim, chains are written natively as agents.<agent>.model arrays and picked up by its failover engine.

Repo: https://github.com/sertdisk/OpenCode-Model-Router (MIT)

---

## 4. Turkish summary (report-back)

OpenCode Model Router için tanıtım metinlerini üç kanal için hazırladım: İngilizce blog showcase yazısı (700-900 kelime), r/opencode için Reddit paylaşımı ve Show HN gönderisi. Metinler yalnızca doğrulanmış özelliklere dayanıyor: ajan başına birincil/ikincil/üçüncül model yedeklilik zinciri, http://127.0.0.1:37337 üzerindeki yerel web arayüzü, oh-my-opencode-slim için yerel `agents.<agent>.model` yazımı ve sıfır bağımlılık. Kullanım sayısı, yıldız veya indirme gibi kanıtsız hiçbir iddia kullanılmadı.
