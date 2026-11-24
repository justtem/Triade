# Contrast Story — Alternância Escuro ↔ Claro para Vendas Consultivas & B2B

- **ID:** `contrast-story`
- **Tema:** `dark`
- **Vibe:** Narrativa visual de alto impacto alternando blocos Pretos e Brancos no scroll (inspiração HackerRank).
- **Tags:** b2b, consultoria, educacao, curso, software, corporativo, escuro, contraste, verde

## Paleta & Tokens (:root)
```css
:root {
  --dark-bg: #08090c;
  --dark-surface: #12141a;
  --dark-ink: #f5f7fa;
  --dark-muted: #98a0b0;
  --dark-border: #232733;
  --light-bg: #ffffff;
  --light-surface: #f4f6f8;
  --light-ink: #0c0f14;
  --light-muted: #525a69;
  --light-border: #e2e6ee;
  --accent: #16c76b;
  --accent-ink: #04130b;
  --radius-card: 22px;
  --radius-pill: 999px;
}
```

## Tipografia & Hierarquia
- Display centralizado no Hero (`clamp(2.4rem, 5.4vw, 4.4rem)`, `letter-spacing: -0.035em`), destacando **1 ou 2 palavras-chave na cor `--accent`** junto a micro-ícones SVG inline alinhados à linha do texto.

## Composição & Seções Obrigatórias
1. **Faixa 1 — Hero Escuro Cinematográfico (`--dark-bg`):** navbar minimalista, manchete centralizada com destaque `--accent`, subtítulo direto, CTA principal com borda iluminada + botão **WhatsApp** e moldura sutil inferior para `data-image-slot="1"`.
2. **Faixa 2 — Transição para Bloco Branco (`--light-bg`) "Escolha seu Caminho":** 2 cards escuros grandes lado a lado (`--dark-surface`, ex.: *Para Você / Pessoa Física* vs. *Para Empresas / Equipes* ou *Plano Essencial* vs. *Plano Completo*), cada um com checklist de 3 bullets, detalhe gráfico SVG e CTA em `--accent`.
3. **Faixa 3 — Storytelling Interativo (3 Etapas no Branco):** coluna esquerda com 3 blocos numerados/destacáveis (clique ou scroll ativa o destaque `--accent`); coluna direita com `data-image-slot="2"` e card flutuante escuro sobreposto mostrando status/resultados reais.
4. **Faixa 4 — Retorno ao Bloco Escuro (`--dark-bg`):** demonstração do resultado final com `data-image-slot="3"`, métricas animadas (`98%`, `24h`, `+500`), depoimentos e FAQ acordeão.
5. **Faixa 5 — CTA Final de Conversão Dupla (Formulário de Leads + WhatsApp) + Footer Escuro.**
