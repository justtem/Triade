# Editorial Luxe — Serviços Premium, Clínicas & Imobiliárias

- **ID:** `editorial-luxe`
- **Tema:** `light`
- **Vibe:** Editorial sofisticado, claro com contraste profundo, luxo silencioso e credibilidade de alto padrão (inspiração Estateo).
- **Tags:** editorial, luxo, clinica, imobiliaria, escritorio, arquitetura, consultoria, claro, serif

## Paleta & Tokens (:root)
```css
:root {
  --bg: #f6f5f2;
  --surface: #ffffff;
  --surface-alt: #eeede8;
  --ink: #121316;
  --ink-muted: #5c606a;
  --accent: #2563eb;
  --accent-soft: #e8f0fe;
  --invert-bg: #111216;
  --invert-ink: #f8f8f6;
  --border: #dfddd6;
  --radius-card: 24px;
  --radius-pill: 999px;
}
```

## Tipografia & Hierarquia
- **Títulos Display:** Sans-serif geométrica limpa (`'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`) combinada com **palavra-chave em Serif itálico** (`'Instrument Serif', Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 400;`) para contraste editorial imediato.
- Tracking negativo nos títulos (`-0.03em`), line-height `1.04`, corpo confortável `16px–17px` com largura máxima de leitura `62ch`.

## Composição & Seções Obrigatórias
1. **Navbar Flutuante em Pílula:** centralizada ou fixa no topo, fundo claro translúcido sólido com borda fina `--border`, logo minimalista, 4 links de âncora e CTA pílula escuro (`--invert-bg`).
2. **Hero Editorial com Slot `Imagem 1`:** manchete híbrida Sans + *Serif itálico*, subtítulo enxuto, CTA principal (Formulário/Agendar) + botão secundário **WhatsApp**, e quadro visual amplo (`aspect-ratio: 16/9`, `border-radius: 28px`) com `data-image-slot="1"` + 2 widgets flutuantes discretos de dados/métricas (ex.: gráfico donut SVG + taxa de satisfação).
3. **Passos Interativos `01 / 02 / 03`:** coluna esquerda com 3 etapas clicáveis (item ativo com fundo invertido `--invert-bg` e texto branco); coluna direita exibe um painel de métricas/gráfico SVG ou card visual (`data-image-slot="2"`) que muda dinamicamente ao clicar em cada etapa.
4. **Bento Grid Assimétrico:** 3–4 cards misturando 1 card claro grande, 1 card escuro invertido (`--invert-bg`) e 1 card horizontal largo com `data-image-slot="3"` e CTA interno.
5. **Prova Social & Depoimentos:** citações curtas com cargo/bairro, estrelas SVG limpas e selos numéricos animados ao entrar no viewport.
6. **FAQ Acordeão + Bloco Duplo de Conversão (Formulário de Leads + WhatsApp) + Footer limpo.**
