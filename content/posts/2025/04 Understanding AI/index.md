---
title: Understanding AI: Generative AI, LLMs, ML & the Open vs Closed Source Debate
description: "Breaking down the buzzwords and tech behind today's AI boom"
date: 2025-04-06
slug: "2025/understanding-ai"
toc: true
math: false
draft: false
Tags:
  - AI
  - Machine Learning
  - LLM
  - Open Source
  - Generative AI
Categories: [Tech, AI]
---


> "The real question is not whether machines think, but whether humans do."  
> — *B.F. Skinner*

## Intro

Unless you’ve been living under a pile of failed `kubectl` commands, you’ve probably noticed AI is everywhere. From image generators that make photorealistic art in seconds, to chatbots that can walk you through debugging your Docker Compose file, AI is embedded in daily life now.

But here’s the thing — not all AI is created equal.

There’s a ton of jargon flying around: LLMs, ML, AI, Generative AI, Transformers, Diffusion Models... and people use them interchangeably (wrongly, I might add). So let’s break this all down, and throw in some opinionated takes on open vs closed source models while we’re at it.

---

## The Big Three

Here’s a super simplified breakdown:

### 1. **Artificial Intelligence (AI)**  
This is the umbrella term. Anything that simulates human intelligence — planning, reasoning, problem-solving — falls under this.

### 2. **Machine Learning (ML)**  
ML is a *subset* of AI. It focuses on training algorithms with data so that they can learn and make predictions or decisions without being explicitly programmed to do so.

Think:
- Sorting your spam emails  
- Recommending you another "Linux ISO" to download (yeah, sure 😏)

### 3. **Generative AI**  
This is a **subset of ML**. It’s trained to create new content — text, images, audio, video — based on learned patterns. It’s what powers:
- ChatGPT (text)
- Midjourney, Stable Diffusion (images)
- Suno, MusicGen (audio)

So where do **LLMs** come into this?

---

## LLMs – Large Language Models

These are the generative AI brainiacs that focus *specifically on text*.

They're the ones reading docs, summarizing PDFs, hallucinating package install instructions, or writing spicy Kubernetes blogs for you.

LLMs are trained on massive amounts of text data and rely heavily on a technique called **Transformers**, which is what revolutionized the AI world circa 2017.

Popular LLMs you’ve probably heard of:
- GPT-4 (OpenAI, closed source)
- Claude (Anthropic, closed source)
- Mistral (Open source, 🔥 fast rising star)
- LLaMA (Meta, open-ish source — depends who you ask)

---

## Closed Source vs Open Source Models

This is where things get juicy.

### 🧱 Closed Source AI (GPT, Claude, Gemini, etc.)

These are typically the domain of Big Tech. They don't share their training data, weights, or inner workings. You’re locked into their ecosystem and pricing models.

**Pros:**
- Generally higher accuracy (as of now)  
- Huge funding = more compute = more training  
- Easier to access if you're non-technical (nice UIs, APIs, etc)

**Cons:**
- No insight into what's under the hood  
- Limited customization  
- Expensive at scale  
- Not privacy-friendly

### 🔓 Open Source AI (Mistral, LLaMA, TinyLLaMA, Mixtral, etc.)

These models release their weights, training data (sometimes), and usually run great on your own hardware or cluster.

**Pros:**
- Complete control & transparency  
- Host it yourself (goodbye API limits!)  
- Customize it to your needs (e.g., domain-specific fine-tuning)  
- Huge OSS community — collaboration is fast-paced

**Cons:**
- Requires more technical know-how  
- May lag slightly behind in benchmark scores  
- Inference can be slower without proper infra (aka don’t expect 7B models to run well on a Pi)

---

## How They Interact

This is something a lot of folks miss: these aren't siloed systems. Here's how the puzzle fits together:

- **ML** is the foundation. It's how all these models are *trained*.  
- **LLMs** are a type of ML model, focused on language. They *use* ML principles.  
- **Generative AI** is a purpose: to *generate* — and LLMs fall under this when they generate text.  
- **You** interact with Generative AI (via UI, chat, API) → the underlying LLM runs inference → built on top of ML training → likely trained using massive GPU farms, a few metric tons of Reddit data, and questionable StackOverflow posts.

---

## My Perspective

Right now, I’m in the process of prepping my environment to run open source LLMs (think: Mistral, TinyLLaMA, and Code LLaMA) directly on my own infrastructure.

The goal?  
- Local, private, fast models  
- No reliance on cloud APIs  
- Fully integrated with my Kubernetes setup

I’ll be writing about that setup (and the fun/chaos of queue-based autoscaling, Grafana monitoring, and model orchestration) in an upcoming post.

For now, just know: open source is not only *viable* — it's starting to lead the charge.

---

## TL;DR

- **AI** is the umbrella.
- **ML** teaches AI how to behave.
- **Generative AI** creates content.
- **LLMs** are language specialists in the generative AI world.
- **Open source** is rising fast and worth your attention.
- My next post will cover how I run LLMs on-demand in a homelab Kubernetes cluster.

Until then, keep your pods healthy, your YAML clean, and your tokens per second high.

