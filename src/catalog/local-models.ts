/**
 * Local model catalog — curated set of coding-friendly open models that
 * pikiclaw recommends for self-hosted backends (Ollama / LM Studio). Data
 * only; the dashboard joins this list against the user's detected hardware
 * and installed-model lists to produce the "Local Models" section.
 *
 * Sizing rules of thumb used here (Q4_K_M quantization):
 *   weights_gb   ≈ params_b × 0.6        // typical Q4_K_M GGUF size
 *   min_ram_gb   ≈ weights_gb × 1.5 + 4  // KV cache + OS headroom
 *
 * `minRamGb` is conservative on purpose — we'd rather a user be pleasantly
 * surprised than have their Mac thrash on swap. Tags below match Ollama's
 * library namespace and LM Studio's HuggingFace-style identifiers; verify
 * against the live registries before relying on auto-install (Ollama tags
 * occasionally get renamed when families graduate).
 */

export interface LocalModelEntry {
  /** Stable id used by pikiclaw (not surfaced to the user). */
  id: string;
  /** Display name shown in the dashboard. */
  name: string;
  publisher: string;
  /** Approximate parameter count in billions; for MoE models this is the
   *  TOTAL params, not the active set, since RAM cost tracks the former. */
  paramsB: number;
  /** Approx weight footprint at Q4_K_M (GB on disk + as memory baseline). */
  sizeGb: number;
  /** Conservative minimum unified-memory recommendation (GB). */
  minRamGb: number;
  /** Short factual blurb — no marketing claims. */
  description: string;
  descriptionZh: string;
  /** Ollama library tag (https://ollama.com/library/<tag>). Omit if the model
   *  is not in Ollama's library; the dashboard hides install actions then. */
  ollamaTag?: string;
  /** LM Studio model handle (HF-style `org/repo`). Same rule as ollamaTag. */
  lmstudioId?: string;
  /** Homepage / model card link for "learn more" actions. */
  homepage?: string;
}

export const LOCAL_MODELS: LocalModelEntry[] = [
  // ── Tier A: small + tool-capable, fits on 16 GB Macs ───────────────────────
  {
    id: 'qwen3-coder-7b',
    name: 'Qwen3-Coder 7B',
    publisher: 'Alibaba Qwen',
    paramsB: 7,
    sizeGb: 5,
    minRamGb: 16,
    description: 'Compact coding-tuned model; the best 16 GB Mac default for agentic workflows.',
    descriptionZh: '面向代码的小模型，16GB Mac 上跑 agent 的首选。',
    ollamaTag: 'qwen3-coder:7b',
    lmstudioId: 'Qwen/Qwen3-Coder-7B-Instruct',
    homepage: 'https://qwenlm.github.io/blog/qwen3-coder/',
  },
  {
    id: 'llama-3.3-8b',
    name: 'Llama 3.3 8B Instruct',
    publisher: 'Meta',
    paramsB: 8,
    sizeGb: 5,
    minRamGb: 16,
    description: 'General-purpose chat model; competent at tool use, weaker at long-form code edits.',
    descriptionZh: '通用对话模型，工具调用合格，长代码改写偏弱。',
    ollamaTag: 'llama3.3:8b',
    lmstudioId: 'meta-llama/Llama-3.3-8B-Instruct',
    homepage: 'https://www.llama.com/',
  },
  {
    id: 'gemma3-4b',
    name: 'Gemma 3 4B',
    publisher: 'Google DeepMind',
    paramsB: 4,
    sizeGb: 3,
    minRamGb: 8,
    description: 'Smallest entry in this list; works on 8 GB Macs but tool-use is limited.',
    descriptionZh: '清单里最小的模型，8GB Mac 可跑，但工具调用能力有限。',
    ollamaTag: 'gemma3:4b',
    lmstudioId: 'google/gemma-3-4b-it',
    homepage: 'https://ai.google.dev/gemma',
  },

  // ── Tier B: mid-size, 24-32 GB sweet spot ──────────────────────────────────
  {
    id: 'deepseek-coder-v2-lite',
    name: 'DeepSeek-Coder V2 Lite',
    publisher: 'DeepSeek',
    paramsB: 16,
    sizeGb: 10,
    minRamGb: 24,
    description: '16B MoE with ~2.4B active; fast inference and strong code reasoning at mid-tier RAM.',
    descriptionZh: '16B MoE（≈2.4B 激活），中等内存下推理快、代码理解强。',
    ollamaTag: 'deepseek-coder-v2:16b',
    lmstudioId: 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',
    homepage: 'https://github.com/deepseek-ai/DeepSeek-Coder-V2',
  },
  {
    id: 'phi-4',
    name: 'Phi-4 14B',
    publisher: 'Microsoft',
    paramsB: 14,
    sizeGb: 9,
    minRamGb: 24,
    description: 'Reasoning-tuned 14B model; punches above its weight for code and tool tasks.',
    descriptionZh: '14B 推理向模型，在代码与工具任务上表现超出参数量的预期。',
    ollamaTag: 'phi4:14b',
    lmstudioId: 'microsoft/phi-4',
    homepage: 'https://huggingface.co/microsoft/phi-4',
  },

  // ── Tier S: flagship coders, 48 GB+ unified memory ─────────────────────────
  {
    id: 'qwen3-coder-30b',
    name: 'Qwen3-Coder 30B-A3B',
    publisher: 'Alibaba Qwen',
    paramsB: 30,
    sizeGb: 18,
    minRamGb: 36,
    description: 'Flagship open coding model; needs an Apple Silicon Pro/Max with 36 GB+ unified memory.',
    descriptionZh: '开源代码旗舰，建议 36GB+ 统一内存的 M-Pro/Max 机型。',
    ollamaTag: 'qwen3-coder:30b',
    lmstudioId: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    homepage: 'https://qwenlm.github.io/blog/qwen3-coder/',
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5 Air',
    publisher: 'Zhipu',
    paramsB: 12,
    sizeGb: 8,
    minRamGb: 24,
    description: 'Lightweight variant of the GLM-4.5 series; bilingual, tool-aware.',
    descriptionZh: 'GLM-4.5 轻量版，中英双语，原生支持工具调用。',
    ollamaTag: 'glm-4.5:air',
    lmstudioId: 'THUDM/glm-4.5-air',
    homepage: 'https://github.com/zai-org/GLM-V',
  },
];
