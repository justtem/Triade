# Bold Conversion — Vendas Diretas, Fintech & Captura de Leads

- **ID:** `bold-conversion`
- **Tema:** `light`
- **Vibe:** Alto contraste gráfico, energia moderna e foco cirúrgico em conversão (inspiração ProFinance + Lime Cards).
- **Tags:** vendas, saas, fintech, leads, infoproduto, marketing, limao, vibrante, conversao, claro

## Paleta & Tokens (:root)
```css
:root {
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-alt: #eef0f4;
  --ink: #0b0b0d;
  --ink-muted: #555863;
  --accent: #d6ff3f;
  --accent-ink: #0b0b0d;
  --invert-bg: #0b0b0d;
  --invert-ink: #ffffff;
  --border: #e2e4ea;
  --radius-hero: 32px;
  --radius-card: 24px;
  --radius-pill: 999px;
}
```

## Tipografia & Hierarquia
- **Títulos Display:** Sans-serif bold de alto impacto (`'Inter', 'Segoe UI', system-ui, sans-serif; font-weight: 800; letter-spacing: -0.04em; line-height: 1.02;`).
- Números KPI grandes com `font-variant-numeric: tabular-nums` e labels curtos em caixa baixa limpa.

## Composição & Seções Obrigatórias
1. **Navbar Clean:** logo com ícone em badge `--accent`, 4 links centrais e botão preto pílula (`--invert-bg`) de ação direta.
2. **Hero em Bloco Arredondado `--accent`:** container com `border-radius: 32px`, coluna esquerda com headline de impacto + 2 linhas de benefício + CTA preto pílula + botão **WhatsApp** + seta curva desenhada à mão (SVG inline) apontando para a coluna direita, que traz um mockup visual / frame interativo com `data-image-slot="1"`.
3. **2 Cards Grandes de Proposta de Valor:** lado a lado em `--surface`, cantos `24px`, mini-ilustração geométrica SVG ou gráfico de progresso no canto inferior direito e link `Saiba mais →`.
4. **Grid 2×2 de Vantagens com Ícones em Círculo `--accent`:** título à esquerda (sticky no desktop) + 4 diferenciais concretos à direita.
5. **Faixa de Parceiros / Prova Social + Banner Escuro de Alto Contraste (`--invert-bg`):** banner arredondado preto cortando a página clara com frase forte, CTA branco/limão e `data-image-slot="2"` (ou mockup de resultado).
6. **Planos / Ofertas com Toggle (ex.: Mensal / Anual ou Opções) + `data-image-slot="3"` + FAQ Acordeão + Captura de Leads (Formulário + WhatsApp) + Footer Preto (`--invert-bg`) com barra de newsletter/lead.**
