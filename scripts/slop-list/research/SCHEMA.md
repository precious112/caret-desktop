# Slop list entry format (one JSON array per file)

Each entry:
{
  "id": "claude-eyebrow-above-hero",          // kebab-case, unique, prefixed by family
  "family": "claude" | "gpt" | "gemini" | "kimi" | "glm" | "deepseek" | "qwen" | "minimax" | "any",
  "models": ["Claude Opus 4.6", ...],          // exact model names the sources mention, if any
  "kind": "element" | "treatment" | "layout" | "copy" | "foundation",
  "name": "Small uppercase label (eyebrow) above the hero heading",
  "description": "What the pattern is, concretely",
  "detect": {
    "type": "dom" | "css" | "text" | "color" | "font" | "structure",
    "hint": "How a script could find it on a rendered page or in a foundation (selectors, computed styles, regexes)",
    "values": ["#8B5E3C", "Inter", ...]       // exact hexes, font names, phrases when sources give them
  },
  "evidence": [
    { "url": "...", "date": "2026-05-14", "author": "...", "quote": "short exact quote", "model_named": "Claude Sonnet 4.6" }
  ],
  "independent_sources": 3,                    // count of distinct authors/sites
  "newest_source_date": "2026-09-02",
  "older_than_7_months": false                 // true if every source is before 2026-03-10
}

Rules: only sources published in 2026. Today is 2026-10-10. Every entry needs at least one URL with a date and a quote. Do not invent hexes, fonts or numbers. Mark anything inferred.
