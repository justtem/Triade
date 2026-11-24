# Dark Bento — Tecnologia, Agências & Lançamentos de Alto Impacto

- **ID:** `dark-bento`
- **Tema:** `dark`
- **Vibe:** Escuro cinematográfico de precisão, Bento Grid de dados vivos e estética tech premium (inspiração DeFi Asset Defense + Superlinked).
- **Tags:** tech, agencia, startup, ia, lancamento, crypto, dev, escuro, bento, minimalista

## Paleta & Tokens (:root)
```css
:root {
  --bg: #070709;
  --surface: #101116;
  --surface-elevated: #161820;
  --ink: #f3f4f8;
  --ink-muted: #8f96a8;
  --accent: #ffffff;
  --accent-signal: #7dd3fc;
  --accent-emerald: #34d399;
  --border: #222531;
  --radius-card: 22px;
  --radius-pill: 999px;
}
```

## Tipografia & Hierarquia
- Display geométrico nítido (`font-weight: 600`, `letter-spacing: -0.035em`), números de métricas grandes em `tabular-nums`, labels técnicos em caixa alta (`0.72rem`, `letter-spacing: 0.12em`, `--ink-muted`).

## Composição & Seções Obrigatórias
1. **Navbar Translúcida Escura em Pílula:** marca à esquerda, 4 links centrais em pílula escura com borda `--border` e CTA branco puro (`#ffffff` com texto `#070709`).
2. **Hero Atmosférico Dark:** título centralizado de alto impacto, subtítulo enxuto, 2 botões (`Começar agora` branco + `Falar no WhatsApp` contorno sutil), linhas de fluxo SVG verticais/radiais sutis no fundo e painel de showcase com `data-image-slot="1"`.
3. **Faixa de Logos / Tecnologias / Clientes** em monocromático discreto (`opacity: 0.65`).
4. **Bento Grid de Métricas & Capacidades (2×2 assimétrico):**
   - Card 1: KPI gigante animado (ex.: `98.2%`) + mapa/pontos SVG de alcance.
   - Card 2: Gráfico de barras verticais SVG animadas ao rolar a página.
   - Card 3: Comparativo de crescimento com 2 mini-cards numéricos + `data-image-slot="2"`.
   - Card 4: Fluxo radial interativo `Step 01 → Step 02 → Step 03` com pílulas clicáveis de recursos e `data-image-slot="3"`.
5. **Oferta / Planos Transparentes + FAQ Acordeão + Captura de Leads (Formulário + WhatsApp) + Footer Dark Minimalista.**
