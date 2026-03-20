# Kairo Logo

## Design Concept

- **Prism/diamond** — one input (AI), multiple outputs (channels). Literally what Kairo does.
- **Fiber optic streams** — connections flowing to different platforms
- **Purple → cyan gradient** — brand color palette
- **"AI" highlighted in cyan** — the AI is embedded in the name: K-**AI**-RO
- **Dark navy background** — matches the admin UI theme

## Generation Details

| Field | Value |
|-------|-------|
| **Model** | FLUX.2-dev (Black Forest Labs) |
| **Quantization** | 4-bit BnB (diffusers/FLUX.2-dev-bnb-4bit) |
| **Pipeline** | Flux2Pipeline (HuggingFace Diffusers) |
| **Hardware** | NVIDIA GeForce RTX 3090, 24GB VRAM |
| **Infrastructure** | Self-hosted GPU server |
| **Date** | 2026-03-20 |
| **Resolution** | 1024x1024 |
| **Steps** | 30 |

## Prompt

```
Centered logo on dark navy background. Top: a glowing prism or diamond shape
splitting a single beam of light into multiple colorful fiber optic streams
going in different directions, purple to cyan gradient, representing one AI
gateway routing to many channels. Bottom: text KAIRO with the letters AI in
bold glowing cyan color standing out from the white K and RO letters. Clean
modern font. Professional tech brand, centered
```

## License

FLUX.2-dev is released under Apache 2.0 license by Black Forest Labs.
Generated on self-hosted infrastructure — no third-party API used.
