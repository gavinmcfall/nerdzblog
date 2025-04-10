---
title: "Deploying Open Source LLMs in a Homelab - Part 2"
description: "Prerequisites and getting Open-WebUI up and running"
date: 2025-04-07
slug: "2025/deploying-open-llms-02"
toc: true
math: false
draft: false
Tags:
  - AI
  - LLM
  - Kubernetes
  - Homelab
  - Mistral
  - DeepSeek
Categories: [AI, Homelab]
---

> "“Ideas are cheap. The real magic happens when those ideas survive YAML, GitOps, and Grafana dashboards.”"

## Intro

In my last post, I talked about my intent. In this post I will document what I am actually doing (and seeing if intent matches reality)

First up is understanding Open-WebUI

## Open Web UI

[Website](https://openwebui.com) | [Github](https://github.com/open-webui/open-webui) | [Documentation](https://docs.openwebui.com/)

Open WebUI lets you run and talk to AI models locally from your browser — no internet or cloud required. It connects to model backends like Ollama or anything OpenAI-compatible, and comes with advanced features like smart document search (RAG) built-in.

This will be our front end (website) that lets us interact with both local models (hosted in our k8s cluster) and remote models (like ChatGPT). This is the ideal place to start before rolling our your own models.

### What is RAG?

Retrieval-Augmented Generation (RAG) is a way of helping AI models give better answers by letting them search through documents or notes you provide — like giving the AI a memory or reference book it can read from before responding.


## Reading the documentation and looking for ENV Vars

One of the first things I want to do is read through the documentation and check that the default values for things are set in the way I would want them to be, and pulling out the ones that are not so I can change them in my deployment.

### Values I need to set and settings I need to change

Some of these I will set in the `helmrelease.yaml` and others in the `externalsecrets.yaml` conventionally our would just store secrets in the external secret file but you can also store other ENV VARS there too if you dont want to bloat our your helm release too much.

`externalsecrets.yaml`

```yaml
        # Open-WebUI Config
        OPENAI_API_KEY: "{{ .OPENAI_API_KEY }}"
        ADMIN_EMAIL: "{{ .OPENAI_ADMIN_EMAIL }}"
        ENABLE_ADMIN_CHAT_ACCESS: "true"
        ENABLE_ADMIN_EXPORT: "true"
        DEFAULT_USER_ROLE: "user"
        DATABASE_URL: "postgres://{{ .OPENWEBUI_DB_USER }}:{{ .OPENWEBUI_DB_PASSWORD }}@postgres17-rw.database.svc.cluster.local:5432/openwebui?sslmode=disable"
        WEBUI_SECRET_KEY: "{{ .WEBUI_SECRET_KEY }}"
        # Pocket ID Config
        OAUTH_PROVIDER_NAME: pocketid
        OAUTH_CLIENT_ID: "{{ .OPENWEBUI_POCKETID_CLIENTID }}"
        OAUTH_CLIENT_SECRET: "{{ .OPENWEBUI_POCKETID_SECRET }}"
        OPENID_PROVIDER_URL: "{{ .OPENWEBUI_POCKETID_DISCOVERY }}"
        OPENID_REDIRECT_URI: "{{ .OPENWEBUI_POCKETID_REDIRECT }}"
        OAUTHS_SCOPE: openid profile email
```

`helmrelease.yaml`

```yaml
              GLOBAL_LOG_LEVEL: "DEBUG"
              ENABLE_LOGIN_FORM: "false"
              OAUTH_MERGE_ACCOUNTS_BY_EMAIL: true
              ENABLE_OPENAI_API: "true"
              ENABLE_OAUTH_SIGNUP: "true"
              ENABLE_WEBSOCKET_SUPPORT: "true"
              WEBSOCKET_MANAGER: "redis"
              WEBSOCKET_REDIS_URL: "redis://dragonfly.database.svc.cluster.local:6379"
              ENABLE_RAG_WEB_SEARCH: true
              RAG_WEB_SEARCH_ENGINE: searxng
              SEARXNG_QUERY_URL: http://searxng.services.svc.cluster.local:8080/search?q=<query>
```

### Open-WebUI ENV Var Notes

#### `ENABLE_LOGIN_FORM`

- **Type:** `bool`  
- **Default:** `True`  
- **Description:** Toggles email, password, sign in and "or" (only when `ENABLE_OAUTH_SIGNUP` is set to True) elements.  
- **Persistence:** This environment variable is a `PersistentConfig` variable.

> ⚠️ **DANGER**  
> This should **only** ever be set to `False` when `ENABLE_OAUTH_SIGNUP` is also being used and set to `True`.  
> Failure to do so will result in the inability to login.



#### `ENABLE_OAUTH_SIGNUP`

- **Type:** `bool`  
- **Default:** `False`  
- **Description:** Enables account creation when signing up via OAuth. Distinct from `ENABLE_SIGNUP`.  
- **Persistence:** This environment variable is a `PersistentConfig` variable.

> ⚠️ **DANGER**  
> `ENABLE_LOGIN_FORM` must be set to `False` when `ENABLE_OAUTH_SIGNUP` is set to `True`. Failure to do so will result in the inability to login.

#### RAG_WEB_SEARCH_ENGINE

- **Type:** `str` (enum)

### 🔍 `RAG_WEB_SEARCH_ENGINE` Options: Comparison Table

| Engine       | Description                                             | Pros                                                              | Cons                                                   |
|--------------|---------------------------------------------------------|-------------------------------------------------------------------|--------------------------------------------------------|
| `searxng`    | Uses the [SearXNG](https://searxng.github.io/) engine   | ✅ Self-hostable, privacy-friendly, highly customizable           | ❌ May require setup and maintenance                   |
| `google_pse` | Google Programmable Search Engine                       | ✅ Accurate, well-indexed, powerful relevance ranking              | ❌ API limits, requires API key                        |
| `brave`      | [Brave Search](https://search.brave.com/)              | ✅ Independent index, private, fast                               | ❌ May lack depth compared to Google                   |
| `kagi`       | [Kagi Search](https://kagi.com/)                       | ✅ Human-curated results, privacy-respecting                      | ❌ Paid subscription required for full access         |
| `mojeek`     | [Mojeek](https://www.mojeek.com/)                      | ✅ Independent crawler, no tracking                              | ❌ Results less relevant for niche topics              |
| `serpstack`  | [Serpstack](https://serpstack.com/)                    | ✅ Easy API for Google results                                    | ❌ Commercial service, requires API key                |
| `serper`     | [Serper](https://serper.dev/)                          | ✅ Google-like output, simple API                                 | ❌ API limits, free tier capped                        |
| `serply`     | [Serply](https://www.serply.io/)                       | ✅ Tailored for AI + LLM use cases                                | ❌ Smaller user base, may have reliability issues      |
| `searchapi`  | [SearchAPI](https://searchapi.io/)                     | ✅ Multiple engines supported, flexible                           | ❌ May introduce latency depending on config           |
| `duckduckgo` | [DuckDuckGo](https://duckduckgo.com/)                  | ✅ Privacy-first, no tracking                                    | ❌ No real API (scraped or proxied, limited metadata) |
| `tavily`     | [Tavily](https://www.tavily.com/)                      | ✅ AI-tuned search for RAG, fast                                  | ❌ Still new, smaller index                           |
| `jina`       | [Jina AI](https://jina.ai/)                            | ✅ Vector-aware search options                                    | ❌ Focused more on enterprise & vector DBs            |
| `bing`       | Microsoft Bing search engine                           | ✅ Wide coverage, high-quality results                            | ❌ Requires API key, tracking concerns                |

{{< notice note >}}
I will be using Searxng which will require me to deploy that BEFORE I can proceed.
{{< /notice >}}

## Deploying SearXNG

As is tradition, I will be walking on the shoulders of giants and taking advantage of [kubesearch.dev](https://kubesearch.dev/hr/ghcr.io-bjw-s-helm-app-template-searxng), an amazing website that:

>Search Flux HelmReleases through awesome k8s-at-home projects, check it out at https://kubesearch.dev/. We index Flux HelmReleases from Github and Gitlab repositories with the k8s-at-home topic and kubesearch topic. To include your repository in this search it must be public and then add the topic k8s-at-home or kubesearch to your GitHub Repository topics.

My Deployment of SearXNG can be found in my  [home-ops repo on github](https://github.com/gavinmcfall/home-ops/tree/main/kubernetes/apps/home/searxng)

There were a couple of interesting learnings from this deployment

In the `settings.yaml` file I wanted to set it up so I could do some regionalised searches so that I could get results for different countries but that, by default, I would get NZ results.

Here are the things I did:

```yaml
search:
  autocomplete: google
  favicon_resolver: duckduckgo
  default_lang: en-NZ
  languages:
    - en-AU
    - en-CA
    - en-GB
    - en-NZ
    - en-US

ui:
  ...
  default_locale: en

engines:
  - name: google
    engine: google
    shortcut: g
    parameters:
      - hl: en
      - gl: nz # This tells Google: "give me NZ-localized results"
      - cr: countryNZ
      - tbs: ctr:countryNZ
```

This allows me to (by default) get localised NZ searches and then just change the language drop down to switch to Canadian, United Kindom, United States or Australian searches

## Deploying Open-WebUI

This was a wild ride. Here are the things I wanted to achieve intially.

- Open-WebUI deployed in a basic fashion
- Connected to my paid OpenAI ChatGPT account
- Login handled by PocketID OIDC
- Sharing of OpenAI Model across users in my instance of Open-WebUI

There was some fenagling and misinterpreting of environment variables ([there are soo many](https://docs.openwebui.com/getting-started/env-configuration/))
But, I got there in the end. You can see my initial (working) deployment [here](https://github.com/gavinmcfall/home-ops/tree/e68425ebe07150ff2abb763022bbf33714613718/kubernetes/apps/cortex/open-webui) and my current state [here](https://github.com/gavinmcfall/home-ops/tree/main/kubernetes/apps/cortex/open-webui)

### Gaining access to OpenAI (chatGPT models from a free or paid account)

1. Browse to [https://openai.com/](https://openai.com/) and Click `Log In` followed by `API Platform`
1. If this is your first time here, you will likely need to set an Organization name. I chose to call mine after my cluster
1. Once logged in, in the left menu, click `API keys` and in the top right click `Create new secret key`
1. Give the secret a name e.g. `Open-WebUI` and assign it to a project (if you have not set any up, then default is fine)
1. Click `Create Secret key` and copy the value that shows up and store it in your secrets manager under the value `OPENAI_API_KEY` (See my `externalsecrets.yaml` example below)


### Deployment Learnings

`helmrelease.yaml`

```yaml
            env:
              GLOBAL_LOG_LEVEL: "DEBUG"
              ENABLE_LOGIN_FORM: "false"
              OAUTH_MERGE_ACCOUNTS_BY_EMAIL: true
              ENABLE_OPENAI_API: "true"
              ENABLE_OAUTH_SIGNUP: "true"
              ENABLE_WEBSOCKET_SUPPORT: "true"
              WEBSOCKET_MANAGER: "redis"
              WEBSOCKET_REDIS_URL: "redis://dragonfly.database.svc.cluster.local:6379"
              ENABLE_RAG_WEB_SEARCH: true
              RAG_WEB_SEARCH_ENGINE: searxng
              SEARXNG_QUERY_URL: http://searxng.services.svc.cluster.local:8080/search?q=<query>
```

1. Make sure you set the Log Level to Debug, it makes deployment and troubleshooting much easier 🤣
1. `ENABLE_LOGIN_FORM: "false"` This need to be false if you are using OIDC
1. `ENABLE_OAUTH_SIGNUP: "true"` If you don't have this set, then your OIDC provider (PocketID in my case), can't create an account inside Open-WebUI

`externalsecret.yaml`

```yaml
        # Open-WebUI Config
        OPENAI_API_KEY: "{{ .OPENAI_API_KEY }}"
        ADMIN_EMAIL: "{{ .OPENAI_ADMIN_EMAIL }}"
        ENABLE_ADMIN_CHAT_ACCESS: "true"
        ENABLE_ADMIN_EXPORT: "true"
        DEFAULT_USER_ROLE: "user"
        DATABASE_URL: "postgres://{{ .OPENWEBUI_DB_USER }}:{{ .OPENWEBUI_DB_PASSWORD }}@postgres17-rw.database.svc.cluster.local:5432/openwebui?sslmode=disable"
        WEBUI_SECRET_KEY: "{{ .WEBUI_SECRET_KEY }}"
        # Pocket ID Config
        OAUTH_PROVIDER_NAME: pocketid
        OAUTH_CLIENT_ID: "{{ .OPENWEBUI_POCKETID_CLIENTID }}"
        OAUTH_CLIENT_SECRET: "{{ .OPENWEBUI_POCKETID_SECRET }}"
        OPENID_PROVIDER_URL: "{{ .OPENWEBUI_POCKETID_DISCOVERY }}"
        OPENID_REDIRECT_URI: "{{ .OPENWEBUI_POCKETID_REDIRECT }}"
        OAUTHS_SCOPE: openid profile email
```

1. `PROVIDER_URL` and `DISCOVERY-URL` are the same damn thing, but different tools call them different things. This should be set to: `https://{your OIDC url}/.well-known/openid-configuration`
1. `OPENID_REDIRECT_URI` Make sure that the path for this is: `https://{Open-WebUI URL}/oauth/oidc/callback`. This needs to be set BOTH in your OIDC config AND your ENV Var in externalsecrets

### Configuration learnings

#### Setting up Groups

If you plan to have more than one user then you should probably setup groups. 

1. Ensure the other users have logged in via OIDC at least once to have their accounts created
1. Navigate to `https://{Open-WebUI URL}/admin/users` and click on Groups.
1. Click the Plus in the top right to create a new group and give it a name (and a description if needed) and click `Create`
1. Viewing your new group Click the ✏️ pencil in the top right to edit it
1. Click Permissions and reivew them, defaults are likely fine but you may want to make some adjustments
1. Click on users and check the box next to each user you want to add to the group

#### Allowing model access

If like me, you configured `OPENAI_API_KEY` in your externalsecret then you will have access to ALL the OpenAI (ChatGPT) models that you plan allows...There is a lot
If you did not (and want to) you will need to go through the process of generating an API Key and adding it to your `externalsecret.yaml` see [above](#gaining-access-to-openai-chatgpt-models-from-a-free-or-paid-account)

1. Navigate to your admin settings `https://{Open-WebUI URL}/admin/settings`
1. In the left manu click on `models`
1. Here you will see a massive list, feel free to disable as many of these as you see fit. I only retained the following:
  - `gpt-3.5-turbo`
  - `gpt-4`
  - `gpt-4-turbo`
  - `gpt-4o`
  - `gpt-4o-mini`
1. Once you have your list, for each one click on the ✏️ pencil
1. Under `Visibility` click `Select a group` and select the group you created earlier.
1. Click `Save & Update`
1. Your other users now have access to use that model
1. Repeat this process for the other models.

#### Chat History

If you are wanting your chat history from ChatGPT you will need to find a way import it directly into the Open-WebUI Database, There is no sync function between Open-WebUI and chat.openai.com


## Next Steps

Next steps will be looking to deploy my own models locally so that long term I have no reliance on paid external tools like OpenAI's ChatGPT