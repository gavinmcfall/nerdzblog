---
title: "Deploying Open Source LLMs in a Homelab - Part 1"
description: "Which models I'm running, why I picked them, and how it's all wired together"
date: 2025-04-07
slug: "2025/deploying-open-llms-01"
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

> "The best way to understand something deeply is to run it yourself."

## Intro

In yesterday's post, I talked about the differences between AI, ML, LLMs, and Generative AI, and how open source models are rapidly catching up to their closed-source counterparts. Today, I want to walk through my actual deployment strategy for open source LLMs in my homelab.

This post will cover:
- What models I'm running and why
- How I’m deploying them (bjw-s app template on Kubernetes)
- Autoscaling strategy
- Resource planning & monitoring

## Model Selection: What and Why

After a bunch of benchmarking, reading, and community chatter, I’ve landed on a short list of models I want to support in my cluster.

### 🧠 Always-On Models

These are the models that stay warm 24/7:

#### - **TinyLLaMA 1.1B**
- ✅ Incredibly lightweight (runs on almost anything)  
- ✅ Great for quick utility tasks, CLI-style interactions  
- ⚠️ Limited in contextual reasoning

#### - **Mistral 7B Instruct**
- ✅ Best-in-class for an open model of this size  
- ✅ Excellent instruction following  
- ✅ Balanced memory usage and performance  
- ⚠️ Slightly behind GPT-4 in nuanced logic tasks

#### - **DeepSeek-Coder 6.7B**
- ✅ Competitive with WizardCoder at half the size  
- ✅ Excellent code generation, explanations, and multi-language support  
- ✅ 16K context, GGUF format available, Apache 2.0 license  
- ⚠️ Slightly slower than Mistral on general tasks

### 💤 On-Demand Models

These models are spun up when needed:

#### - **Mixtral 8x7B**
- ✅ Mixture of Experts (MoE) means only 2 experts are active at a time  
- ✅ Better performance than a monolithic 13B model  
- ✅ One of the best open models for general reasoning and fallback responses  
- ✅ 32K context window  
- ⚠️ Requires more complex infra for loading/unloading

---

## Deployment Strategy

Everything will be deployed using the `bjw-s` app template (unless otherwise shown) inside my `cortex` namespace on my Talos Kubernetes cluster. Models are either always-on (deployed at boot) or models will scale based on future queue integration.

Highlights:
- Load balancing across all 3 MS-01 nodes
- Model quantization via GGUF where applicable
- Inference via `vLLM` or `llama-cpp` depending on the model
- Model image pulling from HuggingFace, managed via Flux

## Autoscaling & Resource Allocation

- **Always-on models:**
  - Scheduled node affinity
  - Memory & CPU limits set per model
  - Ingress-NGINX sits in front of them for routing

- **On-demand models:**
  - Will scale based on future queue integration
  - Horizontal Pod Autoscaler + custom metrics (token/sec, request count)
  - Use anti-affinity to spread pods across nodes

## Monitoring

Grafana dashboards show:
- Token/sec across models
- Inference queue depth
- Memory and CPU usage per pod
- Model readiness & health status (via Gatus)

Also exposing metrics to Homepage for quick glance monitoring.

---

## What’s Next

In the next post, I’ll break down the YAML I use to actually deploy these services, from app-template configs to autoscaling annotations.

Stay tuned — and if you’re self-hosting LLMs too, I’d love to hear what’s working for you.
